import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.db import build_engine, database_ready
from app.errors import APIError, ErrorResponse, JSONCORSMiddleware, error_response, register_errors
from app.auth import router as auth_router
from app.google_oidc import GoogleOIDC

logger = logging.getLogger("adamlife.api")


class Health(BaseModel):
    status: str
    service: str = "adamlife-api"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.engine = build_engine(settings) if settings.database_url else None
        app.state.google = GoogleOIDC(settings)
        try:
            yield
        finally:
            app.state.google.close()
            if app.state.engine is not None:
                app.state.engine.dispose()

    app = FastAPI(
        title="AdamLife API", version="0.1.0", debug=False,
        docs_url="/docs" if settings.app_env != "production" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.app_env != "production" else None,
        lifespan=lifespan,
    )
    app.state.engine = None
    app.state.settings = settings
    app.include_router(auth_router)
    register_errors(app)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = str(uuid4())
        try:
            host = request.url.hostname
        except ValueError:
            host = None
        if host not in settings.trusted_hosts:
            return error_response(request, 400, "INVALID_HOST", "Invalid request host")
        try:
            response = await call_next(request)
        except Exception as exc:
            logger.error("unhandled_failure request_id=%s type=%s", request.state.request_id, type(exc).__name__)
            response = error_response(request, 500, "INTERNAL_ERROR", "Internal server error")
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if settings.secure_cookies:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        if response.status_code == 401:
            from app.auth import clear_cookie
            clear_cookie(response, settings, settings.session_cookie)
        return response

    # Outer CORS also covers error responses. CSRF checks are independent of CORS.
    app.add_middleware(
        JSONCORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-CSRF-Token"],
        expose_headers=["X-Request-ID"],
    )

    @app.get("/health", response_model=Health, tags=["infrastructure"])
    def health() -> Health:
        return Health(status="ok")

    @app.get("/health/ready", response_model=Health, tags=["infrastructure"],
             responses={503: {"model": ErrorResponse}})
    def ready(request: Request) -> Health:
        try:
            is_ready = database_ready(request.app.state.engine)
        except SQLAlchemyError as exc:
            logger.warning("readiness_failed type=%s", type(exc).__name__)
            is_ready = False
        if not is_ready:
            raise APIError(503, "DATABASE_NOT_READY", "Database configuration, schema or runtime role is not ready")
        return Health(status="ready")

    return app


app = create_app()
