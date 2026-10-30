from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url

ROOT = Path(__file__).resolve().parents[1]


def postgres_url(value: str) -> URL:
    """Accept provider PostgreSQL URLs, but always use psycopg 3."""
    if value.startswith("postgres://"):
        value = "postgresql://" + value[len("postgres://"):]
    try:
        url = make_url(value)
    except Exception:
        raise ValueError("Invalid PostgreSQL URL") from None
    if url.drivername not in {"postgresql", "postgresql+psycopg"} or not url.database:
        raise ValueError("Use a PostgreSQL database URL with the psycopg driver")
    return url.set(drivername="postgresql+psycopg")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / ".env", env_file_encoding="utf-8", extra="ignore",
        hide_input_in_errors=True,
    )

    app_env: Literal["development", "test", "production"] = "development"
    database_url: SecretStr | None = None
    migration_database_url: SecretStr | None = None
    cors_origins: list[str] = Field(default_factory=lambda: [
        "http://localhost:5173", "http://127.0.0.1:5173",
    ])
    trusted_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1", "testserver"])
    db_connect_timeout: int = Field(default=3, ge=1, le=30)
    db_pool_size: int = Field(default=5, ge=1, le=30)
    db_max_overflow: int = Field(default=5, ge=0, le=30)
    db_pool_timeout: int = Field(default=5, ge=1, le=60)
    db_statement_timeout_ms: int = Field(default=5000, ge=100, le=60000)
    frontend_origin: str = "http://localhost:5173"
    google_redirect_uri: str = "http://localhost:5173/api/auth/google/callback"
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    session_lifetime_seconds: int = Field(default=604800, ge=60, le=2592000)
    session_idle_seconds: int = Field(default=86400, ge=60, le=604800)

    @model_validator(mode="after")
    def auth_configuration(self) -> "Settings":
        self.validate_origins([self.frontend_origin])
        front, callback = urlsplit(self.frontend_origin), urlsplit(self.google_redirect_uri)
        if (callback.scheme, callback.netloc) != (front.scheme, front.netloc):
            raise ValueError("Serve API through the frontend origin (/api proxy) for Safari cookies")
        if callback.path != "/api/auth/google/callback" or callback.query or callback.fragment:
            raise ValueError("Use the exact /api/auth/google/callback redirect URI")
        if front.scheme != "https" and (self.app_env == "production" or front.hostname not in {"localhost", "127.0.0.1"}):
            raise ValueError("Authentication requires HTTPS except on loopback development")
        if bool(self.google_client_id) != bool(self.google_client_secret):
            raise ValueError("Configure both Google client ID and client secret")
        return self

    @property
    def secure_cookies(self) -> bool:
        return self.frontend_origin.startswith("https://")

    @property
    def session_cookie(self) -> str:
        return "__Host-adamlife_session" if self.secure_cookies else "adamlife_session"

    @property
    def flow_cookie(self) -> str:
        return "__Host-adamlife_login" if self.secure_cookies else "adamlife_login"

    @field_validator("database_url", "migration_database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None:
            postgres_url(value.get_secret_value())
        return value

    @field_validator("cors_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        for origin in origins:
            parts = urlsplit(origin)
            if (parts.scheme not in {"http", "https"} or not parts.hostname
                or parts.username or parts.password or parts.path or parts.query
                or parts.fragment or "*" in origin):
                raise ValueError("CORS requires exact HTTP(S) origins without paths or wildcards")
        return origins

    @field_validator("trusted_hosts")
    @classmethod
    def validate_hosts(cls, hosts: list[str]) -> list[str]:
        if not hosts or any(not host or ":" in host or "/" in host or "*" in host for host in hosts):
            raise ValueError("Specify exact trusted hostnames, without ports or wildcards")
        return hosts

    @model_validator(mode="after")
    def production_configuration(self) -> "Settings":
        if self.app_env == "production":
            if self.database_url is None or not self.cors_origins:
                raise ValueError("Production requires DATABASE_URL and explicit CORS_ORIGINS")
            url = self.runtime_url()
            if url.query.get("sslmode") not in {"require", "verify-ca", "verify-full"}:
                raise ValueError("Production PostgreSQL requires TLS (prefer verify-full)")
            if any(not origin.startswith("https://") for origin in self.cors_origins):
                raise ValueError("Production CORS origins must use HTTPS")
            if any(host in {"localhost", "127.0.0.1", "testserver"} for host in self.trusted_hosts):
                raise ValueError("Production requires explicit public TRUSTED_HOSTS")
        return self

    def runtime_url(self) -> URL:
        if self.database_url is None:
            raise ValueError("DATABASE_URL is not configured")
        return postgres_url(self.database_url.get_secret_value())

    def migration_url(self) -> URL:
        if self.migration_database_url is None:
            raise ValueError("Set MIGRATION_DATABASE_URL for online migrations")
        return postgres_url(self.migration_database_url.get_secret_value())
