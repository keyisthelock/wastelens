"""Pilot email/password accounts and revocable opaque sessions. No tokens in JSON."""
import hashlib
import hmac
import os
import re
import secrets
import time
import uuid
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from app.aws_storage import configured
from app.storage import connect, hash_token

router = APIRouter(prefix='/auth')
COOKIE = 'wastelens-session'
SESSION_SECONDS = 24 * 60 * 60


def _get(kind, key):
    if configured():
        from app.aws_storage import table
        return table().get_item(Key={'pk': f'{kind}#{key}', 'sk': 'META'}, ConsistentRead=True).get('Item')
    with connect() as db:
        row = db.execute(f'SELECT * FROM {"accounts" if kind == "ACCOUNT" else "account_sessions"} WHERE key=?', (key,)).fetchone()
    return dict(row) if row else None


def _put(kind, key, item, unique=False):
    if configured():
        from app.aws_storage import table
        from botocore.exceptions import ClientError
        try:
            table().put_item(Item={'pk': f'{kind}#{key}', 'sk': 'META', **item},
                             **({'ConditionExpression': 'attribute_not_exists(pk)'} if unique else {}))
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                raise HTTPException(409, 'An account already exists. Try signing in.') from exc
            raise
    else:
        import sqlite3
        with connect() as db:
            fields = list(item)
            try:
                db.execute(f'INSERT INTO {"accounts" if kind == "ACCOUNT" else "account_sessions"} (key,{",".join(fields)}) VALUES ({",".join("?" for _ in range(len(fields)+1))})', (key, *item.values()))
            except sqlite3.IntegrityError as exc:
                raise HTTPException(409, 'An account already exists. Try signing in.') from exc


def _delete_session(token):
    key = hash_token(token)
    if configured():
        from app.aws_storage import table
        table().delete_item(Key={'pk': f'SESSION#{key}', 'sk': 'META'})
    else:
        with connect() as db:
            db.execute('DELETE FROM account_sessions WHERE key=?', (key,))


def _password_hash(password, salt):
    return hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt),
                          n=32768, r=8, p=3, dklen=64, maxmem=64 * 1024 * 1024).hex()


def _email_key(email):
    return hash_token(email)


def _email(value):
    email = value.strip().casefold()
    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email):
        raise HTTPException(422, 'Enter a valid email address')
    return email


def _user(item):
    return {'id': item['id'], 'name': item['name'], 'email': item['email'],
            'email_verified': bool(item.get('email_verified', False)),
            'auth_provider': item.get('auth_provider', 'password')}


def _check_origin(request):
    origin = request.headers.get('origin')
    allowed = os.getenv('WASTELENS_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',')
    if origin and origin not in allowed:
        raise HTTPException(403, 'This sign-in request came from an unsupported website')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site authentication requests are not allowed')


def _secure(request):
    return configured() or request.url.scheme == 'https'


def current_user(request):
    token = request.cookies.get(COOKIE)
    if not token or not 32 <= len(token) <= 128:
        return None
    session = _get('SESSION', hash_token(token))
    if not session or int(session['expires_at']) <= int(time.time()):
        return None
    item = _get('ACCOUNT', session['account_key'])
    return _user(item) if item else None


def _start_session(request, response, account_key):
    # Rotation invalidates this browser's previous session rather than accepting a client ID.
    old = request.cookies.get(COOKIE)
    if old:
        _delete_session(old)
    token = secrets.token_urlsafe(32)
    _put('SESSION', hash_token(token), {'account_key': account_key, 'expires_at': int(time.time()) + SESSION_SECONDS})
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=_secure(request), samesite='strict', path='/')
    response.headers['Cache-Control'] = 'no-store'


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


@router.post('/register', status_code=201)
def register(body: RegisterRequest, request: Request, response: Response):
    _check_origin(request)
    name = body.name.strip()
    if len(name) < 2:
        raise HTTPException(422, 'Enter a display name of at least two characters')
    email = _email(body.email)
    key = _email_key(email)
    salt = secrets.token_hex(16)
    item = {'id': str(uuid.uuid4()), 'name': name, 'email': email, 'salt': salt,
            'password_hash': _password_hash(body.password, salt)}
    _put('ACCOUNT', key, item, unique=True)
    _start_session(request, response, key)
    return {'user': _user(item)}


@router.post('/login')
def login(body: LoginRequest, request: Request, response: Response):
    _check_origin(request)
    key = _email_key(_email(body.email))
    item = _get('ACCOUNT', key)
    # Equal-cost derivation for unknown accounts; do not reveal whether the email exists.
    salt = item['salt'] if item else '0' * 32
    actual = _password_hash(body.password, salt)
    if not item or not hmac.compare_digest(actual, item['password_hash']):
        raise HTTPException(401, 'Email or password is incorrect')
    _start_session(request, response, key)
    return {'user': _user(item)}


@router.get('/me')
def me(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return {'user': current_user(request)}


@router.post('/logout')
def logout(request: Request, response: Response):
    _check_origin(request)
    token = request.cookies.get(COOKIE)
    if token:
        _delete_session(token)
    response.delete_cookie(COOKIE, path='/', secure=_secure(request), httponly=True, samesite='strict')
    response.headers['Cache-Control'] = 'no-store'
    return {'signed_out': True}
