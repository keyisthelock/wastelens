"""Optional AWS repositories. Local development keeps using SQLite and backend/uploads."""

import os
import re
import hashlib
from decimal import Decimal
from functools import lru_cache


def configured():
    return bool(os.getenv("WASTELENS_DYNAMODB_TABLE") and os.getenv("WASTELENS_UPLOAD_BUCKET"))


@lru_cache(maxsize=2)
def _table(table_name, region):
    import boto3
    return boto3.resource("dynamodb", region_name=region).Table(table_name)


def table():
    if not configured():
        raise RuntimeError("AWS storage is not configured")
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    return _table(os.environ["WASTELENS_DYNAMODB_TABLE"], region)


def _s3_client(region):
    """Sign against the actual regional host, avoiding fresh-bucket redirects."""
    import boto3
    from botocore.config import Config
    if not region:
        raise RuntimeError("AWS region is not configured")
    suffix = "amazonaws.com.cn" if region.startswith("cn-") else "amazonaws.com"
    return boto3.client("s3", region_name=region,
                        endpoint_url=f"https://s3.{region}.{suffix}",
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def _photo_key(report_id):
    return f"reports/{report_id}.jpg"


def _pending_photo_key(report_id):
    return f"pending/{report_id}.jpg"


def pending_photo_key(report_id):
    """Canonical quarantine key shared by signing, confirmation, and cleanup."""
    return _pending_photo_key(report_id)


def complete_photo_upload(report_id, final_reference):
    """Publish only an existing pending record after its normalized object is stored."""
    from botocore.exceptions import ClientError

    try:
        table().update_item(
            Key={"pk": f"REPORT#{report_id}", "sk": "REPORT"},
            UpdateExpression="SET #image = :image, #state = :ready",
            ConditionExpression="attribute_exists(pk) AND #state = :pending",
            ExpressionAttributeNames={"#image": "image_path", "#state": "upload_state"},
            ExpressionAttributeValues={":image": final_reference, ":ready": "ready",
                                       ":pending": "pending"},
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def store_photo(report_id, contents):
    if configured():
        import boto3
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        _s3_client(region).put_object(
            Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=_photo_key(report_id),
            Body=contents, ContentType="image/jpeg", ServerSideEncryption="AES256",
            Metadata={"report-id": report_id},
        )
        return _photo_key(report_id)
    return f"/uploads/{report_id}.jpg"


def store_confirmed_photo(report_id, contents):
    """The first validated final snapshot wins, including overlapping retries."""
    import boto3
    from botocore.exceptions import ClientError
    from app.image_security import MAX_SAFE_ANALYSIS_BYTES, normalize_uploaded_image

    if not configured():
        raise RuntimeError("Confirmed cloud photos require S3 storage")
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    client = _s3_client(region)
    final_reference = _photo_key(report_id)
    try:
        client.put_object(
            Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=final_reference,
            Body=contents, ContentType="image/jpeg", ServerSideEncryption="AES256",
            Metadata={"report-id": report_id,
                      "content-sha256": hashlib.sha256(contents).hexdigest()},
            IfNoneMatch="*",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"PreconditionFailed", "412"}:
            raise
        # Another confirmation (or a prior write whose response was lost) already
        # stored this immutable snapshot. Validate it before committing readiness.
        existing = client.get_object(Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"],
                                     Key=final_reference)
        metadata = existing.get("Metadata", {})
        stream = existing["Body"]
        try:
            if existing.get("ContentType") != "image/jpeg" or metadata.get("report-id") != report_id:
                raise ValueError("Existing final photo could not be verified")
            body = stream.read(MAX_SAFE_ANALYSIS_BYTES + 1)
        finally:
            stream.close()
        if not body or len(body) > MAX_SAFE_ANALYSIS_BYTES:
            raise ValueError("Existing final photo has an invalid size")
        expected_digest = metadata.get("content-sha256")
        if expected_digest and hashlib.sha256(body).hexdigest() != expected_digest:
            raise ValueError("Existing final photo failed its integrity check")
        normalize_uploaded_image(body, "image/jpeg")
    return final_reference


def create_photo_upload_url(report_id):
    if not configured():
        raise RuntimeError("Presigned uploads require configured S3 and DynamoDB")
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    return _s3_client(region).generate_presigned_url(
        "put_object", Params={"Bucket": os.environ["WASTELENS_UPLOAD_BUCKET"],
                              "Key": _pending_photo_key(report_id), "ContentType": "image/jpeg"},
        ExpiresIn=300, HttpMethod="PUT")


def uploaded_photo(image_path):
    if not configured():
        raise RuntimeError("S3 photo storage is not configured")
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    client = _s3_client(region)
    try:
        metadata = client.head_object(Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=image_path)
    except Exception as exc:
        if "404" in str(exc) or "NoSuchKey" in str(exc):
            raise FileNotFoundError("The photo has not reached private storage yet") from exc
        raise
    length = metadata.get("ContentLength", 0)
    if length > 8 * 1024 * 1024:
        raise ValueError("Image must be 8 MB or smaller")
    if length <= 0:
        raise ValueError("Image is empty")
    if metadata.get("ContentType") != "image/jpeg":
        raise ValueError("Upload must be a JPEG image")
    return client.get_object(Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=image_path)["Body"].read()


def photo_url(report_id, image_path):
    if not configured():
        return image_path
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    return _s3_client(region).generate_presigned_url(
        "get_object", Params={"Bucket": os.environ["WASTELENS_UPLOAD_BUCKET"],
                              "Key": image_path}, ExpiresIn=300)


def delete_photo(image_path):
    if configured():
        import boto3
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        _s3_client(region).delete_object(
            Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=image_path)


def read_photo(image_path):
    if configured():
        import boto3
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        return _s3_client(region).get_object(
            Bucket=os.environ["WASTELENS_UPLOAD_BUCKET"], Key=image_path)["Body"].read()
    from pathlib import Path
    from app.storage import ROOT
    return (ROOT / "uploads" / image_path.removeprefix("/uploads/")).read_bytes()


def atomic_support_vote(report_id, token_hash, created_at):
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    client = boto3.client("dynamodb", region_name=region)
    table_name = os.environ["WASTELENS_DYNAMODB_TABLE"]
    report_key = {"pk": {"S": f"REPORT#{report_id}"}, "sk": {"S": "REPORT"}}
    support_item = {
        "pk": {"S": f"REPORT#{report_id}"},
        "sk": {"S": f"SUPPORT#{token_hash}"},
        "report_id": {"S": report_id},
        "client_token_hash": {"S": token_hash},
        "created_at": {"S": created_at},
    }
    supported = False
    try:
        client.transact_write_items(TransactItems=[
            {"Put": {"TableName": table_name, "Item": support_item,
                     "ConditionExpression": "attribute_not_exists(pk)"}},
            {"Update": {"TableName": table_name, "Key": report_key,
                        "UpdateExpression": "ADD supports :one",
                        "ConditionExpression": "attribute_exists(pk)",
                        "ExpressionAttributeValues": {":one": {"N": "1"}}}},
        ])
        supported = True
    except client.exceptions.TransactionCanceledException:
        pass
    current = client.get_item(TableName=table_name, Key=report_key, ConsistentRead=True).get("Item")
    if not current:
        return None, None
    return supported, int(current.get("supports", {}).get("N", "0"))


def atomic_status_update(report_id, new_status, actor_fingerprint, created_at):
    import boto3
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    client = boto3.client("dynamodb", region_name=region)
    table_name = os.environ["WASTELENS_DYNAMODB_TABLE"]
    key = {"pk": {"S": f"REPORT#{report_id}"}, "sk": {"S": "REPORT"}}
    current = client.get_item(TableName=table_name, Key=key, ConsistentRead=True).get("Item")
    if not current:
        return None
    previous = current.get("status", {}).get("S", "community_reported")
    event_item = {
        "pk": {"S": f"REPORT#{report_id}"},
        "sk": {"S": f"STATUS#{created_at}#{actor_fingerprint}"},
        "report_id": {"S": report_id}, "previous_status": {"S": previous},
        "status": {"S": new_status}, "actor_fingerprint": {"S": actor_fingerprint},
        "created_at": {"S": created_at},
    }
    try:
        client.transact_write_items(TransactItems=[
            {"Update": {"TableName": table_name, "Key": key,
                        "UpdateExpression": "SET #status = :new",
                        "ConditionExpression": "#status = :previous",
                        "ExpressionAttributeNames": {"#status": "status"},
                        "ExpressionAttributeValues": {":new": {"S": new_status},
                                                      ":previous": {"S": previous}}}},
            {"Put": {"TableName": table_name, "Item": event_item,
                     "ConditionExpression": "attribute_not_exists(pk)"}},
        ])
    except client.exceptions.TransactionCanceledException:
        return False
    return previous


def atomic_claim_complaint_submission(report_id, attempt_id, started_at, recipient, draft):
    """Reserve one confirmed outbound email, atomically, in DynamoDB."""
    import boto3

    client = boto3.client("dynamodb", region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"))
    try:
        client.update_item(
            TableName=os.environ["WASTELENS_DYNAMODB_TABLE"],
            Key={"pk": {"S": f"REPORT#{report_id}"}, "sk": {"S": "REPORT"}},
            UpdateExpression=("SET complaint=:draft, submission_state=:sending, "
                              "submission_id=:attempt, submission_started_at=:started, "
                              "submission_sent_at=:empty, submission_message_id=:empty, "
                              "submission_recipient=:recipient"),
            ConditionExpression=("attribute_exists(pk) AND "
                                 "(attribute_not_exists(submission_state) OR "
                                 "submission_state = :not_sent OR "
                                 "submission_state = :delivery_failed)"),
            ExpressionAttributeValues={
                ":draft": {"S": draft}, ":sending": {"S": "sending"},
                ":attempt": {"S": attempt_id}, ":started": {"S": started_at},
                ":recipient": {"S": recipient}, ":not_sent": {"S": "not_sent"},
                ":delivery_failed": {"S": "delivery_failed"}, ":empty": {"S": ""},
            },
        )
        return True
    except client.exceptions.ConditionalCheckFailedException:
        return False


def atomic_finish_complaint_submission(report_id, attempt_id, state, sent_at="", message_id=""):
    import boto3

    client = boto3.client("dynamodb", region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"))
    try:
        client.update_item(
            TableName=os.environ["WASTELENS_DYNAMODB_TABLE"],
            Key={"pk": {"S": f"REPORT#{report_id}"}, "sk": {"S": "REPORT"}},
            UpdateExpression=("SET submission_state=:state, submission_sent_at=:sent, "
                              "submission_message_id=:message_id"),
            ConditionExpression="submission_id = :attempt AND submission_state = :sending",
            ExpressionAttributeValues={
                ":state": {"S": state}, ":sent": {"S": sent_at},
                ":message_id": {"S": message_id}, ":attempt": {"S": attempt_id},
                ":sending": {"S": "sending"},
            },
        )
        return True
    except client.exceptions.ConditionalCheckFailedException:
        return False


class Row(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


class Result:
    def __init__(self, rows=(), rowcount=0):
        self.rows = [Row(row) for row in rows]
        self.rowcount = rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class Connection:
    """Tiny SQL-shaped adapter for the handful of statements used by the local API."""

    def __init__(self):
        self._table = table()

    def execute(self, sql, params=()):
        statement = " ".join(sql.split())
        if statement.upper() == "BEGIN IMMEDIATE":
            return Result()
        if statement.upper().startswith("SELECT "):
            return self._select(statement, params)
        if statement.upper().startswith("INSERT OR IGNORE INTO SUPPORTS"):
            return self._insert_support(params)
        if statement.upper().startswith("INSERT INTO STATUS_EVENTS"):
            return self._insert_status_event(params)
        if statement.upper().startswith("INSERT INTO REPORTS"):
            return self._insert_report(statement, params)
        if statement.upper().startswith("UPDATE REPORTS SET"):
            return self._update_report(statement, params)
        if statement.upper().startswith("DELETE FROM REPORTS"):
            return self._delete_report(params[0])
        raise NotImplementedError(f"AWS storage does not support query: {statement[:80]}")

    def commit(self):
        return None

    def rollback(self):
        return None

    def close(self):
        return None

    @staticmethod
    def _key(report_id):
        return {"pk": f"REPORT#{report_id}", "sk": "REPORT"}

    def _get(self, report_id):
        response = self._table.get_item(Key=self._key(report_id), ConsistentRead=True)
        item = response.get("Item")
        return self._decode(item) if item else None

    def _scan_reports(self):
        from boto3.dynamodb.conditions import Key
        items = []
        query = {"IndexName": "ByLocalityAndCreatedAt",
                 "KeyConditionExpression": Key("gsi1pk").eq("LOCALITY#Lucknow"),
                 "ScanIndexForward": False}
        response = self._table.query(**query)
        items.extend(response.get("Items", []))
        while response.get("LastEvaluatedKey"):
            response = self._table.query(**query, ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
        return [self._decode(item) for item in items]

    @staticmethod
    def _decode(item):
        def clean(value):
            if isinstance(value, Decimal):
                return float(value)
            if isinstance(value, list):
                return [clean(member) for member in value]
            if isinstance(value, dict):
                return {key: clean(member) for key, member in value.items()}
            return value

        result = clean(item)
        result.pop("pk", None)
        result.pop("sk", None)
        result.pop("gsi1pk", None)
        result.pop("gsi1sk", None)
        result.setdefault("supports", 0)
        result.setdefault("support_tokens", "[]")
        result.setdefault("classification", "{}")
        result.setdefault("material_category", "")
        result.setdefault("mass_class", "")
        result.setdefault("mass_min_kg", None)
        result.setdefault("mass_max_kg", None)
        result.setdefault("owner_token_hash", "")
        result.setdefault("upload_state", "ready")
        result.setdefault("submission_state", "not_sent")
        result.setdefault("submission_id", "")
        result.setdefault("submission_started_at", "")
        result.setdefault("submission_sent_at", "")
        result.setdefault("submission_message_id", "")
        result.setdefault("submission_recipient", "")
        return result

    def _select(self, statement, params):
        projection = statement.split(" FROM ", 1)[0][7:].strip()
        if "WHERE id = ?" in statement:
            row = self._get(params[0])
            rows = [row] if row else []
        elif "WHERE id=?" in statement:
            row = self._get(params[0])
            rows = [row] if row else []
        elif "WHERE id<>?" in statement or "WHERE id <> ?" in statement:
            excluded = params[0]
            rows = [row for row in self._scan_reports() if row["id"] != excluded]
        elif "WHERE status=?" in statement or "WHERE status = ?" in statement:
            status = params[0]
            rows = [row for row in self._scan_reports() if row["status"] == status]
        elif "FROM reports" in statement:
            rows = self._scan_reports()
        else:
            raise NotImplementedError(f"AWS storage cannot read query: {statement[:80]}")
        # Keep every predicate on complete records, as SQLite does. In particular,
        # pending uploads must not consume the board limit or bypass its ready filter
        # when a projection omits upload_state.
        if re.search(r"\bupload_state\s*=\s*'ready'", statement, re.IGNORECASE):
            rows = [row for row in rows if row.get("upload_state", "ready") == "ready"]
        if "ORDER BY created_at DESC" in statement:
            rows.sort(key=lambda row: row["created_at"], reverse=True)
        limit_match = re.search(r"\bLIMIT\s+(\?|\d+)\s*$", statement, re.IGNORECASE)
        if limit_match:
            limit_value = limit_match.group(1)
            limit = int(params[-1]) if limit_value == "?" else int(limit_value)
            if limit >= 0:
                rows = rows[:limit]
        if projection != "*":
            fields = [value.strip() for value in projection.split(",")]
            rows = [{field: row.get(field) for field in fields} for row in rows]
        return Result(rows)

    def _insert_report(self, statement, params):
        fields = re.search(r"\((.*?)\) VALUES", statement, re.IGNORECASE).group(1)
        record = dict(zip([field.strip() for field in fields.split(",")], params))
        report_id = record["id"]
        record.update({"pk": f"REPORT#{report_id}", "sk": "REPORT",
                       "gsi1pk": "LOCALITY#Lucknow", "gsi1sk": record["created_at"]})
        record.setdefault("supports", 0)
        record.setdefault("support_tokens", "[]")
        record.setdefault("categories", "[]")
        record.setdefault("classification", "{}")
        record.setdefault("material_category", "")
        record.setdefault("mass_class", "")
        record.setdefault("mass_min_kg", None)
        record.setdefault("mass_max_kg", None)
        record.setdefault("severity", "unassessed")
        record.setdefault("analysis_note", "")
        record.setdefault("complaint", "")
        record.setdefault("status", "community_reported")
        record.setdefault("address", "")
        record.setdefault("upload_state", "ready")
        from boto3.dynamodb.conditions import Attr
        self._table.put_item(Item=self._encode(record), ConditionExpression=Attr("pk").not_exists())
        return Result(rowcount=1)

    def _update_report(self, statement, params):
        assignments = re.search(r"SET (.*?) WHERE id=\?", statement, re.IGNORECASE).group(1)
        report_id = params[-1]
        if assignments.replace(" ", "") == "supports=supports+1":
            response = self._table.update_item(
                Key=self._key(report_id), UpdateExpression="ADD supports :one",
                ExpressionAttributeValues={":one": Decimal(1)}, ReturnValues="NONE")
            return Result(rowcount=1)
        parts = [part.strip() for part in assignments.split(",")]
        values = params[:-1]
        names = {}
        expr_values = {}
        edits = []
        for index, (part, value) in enumerate(zip(parts, values)):
            field = part.split("=", 1)[0].strip()
            name = f"#n{index}"
            placeholder = f":v{index}"
            names[name] = field
            expr_values[placeholder] = self._encode(value)
            edits.append(f"{name} = {placeholder}")
        if not self._get(report_id):
            return Result(rowcount=0)
        self._table.update_item(Key=self._key(report_id), UpdateExpression="SET " + ", ".join(edits),
                                ExpressionAttributeNames=names,
                                ExpressionAttributeValues=expr_values)
        return Result(rowcount=1)

    def _insert_support(self, params):
        from boto3.dynamodb.conditions import Attr
        report_id, token_hash, created_at = params
        try:
            self._table.put_item(
                Item={"pk": f"REPORT#{report_id}", "sk": f"SUPPORT#{token_hash}",
                      "report_id": report_id, "client_token_hash": token_hash,
                      "created_at": created_at},
                ConditionExpression=Attr("pk").not_exists(),
            )
            return Result(rowcount=1)
        except Exception as exc:
            if "ConditionalCheckFailed" in type(exc).__name__:
                return Result(rowcount=0)
            raise

    def _insert_status_event(self, params):
        report_id, previous_status, status, actor_fingerprint, created_at = params
        self._table.put_item(Item={"pk": f"REPORT#{report_id}",
                                   "sk": f"STATUS#{created_at}#{actor_fingerprint}",
                                   "report_id": report_id, "previous_status": previous_status,
                                   "status": status, "actor_fingerprint": actor_fingerprint,
                                   "created_at": created_at})
        return Result(rowcount=1)

    def _delete_report(self, report_id):
        from boto3.dynamodb.conditions import Key
        pk = f"REPORT#{report_id}"
        response = self._table.query(KeyConditionExpression=Key("pk").eq(pk), ConsistentRead=True)
        items = list(response.get("Items", []))
        while response.get("LastEvaluatedKey"):
            response = self._table.query(KeyConditionExpression=Key("pk").eq(pk),
                                         ConsistentRead=True,
                                         ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
        return Result(rowcount=1)

    @classmethod
    def _encode(cls, value):
        if isinstance(value, float):
            return Decimal(str(value))
        if isinstance(value, dict):
            return {key: cls._encode(member) for key, member in value.items()}
        if isinstance(value, list):
            return [cls._encode(member) for member in value]
        if isinstance(value, tuple):
            return [cls._encode(member) for member in value]
        return value
