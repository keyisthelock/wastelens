import os
import unittest
from unittest.mock import patch
from botocore.exceptions import ClientError
from app.ai_budget import reserve_ai_call, AiBudgetUnavailable
from app import services


class AiBudgetTests(unittest.TestCase):
    def test_disabled_local_limit_does_not_access_cloud_storage(self):
        with patch.dict(os.environ, {'WASTELENS_AI_DAILY_LIMIT':'0'}), patch('app.aws_storage.table') as factory:
            reserve_ai_call()
            factory.assert_not_called()

    def test_enabled_limit_uses_atomic_conditional_update_without_board_index(self):
        with patch.dict(os.environ, {'WASTELENS_AI_DAILY_LIMIT':'25'}), patch('app.aws_storage.table') as factory:
            reserve_ai_call()
            request=factory.return_value.update_item.call_args.kwargs
            self.assertEqual(request['Key']['pk'],'AI_USAGE')
            self.assertEqual(request['ExpressionAttributeValues'][':limit'],25)
            self.assertIn('#used < :limit',request['ConditionExpression'])
            self.assertNotIn('gsi1pk',str(request))

    def test_limit_or_storage_failure_blocks_inference_and_keeps_manual_fallback(self):
        failures=[ClientError({'Error':{'Code':'ConditionalCheckFailedException'}},'UpdateItem'), TimeoutError()]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.dict(os.environ, {'AWS_REGION':'ap-southeast-2','WASTELENS_AI_DAILY_LIMIT':'25'}), patch('app.aws_storage.table') as table, patch('boto3.client') as client:
                table.return_value.update_item.side_effect=failure
                result=services.analyze_image(b'normalized-jpeg')
                self.assertFalse(result['analysis_available'])
                self.assertIn('allowance',result['note'])
                client.return_value.detect_labels.assert_not_called()

    def test_invalid_limit_fails_closed(self):
        for limit in ['invalid','-1']:
            with patch.dict(os.environ, {'WASTELENS_AI_DAILY_LIMIT':limit}), self.assertRaises(AiBudgetUnavailable):
                reserve_ai_call()
