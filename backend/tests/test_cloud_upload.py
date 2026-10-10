"""Upload lifecycle regressions using in-process S3 and DynamoDB fakes only."""

import copy
import io
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from PIL import Image

from app import aws_storage, routes, services, storage
from app.main import app, limiter


def jpeg_fixture(color=(50, 100, 50)):
    output = io.BytesIO()
    Image.new("RGB", (12, 12), color).save(output, format="JPEG")
    return output.getvalue()


class FakeTable:
    def __init__(self, events):
        self.items = {}
        self.events = events
        self.state_failure = None

    @staticmethod
    def key(value):
        return value["pk"], value["sk"]

    def put_item(self, Item, **kwargs):
        self.items[self.key(Item)] = copy.deepcopy(Item)
        return {}

    def get_item(self, Key, **kwargs):
        item = self.items.get(self.key(Key))
        return {"Item": copy.deepcopy(item)} if item else {}

    def query(self, **kwargs):
        def matches(condition, item):
            expression = condition.get_expression()
            values = expression["values"]
            if expression["operator"] == "AND":
                return all(matches(value, item) for value in values)
            actual = item.get(values[0].name)
            if expression["operator"] == "=":
                return actual == values[1]
            if expression["operator"] == "begins_with":
                return isinstance(actual, str) and actual.startswith(values[1])
            raise AssertionError("Unsupported mock key condition")
        items = [copy.deepcopy(item) for item in self.items.values()
                 if matches(kwargs["KeyConditionExpression"], item)]
        sort = "gsi1sk" if kwargs.get("IndexName") else "sk"
        items.sort(key=lambda item: item.get(sort, ""), reverse=not kwargs.get("ScanIndexForward", True))
        return {"Items": items[:kwargs.get("Limit", len(items))]}

    def update_item(self, Key, ExpressionAttributeNames, ExpressionAttributeValues, **kwargs):
        item = self.items.get(self.key(Key))
        if "#image" not in ExpressionAttributeNames:
            for index, field in enumerate(ExpressionAttributeNames.values()):
                item[field] = ExpressionAttributeValues[f":v{index}"]
            return {}
        self.events.append(("publish", Key["pk"].removeprefix("REPORT#")))
        if not item or item["upload_state"] != "pending":
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        if self.state_failure == "before":
            raise TimeoutError("Mock state write failed before committing")
        item[ExpressionAttributeNames["#image"]] = ExpressionAttributeValues[":image"]
        item[ExpressionAttributeNames["#state"]] = ExpressionAttributeValues[":ready"]
        if self.state_failure == "after":
            raise TimeoutError("Mock state write response was lost after committing")
        return {}


class FakeS3:
    def __init__(self, events):
        self.objects = {}
        self.events = events
        self.write_failure = None
        self.cleanup_failure = False
        self.before_write = None

    def generate_presigned_url(self, operation, Params, **kwargs):
        self.events.append((f"sign.{operation}", Params["Key"]))
        return f"https://storage.invalid/{Params['Key']}"

    def head_object(self, Bucket, Key):
        self.events.append(("head", Key))
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        item = self.objects[Key]
        return {"ContentLength": len(item["Body"]), "ContentType": item["ContentType"]}

    def get_object(self, Bucket, Key):
        self.events.append(("read", Key))
        item = self.objects[Key]
        return {"Body": io.BytesIO(item["Body"]), "ContentType": item["ContentType"],
                "Metadata": item.get("Metadata", {})}

    def put_object(self, Bucket, Key, Body, ContentType, **kwargs):
        if self.before_write:
            hook, self.before_write = self.before_write, None
            hook()
        self.events.append(("write", Key))
        if kwargs.get("IfNoneMatch") == "*" and Key in self.objects:
            self.events.append(("write-blocked", Key))
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        if self.write_failure == "before":
            raise TimeoutError("Mock S3 write failed")
        self.objects[Key] = {"Body": Body, "ContentType": ContentType,
                             "Metadata": kwargs.get("Metadata", {})}
        if self.write_failure == "after":
            raise TimeoutError("Mock S3 write response was lost")
        return {}

    def delete_object(self, Bucket, Key):
        self.events.append(("delete", Key))
        if self.cleanup_failure:
            raise TimeoutError("Mock pending cleanup failed")
        self.objects.pop(Key, None)
        return {}


