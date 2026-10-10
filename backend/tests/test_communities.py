import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from app import storage, groups
from app.main import app, limiter


class CommunitiesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = storage.DB_PATH
        storage.DB_PATH = Path(self.temp.name) / 'test.db'
        limiter._events.clear()
        self.environment = patch.dict(os.environ, {'WASTELENS_DYNAMODB_TABLE': '', 'WASTELENS_UPLOAD_BUCKET': ''})
        self.environment.start()
        storage.initialize()
        self.client = TestClient(app)
        self.data = {'id': str(uuid.uuid4()), 'name': 'Sarojini Nagar Clean Streets', 'area': 'Sarojini Nagar',
                     'description': 'Neighbors sharing safe cleanup proposals.', 'creator': 'Neighbor'}
        self.headers = {'X-Client-Token': 'synthetic-browser-token'}

    def tearDown(self):
        storage.DB_PATH = self.previous
        self.environment.stop()
        self.temp.cleanup()

    def test_creation_persistence_retry_and_public_privacy(self):
        for _ in range(2):
            result = self.client.post('/api/communities', json=self.data, headers=self.headers)
            self.assertEqual(result.status_code, 201, result.text)
            self.assertEqual(result.json()['community']['id'], self.data['id'])
        listing = self.client.get('/api/communities').json()
        self.assertEqual(len(listing['communities']), 1)
        self.assertEqual(listing['communities'][0]['city'], 'Lucknow')
        self.assertNotIn('token', str(listing))
        with storage.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM communities').fetchone()[0], 1)

    def test_invalid_missing_token_and_conflicting_retry(self):
        self.assertEqual(self.client.post('/api/communities', json=self.data).status_code, 401)
        self.assertEqual(self.client.post('/api/communities', json={**self.data, 'name': '   '}, headers=self.headers).status_code, 422)
        self.client.post('/api/communities', json=self.data, headers=self.headers)
        self.assertEqual(self.client.post('/api/communities', json={**self.data, 'name': 'Different group'}, headers=self.headers).status_code, 409)
        self.assertEqual(self.client.post('/api/communities', json=self.data, headers={'X-Client-Token': 'another-browser-token'}).status_code, 403)

    def test_cloud_create_and_list_use_separate_partition_and_hide_capability(self):
        target = MagicMock()
        target.get_item.return_value = {}
        with patch('app.groups.configured', return_value=True), patch('app.aws_storage.table', return_value=target):
            result = groups.create_group(self.data['id'], self.data['name'], self.data['area'], self.data['description'], self.data['creator'], 'synthetic-browser-token')
            item = target.put_item.call_args.kwargs['Item']
            self.assertEqual(item['gsi1pk'], 'COMMUNITIES#Lucknow')
            self.assertTrue(item['pk'].startswith('COMMUNITY#'))
            self.assertNotIn('client_token_hash', result)
            target.query.return_value = {'Items': [item]}
            self.assertEqual(groups.list_groups(), [result])
            self.assertEqual(target.query.call_args.kwargs['Limit'], 50)
