import json
import hmac
import logging
import math
import os
import secrets
import uuid
from functools import lru_cache
from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse
import httpx
from pydantic import BaseModel, Field, StrictBool

from app.assistant import ai_status, answer_assistant
from app.email_submission import sender_configuration, send_complaint_email
from app.aws_storage import (atomic_status_update, atomic_support_vote,
                             configured as aws_storage_configured)
from app.image_security import normalize_uploaded_image
from app.services import (MATERIAL_CATEGORIES, MASS_CLASSES, analyze_image, authority_directory,
                          classify_waste_image, community_impact, complaint_draft, impact_for,
                          pilot_config, recovery_directory, recovery_route_for,
                          within_pilot_extent)
from app.community import list_comments, save_comment, remove_comment
from app.storage import (ROOT, connect, delete_photo, hash_token, public_photo_url,
                         read_photo, report_dict, store_photo, claim_complaint_submission,
                         finish_complaint_submission, complete_photo_upload)

router = APIRouter()
ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
STATUSES = {"community_reported", "reviewed", "cleanup_confirmed"}
logger = logging.getLogger(__name__)
DEFINITE_SES_REJECTIONS = {
    "AccessDenied", "AccessDeniedException", "AccountSendingPaused",
    "AccountSuspended", "ConfigurationSetDoesNotExist", "ConfigurationSetSendingPaused",
    "InvalidParameterValue", "MailFromDomainNotVerified", "MessageRejected",
    "Throttling", "ThrottlingException", "TooManyRequestsException",
}


class ComplaintRequest(BaseModel):
    draft: str | None = Field(default=None, max_length=10000)


class ComplaintSubmitRequest(BaseModel):
    draft: str = Field(max_length=10000)
    confirmed: StrictBool = False
    jurisdiction_confirmed: StrictBool = False


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
    report_id: uuid.UUID | None = None
    photo_public: StrictBool = False


class SupportResponse(BaseModel):
    supported: bool
    supports: int


class NearbyBinsRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_meters: int = Field(default=1500, ge=100, le=3000)


OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_USER_AGENT = "WasteLens/0.1 (Lucknow civic pilot; open source)"


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
                 upload_state="ready", photo_public=False):
    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as db:
        db.execute("INSERT INTO reports (id,image_path,latitude,longitude,address,owner_token_hash,upload_state,created_at,photo_public) "
                   "VALUES (?,?,?,?,?,?,?,?,?)", (report_id, image_reference, latitude, longitude,
                                                  address[:300], hash_token(owner_secret), upload_state,
                                                  created_at, int(photo_public)))


def _check_location(latitude, longitude):
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise HTTPException(422, "A valid latitude and longitude are required")
    if not within_pilot_extent(latitude, longitude):
        raise HTTPException(422, "This location is outside the supported Lucknow pilot area. Your coordinates were not changed. Choose a waste site within the pilot and confirm its municipal ward before filing.")


def _distance_meters(lat1, lon1, lat2, lon2):
    """Great-circle distance for nearby map features, rounded for display."""
    earth_radius = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    value = (math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2)
             * math.sin(delta_lambda / 2) ** 2)
    value = min(1.0, max(0.0, value))
    return round(earth_radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value)))


def _bin_label(tags):
    amenity = tags.get("amenity")
    if amenity == "waste_basket":
        return "Public litter bin"
    return "Recycling container"


def _bin_materials(tags):
    if tags.get("waste"):
        return tags["waste"].replace(";", ", ")
    materials = sorted(key.removeprefix("recycling:") for key, value in tags.items()
                       if key.startswith("recycling:") and value == "yes")
    return ", ".join(materials) if materials else "Not specified on the map"


def _nearby_bin_query(latitude, longitude, radius_meters):
    return (f"[out:json][timeout:18][maxsize:5000000];("
            f'nwr["amenity"="waste_basket"]'
            f"(around:{radius_meters},{latitude},{longitude});"
            f'nwr["amenity"="recycling"]["recycling_type"="container"]'
            f"(around:{radius_meters},{latitude},{longitude}););out center tags 80;")


