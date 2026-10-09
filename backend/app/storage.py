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
                created_at TEXT NOT NULL
            );
            """
        )
        # SQLite databases from earlier local runs receive additive migrations.
        columns = {row[1] for row in db.execute("PRAGMA table_info(reports)").fetchall()}
        for name, definition in (
            ("classification", "TEXT NOT NULL DEFAULT '{}'"),
            ("material_category", "TEXT NOT NULL DEFAULT ''"),
            ("mass_class", "TEXT NOT NULL DEFAULT ''"),
            ("mass_min_kg", "REAL"),
            ("mass_max_kg", "REAL"),
            ("moderation_state", "TEXT NOT NULL DEFAULT 'not_checked'"),
            ("owner_token_hash", "TEXT NOT NULL DEFAULT ''"),
            ("upload_state", "TEXT NOT NULL DEFAULT 'ready'"),
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


def report_dict(row, private=False):
    item = dict(row)
    item["categories"] = json.loads(item["categories"])
    try:
        item["classification"] = json.loads(item.get("classification") or "{}")
    except (TypeError, json.JSONDecodeError):
        item["classification"] = {}
    item.pop("support_tokens", None)
    item.pop("owner_token_hash", None)
    item.pop("client_token_hash", None)
    if not private:
        item.pop("address", None)
        item.pop("complaint", None)
        item.pop("image_path", None)
        item["latitude"] = round(item["latitude"], 2)
        item["longitude"] = round(item["longitude"], 2)
        item["is_owner_view"] = False
    else:
        item["is_owner_view"] = True
    return item
