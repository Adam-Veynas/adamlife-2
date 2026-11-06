import asyncio
from uuid import UUID

import httpx
import pytest
from fastapi import Query
from sqlalchemy.exc import IntegrityError, OperationalError

from app.errors import APIError
from app.main import create_app


@pytest.fixture
def client(settings):
    app = create_app(settings)

    # Test-only routes, never registered in the shipped application.
    @app.get("/test/validation")
    def validation(count: int = Query(gt=0)):
        return {"count": count}

    @app.get("/test/failure/{kind}")
    def failure(kind: str):
        secret = "DO_NOT_LEAK_PASSWORD_OR_SQL"
        if kind == "domain":
            raise APIError(409, "TEST_CONFLICT", "Test conflict")
        if kind == "db":
            raise OperationalError(secret, {}, Exception(secret))
        if kind == "constraint":
            raise IntegrityError(secret, {}, Exception(secret))
        raise RuntimeError(secret)

    # Use native HTTPX ASGI transport, not Starlette's deprecated HTTPX adapter.
    with asyncio.Runner() as runner:
        lifespan = app.router.lifespan_context(app)
        runner.run(lifespan.__aenter__())
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                 base_url="http://testserver")

        class LocalClient:
            def get(self, *args, **kwargs):
                return runner.run(http.get(*args, **kwargs))

            def post(self, *args, **kwargs):
                return runner.run(http.post(*args, **kwargs))

            def options(self, *args, **kwargs):
                return runner.run(http.options(*args, **kwargs))

        try:
            yield LocalClient()
        finally:
            runner.run(http.aclose())
            runner.run(lifespan.__aexit__(None, None, None))


def check_error(response, status, code):
    assert response.status_code == status
    error = response.json()["error"]
    assert error["code"] == code
    assert error["message"]
    assert isinstance(error["details"], list)
    assert str(UUID(error["request_id"])) == response.headers["X-Request-ID"]
    assert "DO_NOT_LEAK" not in response.text
    return error


def test_liveness_does_not_require_database(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "adamlife-api"}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_readiness_without_database_is_explicit_503(client):
    check_error(client.get("/health/ready"), 503, "DATABASE_NOT_READY")


@pytest.mark.parametrize("result", [True, False])
def test_readiness_uses_database_check(client, monkeypatch, result):
    monkeypatch.setattr("app.main.database_ready", lambda _: result)
    response = client.get("/health/ready")
    if result:
        assert response.json()["status"] == "ready"
        assert response.status_code == 200
    else:
        check_error(response, 503, "DATABASE_NOT_READY")


def test_database_connection_failure_is_sanitized(client, monkeypatch):
    def broken(_):
        raise OperationalError("secret-dsn", {}, Exception("password"))
    monkeypatch.setattr("app.main.database_ready", broken)
    response = client.get("/health/ready")
    check_error(response, 503, "DATABASE_NOT_READY")
    assert "password" not in response.text and "secret-dsn" not in response.text


@pytest.mark.parametrize(("path", "status", "code"), [
    ("/missing", 404, "HTTP_404"),
    ("/test/validation?count=private-value", 422, "VALIDATION_ERROR"),
    ("/test/validation?count=-1", 422, "VALIDATION_ERROR"),
    ("/test/failure/domain", 409, "TEST_CONFLICT"),
    ("/test/failure/db", 503, "DATABASE_UNAVAILABLE"),
    ("/test/failure/constraint", 409, "DATA_CONFLICT"),
    ("/test/failure/unexpected", 500, "INTERNAL_ERROR"),
])
def test_unified_errors(client, path, status, code):
    response = client.get(path)
    check_error(response, status, code)
    assert "private-value" not in response.text


def test_method_not_allowed_preserves_allow_header(client):
    response = client.post("/health")
    check_error(response, 405, "HTTP_405")
    assert "GET" in response.headers["allow"]


def test_request_ids_are_new_and_not_trusted_from_browser(client):
    first = client.get("/health", headers={"X-Request-ID": "untrusted"})
    second = client.get("/health")
    assert UUID(first.headers["X-Request-ID"])
    assert first.headers["X-Request-ID"] != second.headers["X-Request-ID"]


def test_untrusted_host_has_same_error_format(client):
    check_error(client.get("/health", headers={"host": "attacker.example"}), 400, "INVALID_HOST")


def test_cors_only_allows_explicit_origins_including_on_errors(client):
    for path in ["/health", "/missing", "/test/failure/unexpected"]:
        response = client.get(path, headers={"Origin": "http://localhost:5173"})
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert response.headers["access-control-allow-credentials"] == "true"
    response = client.get("/health", headers={"Origin": "https://attacker.example"})
    assert "access-control-allow-origin" not in response.headers


def test_cors_preflight_denial_is_json(client):
    denied = client.options("/health", headers={"Origin": "https://attacker.example", "Access-Control-Request-Method": "GET"})
    check_error(denied, 400, "CORS_REJECTED")
    allowed = client.options("/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert allowed.status_code == 200


def test_only_infrastructure_and_auth_routes_and_no_public_user_id_parameter(settings):
    app = create_app(settings)
    paths = app.openapi()["paths"]
    assert set(paths) == {"/health", "/health/ready", "/auth/config", "/auth/google/start",
                          "/auth/google/callback", "/auth/me", "/auth/logout", "/finance/bootstrap", "/finance/snapshot",
                          "/finance/accounts", "/finance/accounts/{identifier}", "/finance/categories",
                          "/finance/categories/{identifier}", "/finance/operations", "/finance/operations/{identifier}", "/finance/savings", "/finance/goals",
                          "/finance/goals/{identifier}", "/finance/goals/{identifier}/status", "/finance/deposit-plans/{identifier}"}
    assert all(p["name"] != "user_id" for path in paths.values() for op in path.values() for p in op.get("parameters", []))