def _fetch_nearby_bins(latitude, longitude, radius_meters):
    """Make a single bounded Overpass request; user coordinates are never stored."""
    query = _nearby_bin_query(latitude, longitude, radius_meters)
    try:
        response = httpx.post(OVERPASS_URL, data={"data": query},
                              headers={"User-Agent": OVERPASS_USER_AGENT}, timeout=22)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
            raise ValueError("Overpass returned an unexpected response")
        elements = payload["elements"]
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.info("Nearby map lookup unavailable (%s)", type(exc).__name__)
        raise HTTPException(503, "Nearby map data is temporarily unavailable. Try again later.") from exc

    results = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        tags = element.get("tags") or {}
        if not isinstance(tags, dict):
            continue
        if tags.get("amenity") not in {"waste_basket", "recycling"}:
            continue
        if tags.get("amenity") == "recycling" and tags.get("recycling_type") != "container":
            continue
        if (tags.get("access") or "").casefold() in {"no", "private", "customers", "permit"}:
            continue
        point = element if "lat" in element else element.get("center") or {}
        if not isinstance(point, dict) or "lat" not in point or "lon" not in point:
            continue
        try:
            lat, lon = float(point["lat"]), float(point["lon"])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
            continue
        distance = _distance_meters(latitude, longitude, lat, lon)
        if distance > radius_meters:
            continue
        osm_type = element.get("type", "node")
        osm_id = element.get("id")
        if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int):
            continue
        results.append({
            "id": f"{osm_type}/{osm_id}",
            "kind": _bin_label(tags),
            "name": (tags.get("name") or "").strip()[:120] or None,
            "latitude": lat,
            "longitude": lon,
            "distance_meters": distance,
            "mapped_materials": _bin_materials(tags),
            "access": tags.get("access") or "Not specified on the map",
            "map_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
        })
    results.sort(key=lambda item: item["distance_meters"])
    return results[:30]


def decorate_report(row, private=False):
    report = report_dict(row, private=private)
    if report.get("photo_public") and report.get("upload_state") == "ready":
        report["image_path"] = f"/api/reports/{report['id']}/photo"
    elif private:
        report["image_path"] = ((public_photo_url(report["id"], report["image_path"])
                                  if aws_storage_configured() else
                                  f"/api/reports/{report['id']}/photo")
                                 if report.get("upload_state") == "ready" else "")
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


def _lucknow_email_contact():
    for entry in authority_directory():
        if entry.get("verified") is not True or entry.get("city", "").casefold() != "lucknow":
            continue
        for channel in entry.get("channels", []):
            if channel.get("type") == "email" and channel.get("value"):
                return entry, channel["value"].strip()
    return None, None


def _submission_unlocked(report):
    if report.get("submission_state", "not_sent") not in {"not_sent", "delivery_failed"}:
        raise HTTPException(409, "This complaint has already been sent or has an uncertain delivery result")


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


def _creation_identity(requested_id, token, latitude, longitude, address):
    """A client-owned ID makes a lost creation response safely recoverable."""
    if requested_id is None:
        return str(uuid.uuid4()), secrets.token_urlsafe(32), None
    report_id = str(requested_id)
    if not token or len(token) < 32 or len(token) > 128:
        raise HTTPException(422, "A private creation token is required with a report ID")
    with connect() as db:
        row = db.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
    if row is not None:
        require_report_owner(report_id, token)
        if (row["latitude"] != latitude or row["longitude"] != longitude or row["address"] != address[:300]):
            raise HTTPException(409, "This report ID already belongs to a different submission. Open the saved report.")
        return report_id, token, get_report(report_id)
    return report_id, token, None


@router.post("/reports", status_code=201)
async def create_report(photo: UploadFile = File(...), latitude: float = Form(...),
                        longitude: float = Form(...), address: str = Form(""),
                        report_id: uuid.UUID | None = Form(None),
                        photo_public: bool = Form(False),
                        x_report_token: str | None = Header(None, alias="X-Report-Token")):
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
    report_id, owner_secret, existing = _creation_identity(report_id, x_report_token, latitude, longitude, address)
    if existing is not None:
        return {**existing, "owner_token": owner_secret}
    image_reference = store_photo(str(uuid.uuid4()), normalized)
    try:
        _save_report(report_id, image_reference, latitude, longitude, address, owner_secret, photo_public=photo_public)
    except Exception:
        # A write may have committed before its acknowledgment was lost. Check
        # persistence before cleanup so the winning report's photo survives.
        _, _, winner = _creation_identity(uuid.UUID(report_id), owner_secret, latitude, longitude, address)
        if winner is not None:
            with connect() as db:
                reference = db.execute("SELECT image_path FROM reports WHERE id=?", (report_id,)).fetchone()["image_path"]
            if reference != image_reference:
                delete_photo(image_reference)
            return {**winner, "owner_token": owner_secret}
        delete_photo(image_reference)
        raise
    return {**get_report(report_id), "owner_token": owner_secret}


