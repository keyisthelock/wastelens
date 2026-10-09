import json
import hmac
import os
import secrets
import uuid
from functools import lru_cache
from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from app.assistant import ai_status, answer_assistant
from app.aws_storage import (atomic_status_update, atomic_support_vote,
                             configured as aws_storage_configured)
from app.image_security import normalize_uploaded_image
from app.services import (MATERIAL_CATEGORIES, MASS_CLASSES, analyze_image, authority_directory,
                          classify_waste_image, community_impact, complaint_draft, impact_for,
                          pilot_config, recovery_directory, recovery_route_for,
                          within_pilot_extent)
from app.storage import (ROOT, connect, delete_photo, hash_token, public_photo_url,
                         read_photo, report_dict, store_photo)

router = APIRouter()
ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
STATUSES = {"community_reported", "reviewed", "cleanup_confirmed"}


class ComplaintRequest(BaseModel):
    draft: str | None = Field(default=None, max_length=10000)


class AnalysisRequest(BaseModel):
    categories: list[str] | None = Field(default=None, max_length=12)
    severity: str | None = None


class ClassifyRequest(BaseModel):
    material_category_override: str | None = None
    mass_class_override: str | None = None


class StatusRequest(BaseModel):
    status: str


class AssistantRequest(BaseModel):
    message: str = Field(min_length=2, max_length=1000)
    report_id: str | None = None


class CreateUploadRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    address: str = Field(default="", max_length=300)


class SupportResponse(BaseModel):
    supported: bool
    supports: int


def get_report(report_id):
    with connect() as db:
        row = db.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Report not found")
    return decorate_report(row, private=True)


