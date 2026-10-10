import json
import hashlib
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("WASTELENS_DB", ROOT / "data" / "wastelens.db"))


@contextmanager
def connect():
    from app.aws_storage import Connection as AwsConnection, configured as aws_configured
    if aws_configured():
        yield AwsConnection()
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize():
    from app.aws_storage import configured as aws_configured
    if aws_configured():
        return
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                image_path TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                address TEXT NOT NULL DEFAULT '',
                categories TEXT NOT NULL DEFAULT '[]',
                severity TEXT NOT NULL DEFAULT 'unassessed',
                analysis_note TEXT NOT NULL DEFAULT '',
                complaint TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'community_reported',
                supports INTEGER NOT NULL DEFAULT 0,
                support_tokens TEXT NOT NULL DEFAULT '[]',
                classification TEXT NOT NULL DEFAULT '{}',
                material_category TEXT NOT NULL DEFAULT '',
                mass_class TEXT NOT NULL DEFAULT '',
                mass_min_kg REAL,
                mass_max_kg REAL,
                moderation_state TEXT NOT NULL DEFAULT 'not_checked',
                upload_state TEXT NOT NULL DEFAULT 'ready',
                submission_state TEXT NOT NULL DEFAULT 'not_sent',
                created_at TEXT NOT NULL
            );
            """
        )
        db.execute("""CREATE TABLE IF NOT EXISTS comments (
            report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
            id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
            client_token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(report_id,id))""")
        db.execute("""CREATE TABLE IF NOT EXISTS communities (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL,
            description TEXT NOT NULL, creator TEXT NOT NULL, city TEXT NOT NULL,
            created_at TEXT NOT NULL, client_token_hash TEXT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS accounts (
            key TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
            salt TEXT NOT NULL, password_hash TEXT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS account_sessions (
            key TEXT PRIMARY KEY, account_key TEXT NOT NULL REFERENCES accounts(key),
            expires_at INTEGER NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS google_signin_challenges (
            key TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)""")
        account_columns = {row[1] for row in db.execute("PRAGMA table_info(accounts)").fetchall()}
        for name, definition in (
            ("auth_provider", "TEXT NOT NULL DEFAULT 'password'"),
            ("email_verified", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if name not in account_columns:
                db.execute(f"ALTER TABLE accounts ADD COLUMN {name} {definition}")
        # SQLite databases from earlier local runs receive additive migrations.
        columns = {row[1] for row in db.execute("PRAGMA table_info(reports)").fetchall()}
        for name, definition in (
            ("photo_public", "INTEGER NOT NULL DEFAULT 0"),
            ("classification", "TEXT NOT NULL DEFAULT '{}'"),
            ("material_category", "TEXT NOT NULL DEFAULT ''"),
            ("mass_class", "TEXT NOT NULL DEFAULT ''"),
            ("mass_min_kg", "REAL"),
            ("mass_max_kg", "REAL"),
            ("moderation_state", "TEXT NOT NULL DEFAULT 'not_checked'"),
            ("owner_token_hash", "TEXT NOT NULL DEFAULT ''"),
            ("upload_state", "TEXT NOT NULL DEFAULT 'ready'"),
            ("submission_state", "TEXT NOT NULL DEFAULT 'not_sent'"),
            ("submission_id", "TEXT NOT NULL DEFAULT ''"),
            ("submission_started_at", "TEXT NOT NULL DEFAULT ''"),
            ("submission_sent_at", "TEXT NOT NULL DEFAULT ''"),
            ("submission_message_id", "TEXT NOT NULL DEFAULT ''"),
            ("submission_recipient", "TEXT NOT NULL DEFAULT ''"),
        ):
            if name not in columns:
                db.execute(f"ALTER TABLE reports ADD COLUMN {name} {definition}")
        db.execute(
            """CREATE TABLE IF NOT EXISTS supports (
                report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
                client_token_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (report_id, client_token_hash)
            )"""
        )
        db.execute(
            """CREATE TABLE IF NOT EXISTS status_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
                previous_status TEXT NOT NULL,
                status TEXT NOT NULL,
                actor_fingerprint TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )


def store_photo(report_id, contents, root=None):
    from app.aws_storage import configured as aws_configured, store_photo as cloud_store
    if aws_configured():
        return cloud_store(report_id, contents)
    (root or ROOT).joinpath("uploads", f"{report_id}.jpg").write_bytes(contents)
    return f"/uploads/{report_id}.jpg"


def read_photo(image_path):
    from app.aws_storage import read_photo as read
    return read(image_path)


def public_photo_url(report_id, image_path):
    from app.aws_storage import photo_url
    return photo_url(report_id, image_path)


def delete_photo(image_path):
    from app.aws_storage import configured as aws_configured, delete_photo as cloud_delete
    if aws_configured():
        cloud_delete(image_path)
    else:
        (ROOT / "uploads" / image_path.removeprefix("/uploads/")).unlink(missing_ok=True)


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def complete_photo_upload(report_id, final_reference):
    """Commit the final photo reference and readiness together; leave failures pending."""
    from app.aws_storage import (complete_photo_upload as cloud_complete,
                                 configured as aws_configured)
    if aws_configured():
        return cloud_complete(report_id, final_reference)
    with connect() as db:
        result = db.execute(
            "UPDATE reports SET image_path=?, upload_state='ready' WHERE id=? "
            "AND upload_state='pending'", (final_reference, report_id),
        )
    return result.rowcount == 1


def claim_complaint_submission(report_id, attempt_id, started_at, recipient, draft):
    """Atomically save the confirmed draft and reserve its one outbound email."""
    from app.aws_storage import (atomic_claim_complaint_submission,
                                 configured as aws_configured)
    if aws_configured():
        return atomic_claim_complaint_submission(report_id, attempt_id, started_at,
                                                 recipient, draft)
    with connect() as db:
        result = db.execute(
            "UPDATE reports SET complaint=?, submission_state='sending', submission_id=?, "
            "submission_started_at=?, submission_sent_at='', submission_message_id='', "
            "submission_recipient=? WHERE id=? "
            "AND submission_state IN ('not_sent','delivery_failed')",
            (draft, attempt_id, started_at, recipient, report_id),
        )
    return result.rowcount == 1


def finish_complaint_submission(report_id, attempt_id, state, sent_at="", message_id=""):
    """Record SES acceptance or an unknown outcome without allowing resends."""
    from app.aws_storage import (atomic_finish_complaint_submission,
                                 configured as aws_configured)
    if aws_configured():
        return atomic_finish_complaint_submission(report_id, attempt_id, state,
                                                 sent_at, message_id)
    with connect() as db:
        result = db.execute(
            "UPDATE reports SET submission_state=?, submission_sent_at=?, "
            "submission_message_id=? WHERE id=? AND submission_id=? "
            "AND submission_state='sending'",
            (state, sent_at, message_id, report_id, attempt_id),
        )
    return result.rowcount == 1


def report_dict(row, private=False):
    item = dict(row)
    item["categories"] = json.loads(item["categories"])
    try:
        item["classification"] = json.loads(item.get("classification") or "{}")
    except (TypeError, json.JSONDecodeError):
        item["classification"] = {}
    item["photo_public"] = bool(item.get("photo_public", False))
    item.pop("support_tokens", None)
    item.pop("owner_token_hash", None)
    item.pop("client_token_hash", None)
    # Internal delivery identifiers never leave the server.
    item.pop("submission_id", None)
    item.pop("submission_started_at", None)
    item.pop("submission_message_id", None)
    if not private:
        item.pop("address", None)
        item.pop("complaint", None)
        item.pop("image_path", None)
        for key in ("submission_state", "submission_id", "submission_started_at",
                    "submission_sent_at", "submission_message_id", "submission_recipient"):
            item.pop(key, None)
        item["latitude"] = round(item["latitude"], 2)
        item["longitude"] = round(item["longitude"], 2)
        item["is_owner_view"] = False
    else:
        item["is_owner_view"] = True
    return item