@router.post("/waste/guide")
async def guide_waste(response: Response, photo: UploadFile = File(...)):
    """Suggest a waste category and local handling advice without saving the photo."""
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
    result = classify_waste_image(normalized)
    response.headers["Cache-Control"] = "no-store"
    return {**result,
            "photo_storage": "not_saved_by_wastelens",
            "review_note": "Visual suggestions can be wrong, especially for mixed waste. Check the item yourself; local intake is not confirmed by this guide."}


@router.post("/nearby-bins")
def nearby_bins(request: NearbyBinsRequest, response: Response):
    """Find mapped nearby bins in the Lucknow pilot without retaining coordinates."""
    _check_location(request.latitude, request.longitude)
    results = _fetch_nearby_bins(request.latitude, request.longitude, request.radius_meters)
    response.headers["Cache-Control"] = "no-store"
    return {
        "source": "OpenStreetMap contributors via Overpass API",
        "queried_at": datetime.now(timezone.utc).isoformat(),
        "radius_meters": request.radius_meters,
        "results": results,
        "note": "Map features are community mapped and may be incomplete, outdated, inaccessible, or incorrectly tagged. Confirm the bin and accepted waste on site. This lookup is not stored by WasteLens.",
    }


@router.post("/reports/upload-url", status_code=201)
def create_report_upload_url(request: CreateUploadRequest,
                             x_report_token: str | None = Header(None, alias="X-Report-Token")):
    """Create a private pending report and short-lived S3 upload URL."""
    if not aws_storage_configured():
        raise HTTPException(404, "Direct uploads are available only when S3 pilot storage is configured")
    _check_location(request.latitude, request.longitude)
    from app.aws_storage import pending_photo_key
    report_id, owner_secret, existing = _creation_identity(request.report_id, x_report_token,
                                                          request.latitude, request.longitude, request.address)
    if existing is not None:
        return {"report": existing, "owner_token": owner_secret,
                "upload_url": _prepare_photo_upload_url(report_id) if existing["upload_state"] == "pending" else "",
                "upload_content_type": "image/jpeg", "expires_in_seconds": 300}
    image_reference = pending_photo_key(report_id)
    upload_url = _prepare_photo_upload_url(report_id)
    try:
        _save_report(report_id, image_reference, request.latitude, request.longitude,
                     request.address, owner_secret, upload_state="pending", photo_public=request.photo_public)
    except Exception:
        _, _, winner = _creation_identity(uuid.UUID(report_id), owner_secret,
                                            request.latitude, request.longitude, request.address)
        if winner is None:
            raise
        return {"report": winner, "owner_token": owner_secret, "upload_url": upload_url,
                "upload_content_type": "image/jpeg", "expires_in_seconds": 300}
    return {"report": get_report(report_id), "owner_token": owner_secret,
            "upload_url": upload_url,
            "upload_content_type": "image/jpeg", "expires_in_seconds": 300}


def _prepare_photo_upload_url(report_id):
    from app.aws_storage import create_photo_upload_url
    try:
        return create_photo_upload_url(report_id)
    except Exception as exc:
        logger.warning("Photo upload link unavailable (%s)", type(exc).__name__)
        raise HTTPException(503, "Could not prepare the cloud upload link. Try again shortly.") from exc


@router.post("/reports/{report_id}/upload-url")
def renew_report_upload_url(report_id: str,
                            x_report_token: str | None = Header(None, alias="X-Report-Token")):
    """Renew a failed/expired PUT for the same owner-authorized pending report."""
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    if report.get("upload_state") == "ready":
        return {"report": report}
    if report.get("upload_state") != "pending":
        raise HTTPException(409, "The report is not awaiting a photo upload")
    if not aws_storage_configured():
        raise HTTPException(503, "Cloud photo storage is unavailable")
    return {"report": report, "upload_url": _prepare_photo_upload_url(report_id),
            "upload_content_type": "image/jpeg", "expires_in_seconds": 300}


def _cleanup_pending_upload(report_id):
    """Cleanup is best effort, after publication, and can never target the final photo."""
    from app.aws_storage import pending_photo_key
    try:
        delete_photo(pending_photo_key(report_id))
    except Exception as exc:
        logger.warning("Pending photo cleanup will need retry (%s)", type(exc).__name__)