class CloudUploadTests(unittest.TestCase):
    def setUp(self):
        with limiter._lock:
            limiter._events.clear()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.context.enter_context(patch.dict(os.environ, {
            "AWS_REGION": "ap-south-1", "WASTELENS_DYNAMODB_TABLE": "mock-reports",
            "WASTELENS_UPLOAD_BUCKET": "mock-private-photos",
        }, clear=True))
        self.events = []
        self.table = FakeTable(self.events)
        self.s3 = FakeS3(self.events)
        self.context.enter_context(patch.object(aws_storage, "table", return_value=self.table))
        self.context.enter_context(patch("boto3.client", side_effect=self.aws_client))
        self.temp = self.context.enter_context(tempfile.TemporaryDirectory())
        root = Path(self.temp)
        (root / "data").mkdir()
        for name in ("authorities.json", "recovery_routes.json", "factors.json", "pilot.json"):
            (root / "data" / name).write_bytes((Path(__file__).resolve().parents[1] / "data" / name).read_bytes())
        self.context.enter_context(patch.object(services, "ROOT", root))
        self.client = self.context.enter_context(TestClient(app, raise_server_exceptions=False))

    def aws_client(self, service, **kwargs):
        if service != "s3":
            raise AssertionError(f"Unexpected external service: {service}")
        return self.s3

    def create_pending(self, contents=None):
        response = self.client.post("/api/reports/upload-url", json={
            "latitude": 26.8467, "longitude": 80.9462, "address": "Hazratganj, Lucknow",
        })
        self.assertEqual(response.status_code, 201, response.text)
        upload = response.json()
        self.report_id = upload["report"]["id"]
        self.headers = {"X-Report-Token": upload["owner_token"]}
        self.pending = f"pending/{self.report_id}.jpg"
        self.final = f"reports/{self.report_id}.jpg"
        self.path = f"/api/reports/{self.report_id}/confirm-upload"
        if contents is not None:
            self.s3.objects[self.pending] = {"Body": contents, "ContentType": "image/jpeg"}
        return upload

    def raw_report(self):
        return self.table.items[(f"REPORT#{self.report_id}", "REPORT")]

    def assert_final_never_deleted(self):
        self.assertNotIn(("delete", self.final), self.events)

    def test_pending_signing_and_successful_confirmation_use_the_same_key(self):
        upload = self.create_pending(jpeg_fixture())
        self.assertEqual(self.raw_report()["image_path"], self.pending)
        self.assertEqual(upload["report"]["upload_state"], "pending")
        self.assertEqual(upload["report"]["image_path"], "")
        self.assertIn(("sign.put_object", self.pending), self.events)
        self.assertNotIn(("sign.get_object", self.pending), self.events)
        self.assertEqual(self.client.get("/api/reports").json(), [])
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["upload_state"], "ready")
        self.assertEqual(self.raw_report()["image_path"], self.final)
        self.assertEqual(self.raw_report()["upload_state"], "ready")
        self.assertIn(("read", self.pending), self.events)
        self.assertIn(("write", self.final), self.events)
        self.assertLess(self.events.index(("read", self.pending)), self.events.index(("write", self.final)))
        self.assertLess(self.events.index(("write", self.final)), self.events.index(("publish", self.report_id)))
        self.assertLess(self.events.index(("publish", self.report_id)), self.events.index(("delete", self.pending)))
        self.assertNotIn(self.pending, self.s3.objects)
        self.assertTrue(self.s3.objects[self.final]["Body"].startswith(b"\xff\xd8\xff"))
        public = self.client.get("/api/reports").json()
        self.assertEqual([report["id"] for report in public], [self.report_id])
        self.assertNotIn("owner_token", public[0])
        self.assertNotIn("owner_token_hash", public[0])
        self.assert_final_never_deleted()

    def test_cloud_discussion_does_not_pollute_the_report_board(self):
        import uuid
        self.create_pending(jpeg_fixture())
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        path = f"/api/reports/{self.report_id}/comments"
        headers = {"X-Client-Token": "mock-participation-token"}
        payload = {"id": str(uuid.uuid4()), "author": "Neighbor", "body": "Confirm municipal collection first."}
        first = self.client.post(path, json=payload, headers=headers)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(self.client.post(path, json=payload, headers=headers).status_code, 201)
        comments = self.client.get(path).json()["comments"]
        self.assertEqual(len(comments), 1)
        for field in ("client_token_hash", "gsi1pk", "pk", "sk"):
            self.assertNotIn(field, comments[0])
        self.assertEqual(len(self.client.get("/api/reports").json()), 1)

    def test_shared_cloud_photo_is_hidden_until_confirmation_and_revocable(self):
        response = self.client.post("/api/reports/upload-url", json={
            "latitude": 26.76, "longitude": 80.88, "photo_public": True,
        })
        self.assertEqual(response.status_code, 201, response.text)
        created = response.json()
        report_id = created["report"]["id"]
        headers = {"X-Report-Token": created["owner_token"]}
        self.assertEqual(self.client.get(f"/api/reports/{report_id}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/reports/{report_id}/photo").status_code, 409)
        self.s3.objects[f"pending/{report_id}.jpg"] = {"Body": jpeg_fixture(), "ContentType": "image/jpeg"}
        ready = self.client.post(f"/api/reports/{report_id}/confirm-upload", headers=headers)
        self.assertEqual(ready.status_code, 200, ready.text)
        public = self.client.get(f"/api/reports/{report_id}").json()
        self.assertEqual(public["image_path"], f"/api/reports/{report_id}/photo")
        self.assertNotIn("address", public)
        self.assertEqual(self.client.get(f"/api/reports/{report_id}/photo").status_code, 200)
        changed = self.client.patch(f"/api/reports/{report_id}/photo-sharing", json={"photo_public": False}, headers=headers)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.client.get(f"/api/reports/{report_id}/photo").status_code, 401)
        self.assertIn(f"reports/{report_id}.jpg", self.s3.objects)

    def test_cloud_creation_retry_recovers_pending_and_ready_report_by_owner_id(self):
        import uuid
        report_id = str(uuid.uuid4())
        token = "private-creation-" + ("x" * 40)
        body = {"report_id": report_id, "latitude": 26.8467, "longitude": 80.9462, "address": "Synthetic cloud retry"}
        headers = {"X-Report-Token": token}
        first = self.client.post("/api/reports/upload-url", json=body, headers=headers)
        second = self.client.post("/api/reports/upload-url", json=body, headers=headers)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(second.json()["report"]["id"], report_id)
        self.assertEqual(len(self.table.items), 1)
        unauthorized = self.client.post("/api/reports/upload-url", json=body, headers={"X-Report-Token": "wrong-" + "x" * 40})
        self.assertEqual(unauthorized.status_code, 403)
        self.s3.objects[f"pending/{report_id}.jpg"] = {"Body": jpeg_fixture(), "ContentType": "image/jpeg"}
        confirmed = self.client.post(f"/api/reports/{report_id}/confirm-upload", headers=headers)
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        ready = self.client.post("/api/reports/upload-url", json=body, headers=headers)
        self.assertEqual(ready.json()["report"]["upload_state"], "ready")
        self.assertEqual(ready.json()["upload_url"], "")
        self.assertNotIn(("delete", f"reports/{report_id}.jpg"), self.events)

    def test_unauthorized_confirmation_cannot_read_write_or_cleanup_objects(self):
        self.create_pending(jpeg_fixture())
        self.events.clear()
        self.assertEqual(self.client.post(self.path).status_code, 401)
        self.assertEqual(self.client.post(self.path, headers={"X-Report-Token": "wrong"}).status_code, 403)
        self.assertEqual(self.events, [])
        self.assertEqual(self.raw_report()["upload_state"], "pending")
        self.assertIn(self.pending, self.s3.objects)

    def test_upload_url_renewal_requires_owner_and_reuses_pending_report(self):
        self.create_pending(jpeg_fixture())
        path = f"/api/reports/{self.report_id}/upload-url"
        self.assertEqual(self.client.post(path).status_code, 401)
        self.assertEqual(self.client.post(path, headers={"X-Report-Token": "wrong"}).status_code, 403)
        response = self.client.post(path, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["report"]["id"], self.report_id)
        self.assertTrue(response.json()["upload_url"].endswith(self.pending))
        self.assertEqual(len(self.table.items), 1)
        self.assertNotIn("owner_token", response.json())
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        ready = self.client.post(path, headers=self.headers)
        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.json()["report"]["upload_state"], "ready")
        self.assertNotIn("upload_url", ready.json())
        self.assertIn(self.final, self.s3.objects)
        self.assert_final_never_deleted()

    def test_failed_link_signing_does_not_create_an_unusable_pending_record(self):
        with patch.object(self.s3, "generate_presigned_url", side_effect=TimeoutError("Mock signing failed")):
            response = self.client.post("/api/reports/upload-url", json={
                "latitude": 26.8467, "longitude": 80.9462, "address": "Hazratganj, Lucknow"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.table.items, {})

    def test_pending_photo_reads_and_analysis_stay_blocked_for_the_owner(self):
        self.create_pending(jpeg_fixture())
        for method, path, payload in [
            ("get", f"/api/reports/{self.report_id}/photo", None),
            ("post", f"/api/reports/{self.report_id}/analyze", {}),
            ("post", f"/api/reports/{self.report_id}/analyze", {"categories": ["plastic"], "severity": "low"}),
            ("post", f"/api/reports/{self.report_id}/classify", {}),
        ]:
            request = getattr(self.client, method)
            kwargs = {"headers": self.headers}
            if payload is not None:
                kwargs["json"] = payload
            self.assertEqual(request(path, **kwargs).status_code, 409)
        self.assertEqual(self.client.get(f"/api/reports/{self.report_id}").status_code, 404)
        self.assertNotIn(("read", self.pending), self.events)
        self.assertNotIn(("write", self.final), self.events)

    def test_invalid_image_and_missing_upload_remain_pending_and_private(self):
        self.create_pending()
        missing = self.client.post(self.path, headers=self.headers)
        self.assertEqual(missing.status_code, 409)
        self.s3.objects[self.pending] = {"Body": b"invalid image", "ContentType": "image/jpeg"}
        invalid = self.client.post(self.path, headers=self.headers)
        self.assertEqual(invalid.status_code, 415)
        self.assertEqual(self.raw_report()["upload_state"], "pending")
        self.assertIn(self.pending, self.s3.objects)
        self.assertNotIn(self.final, self.s3.objects)
        self.assertEqual(self.client.get("/api/reports").json(), [])
        self.assert_final_never_deleted()

    def test_repeated_ready_confirmation_does_not_read_or_rewrite_the_final_photo(self):
        self.create_pending(jpeg_fixture())
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        before = self.s3.objects[self.final]["Body"]
        self.events.clear()
        repeated = self.client.post(self.path, headers=self.headers)
        self.assertEqual(repeated.status_code, 200)
        self.assertFalse(any(event[0] in {"read", "head", "write", "publish"} for event in self.events))
        self.assertEqual(self.s3.objects[self.final]["Body"], before)
        self.assert_final_never_deleted()

    def test_overlapping_confirmations_cannot_overwrite_a_published_final_photo(self):
        self.create_pending(jpeg_fixture((200, 30, 30)))
        first_snapshot = jpeg_fixture((30, 30, 200))

        def finish_other_confirmation_first():
            self.s3.objects[self.pending] = {"Body": first_snapshot, "ContentType": "image/jpeg"}
            result = routes.confirm_report_upload(self.report_id, self.headers["X-Report-Token"])
            self.assertEqual(result["upload_state"], "ready")

        self.s3.before_write = finish_other_confirmation_first
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        expected = routes.normalize_uploaded_image(first_snapshot, "image/jpeg")
        self.assertEqual(self.s3.objects[self.final]["Body"], expected)
        self.assertIn(("write-blocked", self.final), self.events)
        self.assertEqual(self.raw_report()["upload_state"], "ready")
        self.assert_final_never_deleted()

    def test_unverified_existing_final_object_cannot_publish_a_pending_report(self):
        for metadata, body in [
            ({"report-id": "another-report"}, jpeg_fixture()),
            ({"report-id": "current"}, b"invalid final image"),
            ({"report-id": "current", "content-sha256": "incorrect"}, jpeg_fixture()),
        ]:
            with self.subTest(metadata=metadata):
                self.create_pending(jpeg_fixture())
                metadata = {key: self.report_id if value == "current" else value for key, value in metadata.items()}
                self.s3.objects[self.final] = {"Body": body, "ContentType": "image/jpeg", "Metadata": metadata}
                response = self.client.post(self.path, headers=self.headers)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(self.raw_report()["upload_state"], "pending")
                self.assertIn(self.pending, self.s3.objects)
                self.assertEqual(self.client.get(f"/api/reports/{self.report_id}").status_code, 404)
                self.assertEqual(self.s3.objects[self.final]["Body"], body)
                self.assert_final_never_deleted()

    def test_storage_write_failures_keep_original_upload_available_for_retry(self):
        for failure in ("before", "after"):
            with self.subTest(failure=failure):
                self.create_pending(jpeg_fixture())
                self.s3.write_failure = failure
                response = self.client.post(self.path, headers=self.headers)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(self.raw_report()["upload_state"], "pending")
                self.assertIn(self.pending, self.s3.objects)
                self.assertNotIn(("delete", self.pending), self.events)
                self.assertEqual(self.client.get(f"/api/reports/{self.report_id}").status_code, 404)
                self.s3.write_failure = None
                self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
                self.assertIn(self.final, self.s3.objects)
                self.assert_final_never_deleted()

    def test_storage_read_failure_preserves_pending_image_for_retry(self):
        self.create_pending(jpeg_fixture())
        with patch.object(self.s3, "get_object", side_effect=TimeoutError("Mock S3 read failed")):
            response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.raw_report()["upload_state"], "pending")
        self.assertIn(self.pending, self.s3.objects)
        self.assertNotIn(self.final, self.s3.objects)
        self.assertNotIn(("delete", self.pending), self.events)
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        self.assert_final_never_deleted()

    def test_failed_state_transition_keeps_pending_upload_and_retry_publishes_it(self):
        self.create_pending(jpeg_fixture())
        self.table.state_failure = "before"
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.raw_report()["upload_state"], "pending")
        self.assertIn(self.pending, self.s3.objects)
        self.assertIn(self.final, self.s3.objects)
        self.assertEqual(self.client.get("/api/reports").json(), [])
        self.assertNotIn(("delete", self.pending), self.events)
        self.table.state_failure = None
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        self.assert_final_never_deleted()

    def test_lost_state_commit_response_is_recovered_by_ready_confirmation(self):
        self.create_pending(jpeg_fixture())
        self.table.state_failure = "after"
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.raw_report()["upload_state"], "ready")
        self.assertIn(self.pending, self.s3.objects)
        self.events.clear()
        self.table.state_failure = None
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        self.assertNotIn(self.pending, self.s3.objects)
        self.assertFalse(any(event[0] in {"read", "write", "publish"} for event in self.events))
        self.assert_final_never_deleted()

    def test_cleanup_failure_does_not_fail_published_report_or_delete_final_photo(self):
        self.create_pending(jpeg_fixture())
        self.s3.cleanup_failure = True
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.raw_report()["upload_state"], "ready")
        self.assertIn(self.pending, self.s3.objects)
        self.assertIn(self.final, self.s3.objects)
        self.s3.cleanup_failure = False
        self.assertEqual(self.client.post(self.path, headers=self.headers).status_code, 200)
        self.assertNotIn(self.pending, self.s3.objects)
        self.assert_final_never_deleted()

    def test_existing_pending_record_with_wrong_initial_key_recovers_without_deleting_final(self):
        self.create_pending(jpeg_fixture())
        self.raw_report()["image_path"] = self.final
        response = self.client.post(self.path, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn(("read", self.pending), self.events)
        self.assertEqual(self.raw_report()["image_path"], self.final)
        self.assertIn(self.final, self.s3.objects)
        self.assert_final_never_deleted()


if __name__ == "__main__":
    unittest.main()
