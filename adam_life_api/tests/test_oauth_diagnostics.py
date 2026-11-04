"""Bounded OAuth failure diagnostics; no live provider, secrets or database required."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import jwt
import pytest
from starlette.requests import Request

from app import auth
from app.config import Settings
from app.errors import APIError
from app.google_oidc import GoogleOIDC

MARKER = "PRIVATE_DO_NOT_LOG"


def settings():
    return Settings(_env_file=None, frontend_origin="https://app.example.test",
                    google_redirect_uri="https://app.example.test/api/auth/google/callback",
                    google_client_id=MARKER, google_client_secret=MARKER)


@pytest.mark.parametrize("failure,expected", [
    ("client", "stage=token_exchange type=HTTPStatusError status=401 reason=invalid_client"),
    ("grant", "stage=token_exchange type=HTTPStatusError status=400 reason=invalid_grant"),
    ("unknown", "reason=unknown"),
    ("timeout", "stage=token_exchange type=ReadTimeout"),
    ("signature", "stage=id_token_verification type=InvalidSignatureError"),
    ("jwks", "stage=id_token_verification type=HTTPStatusError status=503"),
])
def test_provider_diagnostics_preserve_generic_error_without_secrets(monkeypatch, caplog, failure, expected):
    provider = GoogleOIDC(settings())
    provider.http.close()

    def transport(request):
        if failure == "timeout":
            raise httpx.ReadTimeout(MARKER, request=request)
        if failure in {"client", "grant", "unknown"}:
            return httpx.Response(401 if failure == "client" else 400, json={
                "error": {"client": "invalid_client", "grant": "invalid_grant", "unknown": MARKER}[failure],
                "error_description": MARKER,
            })
        return httpx.Response(200, json={"id_token": MARKER})

    def verify(*args):
        if failure == "jwks":
            request = httpx.Request("GET", "https://example.test/" + MARKER)
            raise httpx.HTTPStatusError(MARKER, request=request, response=httpx.Response(503, request=request))
        raise jwt.InvalidSignatureError(MARKER)

    provider.http = httpx.Client(transport=httpx.MockTransport(transport))
    monkeypatch.setattr(provider, "verify", verify)
    try:
        with pytest.raises(APIError) as error:
            provider.exchange(MARKER, MARKER, MARKER)
        assert error.value.code == "GOOGLE_LOGIN_FAILED"
        assert expected in caplog.text
        assert MARKER not in caplog.text
        assert MARKER not in error.value.message
    finally:
        provider.close()


@pytest.mark.parametrize("failure,reason", [
    ("cookie", "missing_or_invalid_flow_cookie"),
    ("state", "invalid_state_format"),
    ("flow", "flow_expired_consumed_or_state_mismatch"),
    ("cancelled", "provider_cancelled"),
    ("code", "invalid_code_format"),
])
def test_callback_diagnostics_do_not_log_request(monkeypatch, caplog, failure, reason):
    config = settings()
    app = SimpleNamespace(state=SimpleNamespace(settings=config, engine=object()))
    cookie = b"" if failure == "cookie" else (config.flow_cookie + "=" + "a" * 43).encode()
    query = "state=" + (MARKER if failure == "state" else "s" * 43)
    if failure == "cancelled":
        query += "&error=" + MARKER
    elif failure != "code":
        query += "&code=" + MARKER
    request = Request({"type": "http", "app": app, "headers": [(b"cookie", cookie)],
                       "query_string": query.encode()})
    session = MagicMock()
    session.execute.return_value.first.return_value = None if failure == "flow" else SimpleNamespace(nonce=MARKER, verifier=MARKER)
    factory = MagicMock()
    factory.return_value.__enter__.return_value = session
    monkeypatch.setattr(auth, "Session", factory)
    response = auth.callback(request)
    assert response.status_code == 303
    assert response.headers["location"] == config.frontend_origin + "/?auth_error=" + ("cancelled" if failure == "cancelled" else "failed")
    assert reason in caplog.text
    assert MARKER not in caplog.text
    assert "Max-Age=0" in response.headers["set-cookie"]