@router.post("/reports/{report_id}/confirm-upload")
def confirm_report_upload(report_id: str,
                          x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    if report.get("upload_state") == "ready":
        if aws_storage_configured():
            _cleanup_pending_upload(report_id)
        return report
    if report.get("upload_state") != "pending":
        raise HTTPException(409, "The report is not awaiting a photo upload")
    if not aws_storage_configured():
        raise HTTPException(503, "Cloud photo storage is unavailable")
    from app.aws_storage import pending_photo_key, uploaded_photo, store_confirmed_photo
    # Legacy pending records may have recorded the final key. The signer has always
    # used this quarantine key; normal reads still require stored_photo_reference().
    pending_reference = pending_photo_key(report_id)
    try:
        contents = uploaded_photo(pending_reference)
    except FileNotFoundError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        status = 413 if "8 MB" in str(exc) else 415
        raise HTTPException(status, str(exc)) from exc
    except Exception as exc:
        logger.warning("Pending photo read failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Your upload is still pending. Private storage could not be read; retry confirmation.") from exc
    try:
        normalized = normalize_uploaded_image(contents, "image/jpeg")
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(415, str(exc)) from exc
    try:
        final_reference = store_confirmed_photo(report_id, normalized)
        if final_reference != f"reports/{report_id}.jpg":
            raise RuntimeError("Photo storage returned an unexpected final reference")
        published = complete_photo_upload(report_id, final_reference)
    except Exception as exc:
        logger.warning("Photo publication could not be confirmed (%s)", type(exc).__name__)
        raise HTTPException(503, "Your upload is retained. Photo verification could not be completed; retry confirmation for this report.") from exc
    if not published and stored_photo_reference(report_id) != final_reference:
        raise HTTPException(409, "The photo state changed. Retry confirmation for this report.")
    _cleanup_pending_upload(report_id)
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
    with connect() as db:
        row = db.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Report not found")
    if not bool(dict(row).get("photo_public", False)):
        require_report_owner(report_id, x_report_token)
    contents = read_photo(stored_photo_reference(report_id))
    media_type = "image/jpeg" if contents.startswith(b"\xff\xd8\xff") else "application/octet-stream"
    if media_type == "application/octet-stream":
        raise HTTPException(415, "Stored image format is unsupported")
    return Response(contents, media_type=media_type,
                    headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})



class PhotoSharingRequest(BaseModel):
    photo_public: StrictBool


class CommentRequest(BaseModel):
    id: uuid.UUID
    author: str = Field(default="Neighbor", min_length=1, max_length=40)
    body: str = Field(min_length=1, max_length=1200)


