import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app import accounts, storage
from app.main import app, limiter


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = storage.DB_PATH
        storage.DB_PATH = Path(self.temp.name) / 'accounts.db'
        self.env = patch.dict(os.environ, {'WASTELENS_DYNAMODB_TABLE': '', 'WASTELENS_UPLOAD_BUCKET': ''})
        self.env.start(); storage.initialize(); limiter._events.clear()
        self.client = TestClient(app, base_url='https://testserver')
        self.body = {'name': 'Test Neighbor', 'email': 'neighbor@example.test', 'password': 'synthetic-test-password-only'}

    def tearDown(self):
        self.env.stop(); storage.DB_PATH = self.previous; self.temp.cleanup()

    def register(self):
        response = self.client.post('/api/auth/register', json=self.body)
        self.assertEqual(response.status_code, 201, response.text)
        return response

    def test_register_cookie_and_reload_session_are_real_and_private(self):
        response = self.register()
        cookie = response.headers['set-cookie']
        self.assertIn('HttpOnly', cookie); self.assertIn('Secure', cookie); self.assertIn('SameSite=strict', cookie)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertFalse(response.json()['user']['email_verified'])
        payload = response.json()
        self.assertEqual(set(payload), {'user'})
        self.assertEqual(set(payload['user']), {'id', 'name', 'email', 'email_verified', 'auth_provider'})
        self.assertEqual(payload['user']['auth_provider'], 'password')
        self.assertNotIn(self.body['password'], str(payload))
        self.assertNotIn(self.client.cookies.get(accounts.COOKIE), str(payload))
        user = self.client.get('/api/auth/me').json()['user']
        self.assertEqual(user['email'], self.body['email'])
        with storage.connect() as db:
            row = db.execute('SELECT * FROM accounts').fetchone()
            self.assertNotEqual(row['password_hash'], self.body['password'])
            self.assertEqual(len(row['password_hash']), 128)
            self.assertNotIn(self.client.cookies.get(accounts.COOKIE), str(db.execute('SELECT * FROM account_sessions').fetchone()))

    def test_login_failure_logout_revocation_and_login_again(self):
        self.register(); old = self.client.cookies.get(accounts.COOKIE)
        response = self.client.post('/api/auth/logout')
        self.assertTrue(response.json()['signed_out'])
        self.assertIsNone(self.client.get('/api/auth/me').json()['user'])
        other = TestClient(app, base_url='https://testserver'); other.cookies.set(accounts.COOKIE, old)
        self.assertIsNone(other.get('/api/auth/me').json()['user'])
        self.assertEqual(self.client.post('/api/auth/login', json={**self.body, 'password': 'wrong'}).status_code, 401)
        response = self.client.post('/api/auth/login', json=self.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['user']['name'], self.body['name'])
        self.assertNotEqual(old, self.client.cookies.get(accounts.COOKIE))

    def test_unknown_email_has_same_error_and_no_false_session(self):
        response = self.client.post('/api/auth/login', json=self.body)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()['detail'], 'Email or password is incorrect')
        self.assertIsNone(self.client.get('/api/auth/me').json()['user'])

    def test_expired_and_forged_sessions_are_anonymous(self):
        self.register()
        with storage.connect() as db:
            db.execute('UPDATE account_sessions SET expires_at=?', (int(time.time()) - 1,))
        self.assertIsNone(self.client.get('/api/auth/me').json()['user'])
        self.client.cookies.clear(); self.client.cookies.set(accounts.COOKIE, 'forged-token-' * 4)
        self.assertIsNone(self.client.get('/api/auth/me').json()['user'])

    def test_validation_duplicate_registration_and_origin_rejection(self):
        self.assertEqual(self.client.post('/api/auth/register', json={**self.body, 'password': 'short'}).status_code, 422)
        self.assertEqual(self.client.post('/api/auth/register', json={**self.body, 'email': 'not-an-email'}).status_code, 422)
        self.assertEqual(self.client.post('/api/auth/register', json=self.body, headers={'Origin': 'https://attacker.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/auth/register', json=self.body, headers={'Sec-Fetch-Site': 'cross-site'}).status_code, 403)
        self.register()
        self.assertEqual(self.client.post('/api/auth/register', json=self.body).status_code, 409)

    def test_existing_browser_session_rotates_on_login(self):
        self.register(); previous = self.client.cookies.get(accounts.COOKIE)
        self.client.post('/api/auth/login', json=self.body)
        other = TestClient(app, base_url='https://testserver'); other.cookies.set(accounts.COOKIE, previous)
        self.assertIsNone(other.get('/api/auth/me').json()['user'])
        self.assertIsNotNone(self.client.get('/api/auth/me').json()['user'])

    def test_cloud_accounts_and_sessions_never_enter_public_report_index(self):
        target = MagicMock()
        with patch('app.accounts.configured', return_value=True), patch('app.aws_storage.table', return_value=target):
            accounts._put('ACCOUNT', 'email-hash', {'name': 'Test'}, unique=True)
            item = target.put_item.call_args.kwargs['Item']
            self.assertEqual(item['pk'], 'ACCOUNT#email-hash'); self.assertNotIn('gsi1pk', item)
            self.assertEqual(target.put_item.call_args.kwargs['ConditionExpression'], 'attribute_not_exists(pk)')
            accounts._put('SESSION', 'opaque-hash', {'account_key': 'email-hash', 'expires_at': 100})
            self.assertNotIn('gsi1pk', target.put_item.call_args.kwargs['Item'])
            accounts._delete_session('synthetic-session-token')
            self.assertNotIn('synthetic-session-token', str(target.delete_item.call_args))

    def test_guest_reporting_access_is_not_gated_by_accounts(self):
        self.assertEqual(self.client.get('/api/reports').status_code, 200)
        self.assertEqual(self.client.get('/api/communities').status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me').json(), {'user': None})
