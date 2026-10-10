import json
import os
import unittest
from unittest.mock import MagicMock, patch

from app import services
from scripts.aws_readiness import audit, check


class AwsReadinessTests(unittest.TestCase):
    def test_missing_region_makes_no_service_calls(self):
        with patch.dict(os.environ, {}, clear=True), patch('boto3.Session') as factory:
            factory.return_value.region_name = None
            result = audit()
            factory.return_value.client.assert_not_called()
            self.assertIn('No AWS requests', result['blocker'])

    def test_diagnostics_never_print_exception_text(self):
        def fail():
            raise ValueError('SECRET SENTINEL')
        self.assertEqual(check('test', fail)['error_code'], 'ValueError')
        self.assertNotIn('SECRET', json.dumps(check('test', fail)))

    def test_rekognition_preserves_confidence_and_separates_inferences(self):
        with patch.dict(os.environ, {'AWS_REGION': 'ap-south-1'}), patch('boto3.client') as factory:
            client = factory.return_value
            client.detect_labels.return_value = {'Labels': [
                {'Name': 'Bottle', 'Confidence': 87.25, 'Parents': [{'Name': 'Glass'}]},
                {'Name': 'Person', 'Confidence': 99.0}]}
            client.detect_moderation_labels.return_value = {'ModerationLabels': []}
            result = services.analyze_image(b'normalized-jpeg')
            self.assertEqual(result['categories'], ['glass'])
            self.assertEqual(result['raw_labels'][0]['confidence'], 87.25)
            self.assertTrue(result['material_suggestions'][0]['inferred'])
            self.assertEqual(result['material_suggestions'][0]['evidence'][0]['name'], 'Bottle')
            self.assertNotIn('confidence', result['material_suggestions'][0])
            self.assertEqual(client.detect_labels.call_args.kwargs['Image']['Bytes'], b'normalized-jpeg')

    def test_prompt_json_mode_and_unknown_quantity(self):
        response = {'material_category':'mixed', 'mass_class':'unknown',
                    'segregation_advice':'Keep unknown materials separate for review.',
                    'visual_note':'A closed opaque bag is visible.',
                    'visible_objects':['opaque bag'], 'material_clues':[],
                    'uncertainty':'Contents and quantity cannot be identified.'}
        with patch.dict(os.environ, {'AWS_REGION':'us-east-1', 'WASTELENS_BEDROCK_OUTPUT_MODE':'prompt_json',
                                    'WASTELENS_BEDROCK_MODEL_ID':'amazon.nova-lite-v1:0'}), patch('boto3.client') as factory:
            factory.return_value.converse.return_value = {'output':{'message':{'content':[{'text':json.dumps(response)}]}}}
            result = services.classify_waste_image(b'normalized-jpeg')
            self.assertTrue(result['analysis_available'])
            self.assertEqual(result['source'], 'aws_bedrock')
            self.assertIsNone(result['mass_range_kg'])
            self.assertFalse(result['impact']['estimated'])
            request = factory.return_value.converse.call_args.kwargs
            self.assertNotIn('outputConfig', request)
            self.assertEqual(request['modelId'], 'amazon.nova-lite-v1:0')
            self.assertEqual(request['messages'][0]['content'][1]['image']['source']['bytes'], b'normalized-jpeg')

    def test_invalid_configuration_does_not_silently_switch_models_or_retry(self):
        with patch.dict(os.environ, {'AWS_REGION':'ap-south-1', 'WASTELENS_BEDROCK_OUTPUT_MODE':'invalid'}), patch('boto3.client') as factory:
            self.assertFalse(services.classify_waste_image(b'image')['analysis_available'])
            factory.return_value.converse.assert_not_called()

    def test_rekognition_guide_fallback_uses_real_label_evidence_and_no_mass(self):
        with patch.dict(os.environ, {'AWS_REGION':'ap-southeast-2', 'WASTELENS_BEDROCK_ENABLED':'false', 'WASTELENS_REKOGNITION_GUIDE_FALLBACK':'true'}), patch('boto3.client') as factory:
            factory.return_value.detect_labels.return_value={'Labels':[{'Name':'Plastic Bottle','Confidence':91.5}]}
            factory.return_value.detect_moderation_labels.return_value={'ModerationLabels':[]}
            result=services.classify_waste_image(b'normalized-jpeg')
            self.assertTrue(result['analysis_available'])
            self.assertEqual(result['source'],'aws_rekognition')
            self.assertEqual(result['classification']['material_category'],'dry_recyclable')
            self.assertEqual(result['classification']['material_clues'],['Plastic Bottle'])
            self.assertIsNone(result['mass_range_kg'])
            self.assertEqual(result['raw_labels'][0]['confidence'],91.5)
            factory.return_value.converse.assert_not_called()

    def test_no_waste_labels_do_not_invent_a_classification(self):
        with patch.dict(os.environ, {'AWS_REGION':'ap-southeast-2', 'WASTELENS_BEDROCK_ENABLED':'false', 'WASTELENS_REKOGNITION_GUIDE_FALLBACK':'true'}), patch('boto3.client') as factory:
            factory.return_value.detect_labels.return_value={'Labels':[{'Name':'Person','Confidence':99}]}
            factory.return_value.detect_moderation_labels.return_value={'ModerationLabels':[]}
            result=services.classify_waste_image(b'image')
            self.assertFalse(result['analysis_available'])
            self.assertIsNone(result['classification'])
            self.assertEqual(result['source'],'aws_rekognition')

    def test_disabled_bedrock_status_makes_no_paid_probe(self):
        from app.assistant import ai_status
        with patch.dict(os.environ, {'AWS_REGION':'ap-southeast-2','WASTELENS_BEDROCK_ENABLED':'false'}), patch('app.assistant._probe_bedrock') as probe:
            status=ai_status()
            self.assertFalse(status['ready'])
            self.assertFalse(status['bedrock_enabled'])
            probe.assert_not_called()

    def test_presigned_upload_and_read_urls_use_regional_host_without_network(self):
        import boto3
        from urllib.parse import urlparse, parse_qs
        from app.aws_storage import create_photo_upload_url, photo_url
        with patch.dict(os.environ, {'AWS_REGION':'ap-southeast-2','WASTELENS_UPLOAD_BUCKET':'synthetic-private-bucket','WASTELENS_DYNAMODB_TABLE':'synthetic-table','AWS_ACCESS_KEY_ID':'test-only-key','AWS_SECRET_ACCESS_KEY':'test-only-secret','AWS_EC2_METADATA_DISABLED':'true'},clear=True), patch.object(boto3,'DEFAULT_SESSION',None):
            upload=create_photo_upload_url('synthetic')
            read=photo_url('synthetic','reports/synthetic.jpg')
            for url in [upload,read]:
                parsed=urlparse(url)
                self.assertEqual(parsed.hostname,'synthetic-private-bucket.s3.ap-southeast-2.amazonaws.com')
                self.assertEqual(parse_qs(parsed.query)['X-Amz-Algorithm'],['AWS4-HMAC-SHA256'])
            self.assertEqual(urlparse(upload).path,'/pending/synthetic.jpg')
            self.assertEqual(urlparse(read).path,'/reports/synthetic.jpg')