@router.patch("/reports/{report_id}/photo-sharing")
def share_report_photo(report_id: str, request: PhotoSharingRequest,
                       x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    stored_photo_reference(report_id)
    with connect() as db:
        db.execute("UPDATE reports SET photo_public=? WHERE id=?", (int(request.photo_public), report_id))
    return {"report": get_report(report_id)}


def _community_report(report_id):
    report = get_report(report_id)
    if report["upload_state"] != "ready":
        raise HTTPException(404, "Community report not found")
    return report


@router.get("/reports/{report_id}/comments")
def report_comments(report_id: str, x_client_token: str | None = Header(None, alias="X-Client-Token")):
    _community_report(report_id)
    return {"comments": list_comments(report_id, x_client_token)}


@router.post("/reports/{report_id}/comments", status_code=201)
def post_report_comment(report_id: str, request: CommentRequest,
                        x_client_token: str | None = Header(None, alias="X-Client-Token")):
    _community_report(report_id)
    if not x_client_token or not 16 <= len(x_client_token) <= 128:
        raise HTTPException(401, "A browser participation token is required")
    author, body = request.author.strip(), request.body.strip()
    if not author or not body:
        raise HTTPException(422, "Write a name and a discussion message before posting")
    comment = save_comment(report_id, str(request.id), author, body, x_client_token)
    return {"comment": comment}


@router.delete("/reports/{report_id}/comments/{comment_id}")
def delete_report_comment(report_id: str, comment_id: uuid.UUID,
                          x_client_token: str | None = Header(None, alias="X-Client-Token"),
                          x_report_token: str | None = Header(None, alias="X-Report-Token")):
    _community_report(report_id)
    moderator = False
    if x_report_token:
        require_report_owner(report_id, x_report_token)
        moderator = True
    remove_comment(report_id, str(comment_id), x_client_token, moderator)
    return {"removed": True}


@router.get("/reports/{report_id}/solutions")
def report_solutions(report_id: str):
    report = _community_report(report_id)
    route = recovery_route_for(report.get("material_category", ""))
    return {"source": "local_guide", "ai_used": False,
            "steps": ["Confirm the waste category together; visual suggestions need review.",
                      "Support this report rather than filing duplicate complaints.",
                      "Use the discussion to propose a time, supplies and a coordinator; these are proposals until agreed.",
                      "Keep children away from waste. Do not handle sharps, chemicals, batteries or unknown hazardous material; ask qualified services.",
                      "For public-site cleanup, confirm permission and collection with the responsible authority before organizing."],
            "recovery_route": route,
            "note": "Local coordination suggestions with sourced material guidance when available; not a verified cleanup arrangement or live AI-generated plan."}


@router.post("/reports/{report_id}/analyze")
def analyze_report(report_id: str, request: AnalysisRequest | None = None,
                   x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    report = get_report(report_id)
    photo_reference = stored_photo_reference(report_id)
    _submission_unlocked(report)
    if request and (request.categories is not None or request.severity is not None):
        categories = request.categories if request.categories is not None else report["categories"]
        severity = request.severity if request.severity is not None else report["severity"]
        if severity not in {"unassessed", "low", "medium", "high"}:
            raise HTTPException(422, "Severity must be unassessed, low, medium, or high")
        categories = list(dict.fromkeys(item.strip()[:80] for item in categories if item.strip()))
        result = {"analysis_available": False, "categories": categories,
                  "severity": severity,
                  "source": "resident_reviewed",
                  "note": "Resident-reviewed assessment; these labels and severity were entered by a community member."}
    else:
        result = analyze_image(read_photo(photo_reference))
        if not result["analysis_available"]:
            # Failed optional AI must not erase a resident's saved assessment.
            if not report["analysis_note"]:
                with connect() as db:
                    db.execute("UPDATE reports SET analysis_note=?, moderation_state=? WHERE id=?",
                               (result["note"], result.get("moderation_state", "check_unavailable"), report_id))
            return {**result, "report": get_report(report_id)}
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
    photo_reference = stored_photo_reference(report_id)
    _submission_unlocked(report)
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
        return {"analysis_available": True, "ai_used": False, "source": "resident_reviewed", "note": "Resident-reviewed estimate saved.",
                "classification": classification, "recovery_route": route,
                "mass_range_kg": {"min": mass_min, "max": mass_max, "estimate": True},
                "impact": impact, "report": get_report(report_id)}

    result = classify_waste_image(read_photo(photo_reference))
    if not result["analysis_available"]:
        result["report"] = report
        return result
    classification = result["classification"]
    category = classification["material_category"]
    mass_class = classification["mass_class"]
    mass_min, mass_max = MASS_CLASSES.get(mass_class, (None, None))
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
    _submission_unlocked(report)
    draft = (request.draft if request and request.draft is not None else complaint_draft(report))
    if not draft.strip():
        raise HTTPException(422, "Complaint draft cannot be empty")
    with connect() as db:
        db.execute("UPDATE reports SET complaint=? WHERE id=?", (draft.strip(), report_id))
    return {"draft": draft.strip(), "sent": False, "report": get_report(report_id)}


@router.get("/submission/status")
def complaint_submission_status():
    authority, recipient = _lucknow_email_contact()
    sender = sender_configuration()
    return {
        "available": bool(authority and recipient and sender["configured"]),
        "provider": "Amazon SES",
        "recipient": recipient or "",
        "recipient_label": "Lucknow Nagar Nigam published public contact email",
        "sender_configured": sender["configured"],
        "sender": sender["sender"],
        "source_url": authority.get("source_url", "") if authority else "",
        "delivery_note": ("SES acceptance confirms the email request was accepted for delivery; it does not confirm "
                          "LNN received it, acknowledged it, or created a municipal ticket."),
    }


@router.post("/reports/{report_id}/submit")
def submit_complaint(report_id: str, request: ComplaintSubmitRequest,
                     x_report_token: str | None = Header(None, alias="X-Report-Token")):
    require_report_owner(report_id, x_report_token)
    if not request.confirmed:
        raise HTTPException(400, "Explicit approval to send the email is required")
    if not request.jurisdiction_confirmed:
        raise HTTPException(400, "Confirm that the reported location and Lucknow jurisdiction are correct")
    approved_draft = request.draft.strip()
    if not approved_draft:
        raise HTTPException(422, "Complaint draft cannot be empty")

    report = get_report(report_id)
    _submission_unlocked(report)
    if report.get("upload_state") != "ready":
        raise HTTPException(409, "The report photo upload is not complete")
    if not within_pilot_extent(report["latitude"], report["longitude"]):
        raise HTTPException(422, "This report is outside the approximate Lucknow pilot extent")

    authority, recipient = _lucknow_email_contact()
    sender = sender_configuration()
    if not authority or not recipient:
        raise HTTPException(503, "No verified public email contact is configured for the Lucknow pilot")
    if not sender["configured"]:
        raise HTTPException(503, "Email sending is not configured in this deployment. No email was sent.")

    attempt_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()
    if not claim_complaint_submission(report_id, attempt_id, started_at, recipient, approved_draft):
        raise HTTPException(409, "This complaint has already been submitted or is being processed")

    try:
        message_id = send_complaint_email(sender=sender["sender"], recipient=recipient,
                                          report=report, approved_draft=approved_draft)
    except Exception as exc:
        # Explicit SES rejection codes confirm the message was not accepted. Network,
        # unexpected and internal service errors may follow acceptance, so lock them.
        from botocore.exceptions import ClientError
        error_code = exc.response.get("Error", {}).get("Code", "") if isinstance(exc, ClientError) else ""
        if error_code in DEFINITE_SES_REJECTIONS:
            try:
                finish_complaint_submission(report_id, attempt_id, "delivery_failed")
            except Exception:
                logger.error("Could not persist known SES rejection (%s)", type(exc).__name__)
            return JSONResponse(status_code=502, content={
                "detail": "Amazon SES rejected the email; no message was accepted. Correct the SES configuration before trying again.",
                "submission_state": "delivery_failed",
            })
        try:
            finish_complaint_submission(report_id, attempt_id, "delivery_unknown")
        except Exception as persist_exc:
            logger.error("Could not persist uncertain email outcome (%s)", type(persist_exc).__name__)
        logger.error("Email delivery outcome is uncertain (%s)", type(exc).__name__)
        return JSONResponse(status_code=502, content={
            "detail": "Email delivery could not be confirmed. Do not resend from WasteLens; follow up through the official contact channel.",
            "submission_state": "delivery_unknown",
        })

    sent_at = datetime.now(timezone.utc).isoformat()
    try:
        recorded = finish_complaint_submission(report_id, attempt_id, "email_accepted",
                                               sent_at=sent_at, message_id=message_id)
    except Exception as exc:
        logger.error("SES accepted email but result could not be persisted (%s)", type(exc).__name__)
        recorded = False
    if not recorded:
        # Leave the durable claim locked; another click must never duplicate this email.
        return JSONResponse(status_code=202, content={
            "submission_state": "sending",
            "detail": "Amazon SES accepted the email, but WasteLens could not save the delivery status. Refresh this report before taking further action.",
        })

    return {
        "submission_state": "email_accepted",
        "recipient": recipient,
        "sent_at": sent_at,
        "delivery_note": "Amazon SES accepted the email for delivery. LNN receipt, acknowledgment, and ticket creation are not guaranteed.",
        "report": get_report(report_id),
    }


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


class CommunityRequest(BaseModel):
    id: uuid.UUID
    name: str = Field(min_length=2, max_length=80)
    area: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=5, max_length=600)
    creator: str = Field(default="Neighbor", min_length=1, max_length=40)


@router.get("/communities")
def community_directory():
    from app.groups import list_groups
    return {"communities": list_groups(), "city": "Lucknow", "limit": 50}


@router.post("/communities", status_code=201)
def create_community(request: CommunityRequest,
                     x_client_token: str | None = Header(None, alias="X-Client-Token")):
    from app.groups import create_group
    if not x_client_token or not 16 <= len(x_client_token) <= 128:
        raise HTTPException(401, "A browser participation token is required")
    values = [request.name.strip(), request.area.strip(), request.description.strip(), request.creator.strip()]
    if len(values[0]) < 2 or len(values[1]) < 2 or len(values[2]) < 5 or not values[3]:
        raise HTTPException(422, "Add a community name, locality, purpose and alias")
    return {"community": create_group(str(request.id), *values, x_client_token)}
