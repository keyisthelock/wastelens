"""DynamoDB adapter regressions; all AWS calls use an in-process table mock."""

import unittest
from unittest.mock import Mock, patch

from app import aws_storage


def report(report_id, created_at, upload_state="ready", status="community_reported"):
    return {
        "pk": f"REPORT#{report_id}", "sk": "REPORT", "id": report_id,
        "created_at": created_at, "upload_state": upload_state, "status": status,
    }


class CloudListingTests(unittest.TestCase):
    def connection(self, *pages):
        table = Mock()
        table.query.side_effect = list(pages)
        with patch.object(aws_storage, "table", return_value=table):
            connection = aws_storage.Connection()
        return connection, table

    def test_ready_board_filters_pending_before_limit(self):
        connection, _ = self.connection({"Items": [
            report("pending-new", "2026-10-10T10:00:00Z", "pending"),
            report("ready-old", "2026-10-10T09:00:00Z"),
        ]})
        rows = connection.execute(
            "SELECT * FROM reports WHERE upload_state='ready' ORDER BY created_at DESC LIMIT ?",
            (1,),
        ).fetchall()
        self.assertEqual([row["id"] for row in rows], ["ready-old"])

    def test_status_board_applies_both_filters_before_sort_and_limit(self):
        connection, _ = self.connection({"Items": [
            report("ready-old", "2026-10-10T08:00:00Z", status="reviewed"),
            report("pending-new", "2026-10-10T11:00:00Z", "pending", "reviewed"),
            report("other-status", "2026-10-10T12:00:00Z"),
            report("ready-new", "2026-10-10T09:00:00Z", status="reviewed"),
        ]})
        rows = connection.execute(
            "SELECT * FROM reports WHERE status=? AND upload_state='ready' "
            "ORDER BY created_at DESC LIMIT ?", ("reviewed", 1),
        ).fetchall()
        self.assertEqual([row["id"] for row in rows], ["ready-new"])

    def test_projection_cannot_hide_upload_state_from_ready_filter(self):
        connection, _ = self.connection({"Items": [
            report("pending-new", "2026-10-10T10:00:00Z", "pending"),
            report("ready-old", "2026-10-10T09:00:00Z"),
        ]})
        rows = connection.execute(
            "SELECT id FROM reports WHERE upload_state = 'ready' ORDER BY created_at DESC LIMIT ?",
            (1,),
        ).fetchall()
        self.assertEqual(rows, [{"id": "ready-old"}])

    def test_query_without_ready_filter_keeps_pending_and_orders_before_limit(self):
        connection, _ = self.connection({"Items": [
            report("ready-old", "2026-10-10T09:00:00Z"),
            report("pending-new", "2026-10-10T10:00:00Z", "pending"),
        ]})
        rows = connection.execute(
            "SELECT id,upload_state FROM reports ORDER BY created_at DESC LIMIT ?", (1,),
        ).fetchall()
        self.assertEqual(rows, [{"id": "pending-new", "upload_state": "pending"}])

    def test_ready_report_on_later_dynamodb_page_is_not_hidden_by_pending_page(self):
        cursor = {"pk": "REPORT#pending-new", "sk": "REPORT"}
        connection, table = self.connection(
            {"Items": [report("pending-new", "2026-10-10T10:00:00Z", "pending")],
             "LastEvaluatedKey": cursor},
            {"Items": [report("ready-old", "2026-10-10T09:00:00Z")]},
        )
        rows = connection.execute(
            "SELECT id FROM reports WHERE upload_state='ready' ORDER BY created_at DESC LIMIT ?",
            (1,),
        ).fetchall()
        self.assertEqual(rows, [{"id": "ready-old"}])
        self.assertEqual(table.query.call_count, 2)
        self.assertEqual(table.query.call_args.kwargs["ExclusiveStartKey"], cursor)

    def test_existing_nearby_query_supports_literal_limit_after_exclusion(self):
        connection, _ = self.connection({"Items": [
            report("older", "2026-10-10T08:00:00Z"),
            report("selected", "2026-10-10T10:00:00Z"),
            report("newer", "2026-10-10T09:00:00Z"),
        ]})
        rows = connection.execute(
            "SELECT id FROM reports WHERE id<>? ORDER BY created_at DESC LIMIT 1", ("selected",),
        ).fetchall()
        self.assertEqual(rows, [{"id": "newer"}])

    def test_single_pending_record_is_filtered_before_projection(self):
        connection, table = self.connection()
        table.get_item.return_value = {"Item": report("pending", "2026-10-10T10:00:00Z", "pending")}
        row = connection.execute(
            "SELECT id FROM reports WHERE id=? AND upload_state='ready'", ("pending",),
        ).fetchone()
        self.assertIsNone(row)
        table.get_item.assert_called_once_with(
            Key={"pk": "REPORT#pending", "sk": "REPORT"}, ConsistentRead=True,
        )


if __name__ == "__main__":
    unittest.main()
