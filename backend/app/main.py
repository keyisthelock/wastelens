from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler

from app.aws_storage import configured as aws_storage_configured
from app.rate_limit import RULES, limiter
from app.routes import router
from app.accounts import router as accounts_router
from app.google_signin import router as google_router
from app.storage import initialize

@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize()
    yield


app = FastAPI(title="WasteLens API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=(os.getenv("WASTELENS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
                   .split(",")),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Client-Token", "X-Report-Token", "X-Admin-Token"],
)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    if request.url.path.startswith('/api/auth/'):
        # Pydantic includes rejected values by default; never echo a credential.
        errors = [{'loc': error['loc'], 'msg': error['msg'], 'type': error['type']}
                  for error in exc.errors()]
        return JSONResponse(status_code=422, content={'detail': errors},
                            headers={'Cache-Control': 'no-store'})
    return await request_validation_exception_handler(request, exc)


@app.middleware("http")
async def request_rate_limit(request, call_next):
    client = request.client.host if request.client else "unknown"
    for method, pattern, limit, window_seconds in RULES:
        if request.method == method and pattern.match(request.url.path):
            bucket = f"{client}:{method}:{pattern.pattern}"
            if not limiter.allow(bucket, limit, window_seconds):
                return JSONResponse(status_code=429,
                                    content={"detail": "Rate limit reached. Try again shortly."},
                                    headers={"Retry-After": str(window_seconds)})
            break
    return await call_next(request)

app.include_router(router, prefix="/api")
app.include_router(accounts_router, prefix="/api")
app.include_router(google_router, prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}