def stored_photo_reference(report_id):
    """Return the private storage key, never a client-facing URL."""
    with connect() as db:
        row = db.execute("SELECT image_path, upload_state FROM reports WHERE id=?", (report_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Report not found")
    if row["upload_state"] != "ready":
        raise HTTPException(409, "The photo upload is not complete")
    return row["image_path"]


def _save_report(report_id, image_reference, latitude, longitude, address, owner_secret,
                 upload_state="ready"):
    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as db:
        db.execute("INSERT INTO reports (id,image_path,latitude,longitude,address,owner_token_hash,upload_state,created_at) "
                   "VALUES (?,?,?,?,?,?,?,?)", (report_id, image_reference, latitude, longitude,
                                                  address[:300], hash_token(owner_secret), upload_state,
                                                  created_at))


def _check_location(latitude, longitude):
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise HTTPException(422, "A valid latitude and longitude are required")
    if not within_pilot_extent(latitude, longitude):
        raise HTTPException(422, "This pilot accepts only approximate Lucknow locations. Confirm the location and municipal ward before filing.")


def decorate_report(row, private=False):
    report = report_dict(row, private=private)
    if private:
        report["image_path"] = (public_photo_url(report["id"], report["image_path"])
                                 if aws_storage_configured() else
                                 f"/api/reports/{report['id']}/photo")
    report["impact"] = impact_for(report.get("material_category", ""), report.get("mass_min_kg"),
                                  report.get("mass_max_kg"))
    report["recovery_route"] = recovery_route_for(report.get("material_category", ""))
    return report


def require_report_owner(report_id: str, token: str | None):
    if not token:
        raise HTTPException(401, "Report owner token is required")
    with connect() as db:
        row = db.execute("SELECT owner_token_hash FROM reports WHERE id=?", (report_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Report not found")
    saved_hash = row["owner_token_hash"] or ""
    if not saved_hash or not hmac.compare_digest(saved_hash, hash_token(token)):
        raise HTTPException(403, "This action requires the report owner token")


@lru_cache(maxsize=4)
def _read_admin_secret(secret_arn: str):
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    response = boto3.client("secretsmanager", region_name=region).get_secret_value(SecretId=secret_arn)
    return response.get("SecretString", "")


def admin_token():
    secret_arn = os.getenv("WASTELENS_ADMIN_TOKEN_SECRET_ARN")
    if secret_arn:
        return _read_admin_secret(secret_arn)
    return os.getenv("WASTELENS_ADMIN_TOKEN", "")


@router.post("/reports", status_code=201)
async def create_report(photo: UploadFile = File(...), latitude: float = Form(...),
                        longitude: float = Form(...), address: str = Form("")):
    _check_location(latitude, longitude)
    if photo.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(415, "Upload a JPEG, PNG, or WebP image")
    contents = await photo.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image must be 8 MB or smaller")
    if not contents:
        raise HTTPException(422, "Image is empty")
    try:
        normalized = normalize_uploaded_image(contents, photo.content_type or "")
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(415, str(exc)) from exc
    report_id = str(uuid.uuid4())
    owner_secret = secrets.token_urlsafe(32)
    image_reference = store_photo(report_id, normalized)
    try:
        _save_report(report_id, image_reference, latitude, longitude, address, owner_secret)
    except Exception:
        delete_photo(image_reference)
        raise
    return {**get_report(report_id), "owner_token": owner_secret}


@router.post("/reports/upload-url", status_code=201)
def create_report_upload_url(request: CreateUploadRequest):
    """Create a private pending report and short-lived S3 upload URL."""
    if not aws_storage_configured():
        raise HTTPException(404, "Direct uploads are available only when S3 pilot storage is configured")
    _check_location(request.latitude, request.longitude)
    report_id = str(uuid.uuid4())
    owner_secret = secrets.token_urlsafe(32)
    image_reference = f"reports/{report_id}.jpg"
    _save_report(report_id, image_reference, request.latitude, request.longitude,
                 request.address, owner_secret, upload_state="pending")
    from app.aws_storage import create_photo_upload_url
    return {"report": get_report(report_id), "owner_token": owner_secret,
            "upload_url": create_photo_upload_url(report_id),
            "upload_content_type": "image/jpeg", "expires_in_seconds": 300}


@router.post("/reports/{report_id}/confirm-upload")
def confirm_report_upload(report_id: str,
                          x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    if report.get("upload_state") == "ready":
        return report
    if not aws_storage_configured():
        raise HTTPException(503, "Cloud photo storage is unavailable")
    from app.aws_storage import uploaded_photo
    try:
        pending_reference = stored_photo_reference(report_id)
        contents = uploaded_photo(pending_reference)
        normalized = normalize_uploaded_image(contents, "image/jpeg")
    except FileNotFoundError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        status = 413 if "8 MB" in str(exc) else 415
        raise HTTPException(status, str(exc)) from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(415, str(exc)) from exc
    store_photo(report_id, normalized)
    with connect() as db:
        db.execute("UPDATE reports SET image_path=?, upload_state=? WHERE id=?",
                   (f"reports/{report_id}.jpg", "ready", report_id))
    delete_photo(pending_reference)
    return get_report(report_id)


@router.get("/reports")
def list_reports(status: str | None = None, limit: int = 50):
    if status and status not in STATUSES:
        raise HTTPException(422, "Unknown status")
    limit = max(1, min(limit, 100))
    with connect() as db:
        if status:
            rows = db.execute("SELECT * FROM reports WHERE status=? AND upload_state='ready' ORDER BY created_at DESC LIMIT ?",
                              (status, limit)).fetchall()
        else:
            rows = db.execute("SELECT * FROM reports WHERE upload_state='ready' ORDER BY created_at DESC LIMIT ?",
                              (limit,)).fetchall()
    return [decorate_report(row) for row in rows]


@router.get("/reports/{report_id}")
def read_report(report_id: str, x_report_token: str | None = Header(None, alias="X-Report-Token")):
    with connect() as db:
        row = db.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Report not found")
    private = bool(x_report_token and row["owner_token_hash"]
                   and hmac.compare_digest(row["owner_token_hash"], hash_token(x_report_token)))
    if row["upload_state"] != "ready" and not private:
        raise HTTPException(404, "Report not found")
    return decorate_report(row, private=private)


@router.get("/reports/{report_id}/photo")
def read_private_photo(report_id: str,
                       x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    contents = read_photo(stored_photo_reference(report_id))
    media_type = "image/jpeg" if contents.startswith(b"\xff\xd8\xff") else "application/octet-stream"
    if media_type == "application/octet-stream":
        raise HTTPException(415, "Stored image format is unsupported")
    return Response(contents, media_type=media_type,
                    headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/reports/{report_id}/analyze")
def analyze_report(report_id: str, request: AnalysisRequest | None = None,
                   x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    if request and (request.categories is not None or request.severity is not None):
        categories = request.categories if request.categories is not None else report["categories"]
        severity = request.severity if request.severity is not None else report["severity"]
        if severity not in {"unassessed", "low", "medium", "high"}:
            raise HTTPException(422, "Severity must be unassessed, low, medium, or high")
        categories = list(dict.fromkeys(item.strip()[:80] for item in categories if item.strip()))
        result = {"analysis_available": False, "categories": categories,
                  "severity": severity,
                  "note": "Resident-reviewed assessment; these labels and severity were entered by a community member."}
    else:
        result = analyze_image(read_photo(stored_photo_reference(report_id)))
    with connect() as db:
        db.execute("UPDATE reports SET categories=?, severity=?, analysis_note=?, moderation_state=? WHERE id=?",
                   (json.dumps(result["categories"]), result["severity"], result["note"],
                    result.get("moderation_state", "not_checked"), report_id))
    return {**result, "report": get_report(report_id)}


@router.post("/reports/{report_id}/classify")
def classify_report(report_id: str, request: ClassifyRequest | None = None,
                    x_report_token: str | None = Header(None, alias="X-Report-Token")):
    """Classify the report photo with Bedrock, or save explicit resident corrections."""
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    if request and (request.material_category_override or request.mass_class_override):
        category = request.material_category_override or report.get("material_category")
        mass_class = request.mass_class_override or report.get("mass_class")
        if category not in MATERIAL_CATEGORIES:
            raise HTTPException(422, "Choose one supported material category")
        if mass_class not in MASS_CLASSES:
            raise HTTPException(422, "Choose a rough mass class: small, medium, or large")
        mass_min, mass_max = MASS_CLASSES[mass_class]
        route = recovery_route_for(category)
        classification = {
            "material_category": category,
            "material_label": MATERIAL_CATEGORIES[category],
            "segregation_advice": "Resident-reviewed material selection. Follow the linked source-backed route and verify local intake before handoff.",
            "mass_class": mass_class,
            "visual_note": "Resident-reviewed estimate; not a measured weight.",
            "review_required": False,
            "source": "resident_reviewed",
            "estimate_label": "rough resident estimate",
        }
        impact = impact_for(category, mass_min, mass_max)
        with connect() as db:
            db.execute("UPDATE reports SET material_category=?, mass_class=?, mass_min_kg=?, mass_max_kg=?, "
                       "classification=?, categories=? WHERE id=?",
                       (category, mass_class, mass_min, mass_max, json.dumps(classification),
                        json.dumps([MATERIAL_CATEGORIES[category]]), report_id))
        return {"analysis_available": True, "ai_used": False, "note": "Resident-reviewed estimate saved.",
                "classification": classification, "recovery_route": route,
                "mass_range_kg": {"min": mass_min, "max": mass_max, "estimate": True},
                "impact": impact, "report": get_report(report_id)}

    result = classify_waste_image(read_photo(stored_photo_reference(report_id)))
    if not result["analysis_available"]:
        result["report"] = report
        return result
    classification = result["classification"]
    category = classification["material_category"]
    mass_class = classification["mass_class"]
    mass_min, mass_max = MASS_CLASSES[mass_class]
    with connect() as db:
        db.execute("UPDATE reports SET material_category=?, mass_class=?, mass_min_kg=?, mass_max_kg=?, "
                   "classification=?, categories=?, analysis_note=? WHERE id=?",
                   (category, mass_class, mass_min, mass_max, json.dumps(classification),
                    json.dumps([classification["material_label"]]), result["note"], report_id))
    result["report"] = get_report(report_id)
    return result


@router.post("/reports/{report_id}/complaint")
def save_complaint(report_id: str, request: ComplaintRequest | None = None,
                   x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    draft = (request.draft if request and request.draft is not None else complaint_draft(report))
    if not draft.strip():
        raise HTTPException(422, "Complaint draft cannot be empty")
    with connect() as db:
        db.execute("UPDATE reports SET complaint=? WHERE id=?", (draft.strip(), report_id))
    return {"draft": draft.strip(), "sent": False, "report": get_report(report_id)}


@router.post("/reports/{report_id}/support", response_model=SupportResponse)
def support_report(report_id: str, x_client_token: str = Header(..., min_length=8, max_length=80)):
    if aws_storage_configured():
        supported, count = atomic_support_vote(report_id, hash_token(x_client_token),
                                              datetime.now(timezone.utc).isoformat())
        if count is None:
            raise HTTPException(404, "Report not found")
        return {"supported": supported, "supports": count}
    with connect() as db:
        row = db.execute("SELECT supports FROM reports WHERE id=?", (report_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Report not found")
        db.execute("BEGIN IMMEDIATE")
        inserted = db.execute("INSERT OR IGNORE INTO supports(report_id,client_token_hash,created_at) "
                               "VALUES(?,?,?)", (report_id, hash_token(x_client_token),
                                                   datetime.now(timezone.utc).isoformat()))
        if inserted.rowcount:
            db.execute("UPDATE reports SET supports=supports+1 WHERE id=?", (report_id,))
        count = db.execute("SELECT supports FROM reports WHERE id=?", (report_id,)).fetchone()[0]
    return {"supported": bool(inserted.rowcount), "supports": count}


@router.patch("/reports/{report_id}/status")
def update_status(report_id: str, request: StatusRequest,
                  x_admin_token: str | None = Header(None, alias="X-Admin-Token")):
    if request.status not in STATUSES:
        raise HTTPException(422, "Status must be community_reported, reviewed, or cleanup_confirmed")
    expected = admin_token()
    if not expected:
        raise HTTPException(503, "Status updates are disabled because no admin credential is configured")
    if not x_admin_token or not secrets.compare_digest(expected, x_admin_token):
        raise HTTPException(401, "Valid admin token required for status updates")
    created_at = datetime.now(timezone.utc).isoformat()
    if aws_storage_configured():
        previous = atomic_status_update(report_id, request.status,
                                        hash_token(x_admin_token)[:16], created_at)
        if previous is None:
            raise HTTPException(404, "Report not found")
        if previous is False:
            raise HTTPException(409, "Report status changed; reload and retry")
        return get_report(report_id)
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = db.execute("SELECT status FROM reports WHERE id=?", (report_id,)).fetchone()
        if current is None:
            raise HTTPException(404, "Report not found")
        db.execute("UPDATE reports SET status=? WHERE id=?", (request.status, report_id))
        db.execute("INSERT INTO status_events(report_id,previous_status,status,actor_fingerprint,created_at) "
                   "VALUES(?,?,?,?,?)", (report_id, current["status"], request.status,
                                          hash_token(x_admin_token)[:16],
                                          created_at))
    return get_report(report_id)


@router.delete("/reports/{report_id}", status_code=204)
def delete_report(report_id: str, x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    with connect() as db:
        row = db.execute("SELECT image_path FROM reports WHERE id=?", (report_id,)).fetchone()
        db.execute("DELETE FROM reports WHERE id=?", (report_id,))
    delete_photo(row["image_path"])
    return None


@router.get("/authorities")
def list_authorities(latitude: float | None = None, longitude: float | None = None,
                     city: str | None = None):
    entries = authority_directory()
    pilot = pilot_config()
    if city and city.casefold() != "lucknow":
        return {"configured": False, "authorities": [],
                "match_basis": "no verified authority coverage for this city"}
    if (latitude is None) != (longitude is None):
        raise HTTPException(422, "Provide both latitude and longitude for the pilot extent check")
    if latitude is not None and not within_pilot_extent(latitude, longitude):
        return {"configured": False, "authorities": [],
                "match_basis": "outside the approximate Lucknow pilot bounding box",
                "boundary_source_url": pilot["boundary_source_url"],
                "scope_note": pilot["scope_note"]}
    if not city or city.casefold() == "lucknow":
        matches = [item for item in entries if item.get("verified") is True
                   and item.get("city", "").casefold() == "lucknow"]
        return {"configured": bool(matches), "authorities": matches,
                "match_basis": ("approximate Lucknow pilot bounding box; municipal ward not verified"
                                if latitude is not None else "Lucknow city-level directory; location not checked"),
                "boundary_source_url": pilot.get("boundary_source_url"),
                "scope_note": pilot.get("scope_note")}
    # The pilot city must be identified; coordinates alone are not a reliable city boundary.
    return {"configured": False, "authorities": [],
            "match_basis": "no verified authority coverage for this city"}


@router.get("/recovery-routes")
def list_recovery_routes():
    return recovery_directory()


@router.get("/impact")
def read_community_impact():
    with connect() as db:
        rows = db.execute("SELECT material_category,mass_min_kg,mass_max_kg FROM reports").fetchall()
    return community_impact(rows)


@router.get("/ai/status")
def assistant_status():
    return ai_status()


@router.get("/security/status")
def security_status():
    cloud = aws_storage_configured()
    profile = os.getenv("WASTELENS_CLOUD_SECURITY_PROFILE", "")
    return {
        "storage_mode": "AWS S3 + DynamoDB" if cloud else "Local SQLite + local photo storage",
        "cloud_storage_configured": cloud,
        "cloud_security_profile": "SAM template configured" if cloud and profile == "sam" else
                                  "Custom AWS setup; controls not verified" if cloud else
                                  "Not active in this local session",
        "public_location_precision": "rounded to 0.01 degrees",
        "public_report_fields": "address, complaint draft, exact coordinates, and photo path are private",
        "owner_access": "high-entropy report token; only its SHA-256 hash is stored",
        "cloud_controls": ["S3 Block Public Access", "server-side encryption", "HTTPS-only bucket policy",
                           "DynamoDB encryption and point-in-time recovery", "Secrets Manager operator token",
                           "API Gateway throttling"] if cloud and profile == "sam" else [],
        "deployment_audit": "The app does not remotely verify AWS account resource settings.",
    }


@router.post("/assistant")
def assistant_reply(request: AssistantRequest):
    if request.report_id:
        get_report(request.report_id)
    return answer_assistant(request.message, request.report_id)
