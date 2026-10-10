"""Google Identity Services sign-in, bound to a one-use browser challenge.

Only Google's signed identity token is accepted. Identity is keyed by Google's
stable subject, never implicitly linked to an existing password account by email.
No Google access/refresh token or client secret is requested or stored.
"""
import hmac
import os
import re
import secrets
import time
import uuid

import jwt
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.accounts import _check_origin, _get, _put, _secure, _start_session, _user
from app.aws_storage import configured
from app.storage import connect, hash_token

router = APIRouter(prefix='/auth/google')
CHALLENGE_COOKIE = 'wastelens-google-challenge'
CHALLENGE_SECONDS = 10 * 60
_keys = jwt.PyJWKClient('https://www.googleapis.com/oauth2/v3/certs',
                       cache_jwk_set=True, lifespan=300, timeout=5)


def client_id():
    value = os.getenv('WASTELENS_GOOGLE_CLIENT_ID', '').strip()
    return value if re.fullmatch(r'[A-Za-z0-9_-]+\.apps\.googleusercontent\.com', value) else ''


def _challenge(key, consume=False):
    if configured():
        from app.aws_storage import table
        identity = {'pk': f'GOOGLE_CHALLENGE#{key}', 'sk': 'META'}
        if consume:
            return table().delete_item(Key=identity, ReturnValues='ALL_OLD').get('Attributes')
        return table().get_item(Key=identity, ConsistentRead=True).get('Item')
    with connect() as db:
        # An immediate transaction serializes consumption across worker processes.
        if consume:
            db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM google_signin_challenges WHERE key=?', (key,)).fetchone()
        if consume:
            db.execute('DELETE FROM google_signin_challenges WHERE key=?', (key,))
    return dict(row) if row else None


def _save_challenge(key, nonce):
    item = {'nonce_hash': hash_token(nonce), 'expires_at': int(time.time()) + CHALLENGE_SECONDS}
    if configured():
        from app.aws_storage import table
        table().put_item(Item={'pk': f'GOOGLE_CHALLENGE#{key}', 'sk': 'META', **item},
                         ConditionExpression='attribute_not_exists(pk)')
    else:
        with connect() as db:
            db.execute('DELETE FROM google_signin_challenges WHERE expires_at<=?', (int(time.time()),))
            db.execute('INSERT INTO google_signin_challenges (key,nonce_hash,expires_at) VALUES (?,?,?)',
                       (key, item['nonce_hash'], item['expires_at']))


def verify_credential(credential, audience):
    try:
        key = _keys.get_signing_key_from_jwt(credential).key
        claims = jwt.decode(credential, key, algorithms=['RS256'], audience=audience,
                            issuer=['accounts.google.com', 'https://accounts.google.com'],
                            options={'strict_aud': True, 'require': [
                                'exp', 'iat', 'aud', 'iss', 'sub', 'nonce', 'email', 'email_verified']})
    except jwt.PyJWKClientConnectionError as exc:
        raise HTTPException(503, 'Google identity verification is temporarily unavailable. Try again or use email sign-in.') from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(401, 'Google sign-in could not be verified. Please try again.') from exc
    if (not isinstance(claims.get('sub'), str) or not 1 <= len(claims['sub']) <= 255
            or claims.get('email_verified') is not True
            or not isinstance(claims.get('email'), str) or len(claims['email']) > 254
            or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', claims['email'])
            or not isinstance(claims.get('nonce'), str)):
        raise HTTPException(401, 'Google did not return a verified account. Please use email sign-in.')
    return claims


@router.get('/config')
def config(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    value = client_id()
    return {'configured': bool(value), 'client_id': value or None}


@router.post('/challenge')
def challenge(request: Request, response: Response):
    _check_origin(request)
    if not client_id():
        raise HTTPException(503, 'Google sign-in is not configured yet. Please use email sign-in.')
    previous = request.cookies.get(CHALLENGE_COOKIE)
    if previous and 32 <= len(previous) <= 128:
        _challenge(hash_token(previous), consume=True)
    token, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    _save_challenge(hash_token(token), nonce)
    response.set_cookie(CHALLENGE_COOKIE, token, max_age=CHALLENGE_SECONDS, httponly=True,
                        secure=_secure(request), samesite='strict', path='/')
    response.headers['Cache-Control'] = 'no-store'
    return {'nonce': nonce, 'expires_in': CHALLENGE_SECONDS}


class GoogleCredential(BaseModel):
    credential: str = Field(min_length=20, max_length=8192)


@router.post('')
def sign_in(body: GoogleCredential, request: Request, response: Response):
    _check_origin(request)
    audience = client_id()
    if not audience:
        raise HTTPException(503, 'Google sign-in is not configured yet. Please use email sign-in.')
    browser = request.cookies.get(CHALLENGE_COOKIE)
    if not browser or not 32 <= len(browser) <= 128:
        raise HTTPException(401, 'Google sign-in expired. Please start again.')
    key = hash_token(browser)
    pending = _challenge(key)
    if not pending or int(pending['expires_at']) <= int(time.time()):
        raise HTTPException(401, 'Google sign-in expired. Please start again.')
    claims = verify_credential(body.credential, audience)
    if not hmac.compare_digest(hash_token(claims['nonce']), pending['nonce_hash']):
        raise HTTPException(401, 'Google sign-in did not match this browser. Please start again.')
    consumed = _challenge(key, consume=True)
    if not consumed or int(consumed['expires_at']) <= int(time.time()):
        raise HTTPException(401, 'Google sign-in was already used or expired. Please start again.')
    account_key = f"google:{hash_token(claims['sub'])}"
    item = _get('ACCOUNT', account_key)
    if not item:
        name = ' '.join(str(claims.get('name') or 'Neighbor').split())[:40]
        item = {'id': str(uuid.uuid4()), 'name': name or 'Neighbor',
                'email': claims['email'].strip().casefold(), 'salt': '', 'password_hash': '',
                'auth_provider': 'google', 'email_verified': 1}
        try:
            _put('ACCOUNT', account_key, item, unique=True)
        except HTTPException as exc:
            if exc.status_code != 409:
                raise
            item = _get('ACCOUNT', account_key)
            if not item:
                raise HTTPException(503, 'Your account could not be saved. Please try again.') from exc
    _start_session(request, response, account_key)
    response.delete_cookie(CHALLENGE_COOKIE, path='/', secure=_secure(request),
                           httponly=True, samesite='strict')
    return {'user': _user(item)}
