"""Real PostgreSQL, real RSA signatures, mocked ONLY Google's external HTTP endpoints."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, timedelta
import hashlib
import json
from time import time
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends
import httpx
import jwt
import pytest
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.auth import authenticated_session, context, digest, now
from app.auth_models import AuthSession, LoginFlow
from app.config import Settings
from app.db import user_session
from app.google_oidc import GoogleOIDC, JWKS_URL, TOKEN_URL
from app.main import create_app
from app.models import Account, User
from test_postgres import pg_engine, runtime_engine  # guarded, empty *_test DB fixtures

pytestmark = pytest.mark.postgres
ORIGIN = "https://app.example.test"


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def oidc(runtime_engine, signing_key):
    settings = Settings(
        _env_file=None, app_env="test", database_url=runtime_engine.url.render_as_string(hide_password=False),
        frontend_origin=ORIGIN, google_redirect_uri=ORIGIN + "/api/auth/google/callback",
        trusted_hosts=["app.example.test"], cors_origins=[ORIGIN],
        google_client_id="test-client", google_client_secret="test-placeholder",
    )
    provider = GoogleOIDC(settings)
    provider.http.close()
    issued = {}
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key()))
    public.update(kid="key-1", alg="RS256", use="sig")

    def transport(request):
        if str(request.url) == JWKS_URL:
            return httpx.Response(200, json={"keys": [public]})
        assert str(request.url) == TOKEN_URL
        form = parse_qs(request.content.decode())
        record = issued.pop(form["code"][0], None)
        if record is None:
            return httpx.Response(400, json={"error": "invalid_grant"})
        assert form["redirect_uri"] == [settings.google_redirect_uri]
        assert form["client_id"] == [settings.google_client_id]
        assert form["client_secret"] == ["test-placeholder"]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"][0].encode()).digest()).rstrip(b"=").decode()
        if challenge != record["challenge"]:
            return httpx.Response(400, json={"error": "invalid_grant"})
        claims = dict(iss="https://accounts.google.com", aud="test-client", sub=record["sub"],
                      exp=int(time()) + 3600, iat=int(time()), nonce=record["nonce"],
                      email="same-email@example.test", email_verified=True, name="Тестовый пользователь")
        claims.update(record["overrides"])
        for key in record["remove"]:
            claims.pop(key, None)
        key = record.get("key") or signing_key
        token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "key-1"})
        return httpx.Response(200, json={"id_token": token, "access_token": "MUST_NOT_ESCAPE"})

    provider.http = httpx.Client(transport=httpx.MockTransport(transport), trust_env=False)
    yield settings, provider, issued
    provider.close()


class Browser:
    def __init__(self, app, runner, http, oidc):
        self.app, self.runner, self.http = app, runner, http
        self.settings, self.provider, self.issued = oidc

    def request(self, method, path, **kwargs):
        return self.runner.run(self.http.request(method, path, **kwargs))

    def start(self):
        response = self.request("POST", "/auth/google/start", headers={"Origin": ORIGIN})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        params = parse_qs(urlsplit(response.json()["authorization_url"]).query)
        assert params["code_challenge_method"] == ["S256"]
        assert params["scope"] == ["openid email profile"]
        return params

    def callback(self, params, sub=None, overrides=None, remove=(), key=None):
        code = str(uuid4())
        self.issued[code] = dict(challenge=params["code_challenge"][0], nonce=params["nonce"][0],
                                 sub=sub or str(uuid4()), overrides=overrides or {}, remove=remove, key=key)
        return self.request("GET", "/auth/google/callback", params={"code": code, "state": params["state"][0]})

    def login(self, sub=None, **kwargs):
        response = self.callback(self.start(), sub, **kwargs)
        assert response.status_code == 303 and response.headers["location"] == ORIGIN + "/"
        return self.request("GET", "/auth/me").json()

    def token(self):
        return self.http.cookies.get(self.settings.session_cookie)


@contextmanager
def browser(oidc):
    settings, provider, _ = oidc
    app = create_app(settings)

    @app.get("/test/accounts")
    def protected(auth=Depends(authenticated_session, scope="function")):
        session, _, _, _ = auth
        return [str(id) for id in session.scalars(select(Account.id))]

    with asyncio.Runner() as runner:
        lifespan = app.router.lifespan_context(app)
        runner.run(lifespan.__aenter__())
        app.state.google.close()
        app.state.google = provider
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, follow_redirects=False)
        try:
            yield Browser(app, runner, http, oidc)
        finally:
            runner.run(http.aclose())
            # The fixture owns the shared mock provider, not this app lifespan.
            app.state.google = GoogleOIDC(settings)
            runner.run(lifespan.__aexit__(None, None, None))


def alter_session(engine, token, **values):
    with Session(engine) as session, session.begin():
        context(session, "app.session_hash", digest(token))
        session.execute(update(AuthSession).values(**values))


def test_register_repeat_login_rotation_and_subject_not_email(oidc, runtime_engine):
    sub = str(uuid4())
    with browser(oidc) as client:
        first = client.login(sub)
        token = client.token()
        assert set(first) == {"user", "csrf_token", "expires_at"}
        second = client.login(sub, overrides={"email": "changed@example.test", "name": "Новое имя"})
        assert first["user"]["id"] == second["user"]["id"]
        assert second["user"]["email"] == "changed@example.test"
        assert client.token() != token
        with Session(runtime_engine) as session, session.begin():
            context(session, "app.session_hash", digest(token))
            assert session.scalar(select(AuthSession)).revoked_at is not None
    with browser(oidc) as other:
        third = other.login(overrides={"email": "changed@example.test"})
        assert third["user"]["id"] != first["user"]["id"]


def test_secure_cookie_flags_and_no_provider_tokens(oidc, runtime_engine):
    with browser(oidc) as client:
        response = client.callback(client.start())
        cookies = response.headers.get_list("set-cookie")
        assert any("__Host-adamlife_session=" in cookie for cookie in cookies)
        assert all("HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie and "Domain=" not in cookie for cookie in cookies)
        assert "MUST_NOT_ESCAPE" not in response.text
        raw = client.token()
        with Session(runtime_engine) as session, session.begin():
            context(session, "app.session_hash", digest(raw))
            assert session.scalar(select(AuthSession.token_hash)) == digest(raw) != raw


@pytest.mark.parametrize("origin", [None, "https://evil.example", "null"])
def test_login_csrf_origin(oidc, origin):
    with browser(oidc) as client:
        headers = {} if origin is None else {"Origin": origin}
        assert client.request("POST", "/auth/google/start", headers=headers).status_code == 403
        assert client.request("GET", "/auth/google/start").status_code == 405


def test_callback_bound_to_browser_and_single_use(oidc):
    with browser(oidc) as client, browser(oidc) as attacker:
        params = client.start()
        assert "auth_error=failed" in attacker.callback(params).headers["location"]
        assert client.callback(params).headers["location"] == ORIGIN + "/"
        assert "auth_error=failed" in client.callback(params).headers["location"]


@pytest.mark.parametrize("failure", ["state", "expired", "cancelled", "missing-code"])
def test_flow_failures(oidc, runtime_engine, failure):
    with browser(oidc) as client:
        params = client.start()
        if failure == "state":
            params["state"] = ["x" * 43]
        if failure == "expired":
            flow = client.http.cookies.get(client.settings.flow_cookie)
            with Session(runtime_engine) as session, session.begin():
                context(session, "app.flow_hash", digest(flow))
                session.execute(update(LoginFlow).values(expires_at=now() - timedelta(seconds=1)))
        if failure in {"cancelled", "missing-code"}:
            query = {"state": params["state"][0]}
            if failure == "cancelled":
                query["error"] = "access_denied"
            response = client.request("GET", "/auth/google/callback", params=query)
        else:
            response = client.callback(params)
        assert "auth_error=" in response.headers["location"]
        assert client.request("GET", "/auth/me").status_code == 401


@pytest.mark.parametrize("claims", [
    {"iss": "https://evil.example"}, {"aud": "another-client"}, {"exp": 1},
    {"iat": 4102444800}, {"nbf": 4102444800}, {"nonce": "wrong"}, {"sub": ""},
    {"azp": "another-client"}, {"aud": ["test-client", "another-client"]}, {"nonce": "не-ascii"},
])
def test_invalid_signed_claims_are_rejected(oidc, claims):
    with browser(oidc) as client:
        response = client.callback(client.start(), overrides=claims)
        assert "auth_error=failed" in response.headers["location"]
        assert client.request("GET", "/auth/me").status_code == 401


@pytest.mark.parametrize("claim", ["iss", "aud", "sub", "exp", "iat", "nonce"])
def test_missing_required_claims_are_rejected(oidc, claim):
    with browser(oidc) as client:
        assert "auth_error=failed" in client.callback(client.start(), remove=[claim]).headers["location"]


def test_forged_signature_is_rejected(oidc):
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with browser(oidc) as client:
        assert "auth_error=failed" in client.callback(client.start(), key=wrong_key).headers["location"]


def test_logout_csrf_and_revocation(oidc):
    with browser(oidc) as client:
        login = client.login()
        old = client.token()
        for headers in [{"Origin": ORIGIN}, {"Origin": "https://evil.example", "X-CSRF-Token": login["csrf_token"]}]:
            assert client.request("POST", "/auth/logout", headers=headers).status_code == 403
            assert client.request("GET", "/auth/me").status_code == 200
        assert client.request("POST", "/auth/logout", headers={"Origin": ORIGIN, "X-CSRF-Token": login["csrf_token"]}).status_code == 204
        assert client.request("GET", "/auth/me").status_code == 401
        assert client.request("GET", "/auth/me", headers={"cookie": client.settings.session_cookie + "=" + old}).status_code == 401


@pytest.mark.parametrize("mode", ["absolute", "idle", "revoked"])
def test_expired_or_revoked_sessions(oidc, runtime_engine, mode):
    with browser(oidc) as client:
        client.login()
        changes = {"absolute": {"expires_at": now() - timedelta(seconds=1)},
                   "idle": {"last_seen_at": now() - timedelta(days=2)},
                   "revoked": {"revoked_at": now()}}[mode]
        alter_session(runtime_engine, client.token(), **changes)
        result = client.request("GET", "/auth/me")
        assert result.status_code == 401
        assert "Max-Age=0" in result.headers["set-cookie"]


def test_two_users_rls_no_user_id_spoofing_and_pool_reset(oidc, runtime_engine):
    with browser(oidc) as first, browser(oidc) as second, browser(oidc) as anonymous:
        a, b = first.login(), second.login()
        ids = []
        for data in [a, b]:
            uid, aid = UUID(data["user"]["id"]), uuid4()
            with user_session(runtime_engine, uid) as session:
                session.add(Account(id=aid, user_id=uid, name="Auth test", kind="bank", currency="KZT",
                                    opening_balance_minor=0, opening_date=date(2026, 1, 1)))
            ids.append(str(aid))
        assert first.request("GET", "/test/accounts", params={"user_id": b["user"]["id"]},
                             headers={"X-User-ID": b["user"]["id"]}).json() == [ids[0]]
        assert second.request("GET", "/test/accounts").json() == [ids[1]]
        assert anonymous.request("GET", "/test/accounts", headers={"X-User-ID": a["user"]["id"]}).status_code == 401
        with Session(runtime_engine) as session:
            assert list(session.scalars(select(User))) == []
            assert list(session.scalars(select(AuthSession))) == []
            assert list(session.scalars(select(LoginFlow))) == []


def test_concurrent_first_login_is_one_user_with_independent_sessions(oidc):
    sub = str(uuid4())
    def login(_):
        with browser(oidc) as client:
            result = client.login(sub)
            return result["user"]["id"], client.token()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(login, range(4)))
    assert len({uid for uid, _ in results}) == 1
    assert len({token for _, token in results}) == 4


def test_parallel_callback_consumes_flow_once(oidc):
    with browser(oidc) as starter:
        params = starter.start()
        flow = starter.http.cookies.get(starter.settings.flow_cookie)
        def finish(_):
            with browser(oidc) as client:
                client.http.cookies.set(client.settings.flow_cookie, flow)
                return client.callback(params).headers["location"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(finish, range(2)))
        assert results.count(ORIGIN + "/") == 1
        assert sum("auth_error=failed" in item for item in results) == 1


def test_missing_configuration_during_callback_fails_closed(oidc):
    with browser(oidc) as client:
        params = client.start()
        client.settings.google_client_id = None
        client.settings.google_client_secret = None
        assert client.callback(params).headers["location"] == ORIGIN + "/?auth_error=failed"
        assert client.request("GET", "/auth/me").status_code == 401


def test_non_ascii_csrf_is_rejected_without_server_error(oidc):
    with browser(oidc) as client:
        client.login()
        response = client.request("POST", "/auth/logout", headers=[
            (b"Origin", ORIGIN.encode()), (b"X-CSRF-Token", b"\xff" * 64)])
        assert response.status_code == 403
        assert client.request("GET", "/auth/me").status_code == 200


@pytest.mark.parametrize("mode", ["malformed", "duplicate"])
def test_ambiguous_or_malformed_session_cookie(oidc, mode):
    with browser(oidc) as client:
        client.login()
        pair = client.settings.session_cookie + "=" + client.token()
        cookie = pair + "; " + pair if mode == "duplicate" else client.settings.session_cookie + "=bad"
        assert client.request("GET", "/auth/me", headers={"cookie": cookie}).status_code == 401


def test_unverified_email_is_not_saved_as_verified_profile(oidc):
    with browser(oidc) as client:
        assert client.login(overrides={"email_verified": False})["user"]["email"] is None


def test_wrong_pkce_verifier_cannot_create_session(oidc, runtime_engine):
    with browser(oidc) as client:
        params = client.start()
        token = client.http.cookies.get(client.settings.flow_cookie)
        with Session(runtime_engine) as session, session.begin():
            context(session, "app.flow_hash", digest(token))
            session.execute(update(LoginFlow).values(verifier="a" * 43))
        assert "auth_error=failed" in client.callback(params).headers["location"]
        assert client.request("GET", "/auth/me").status_code == 401


def test_session_survives_new_backend_instance_and_connection_pool(oidc):
    with browser(oidc) as first:
        identity = first.login()
        token = first.token()
    # A fresh FastAPI lifespan/engine has no in-memory authentication state.
    with browser(oidc) as restarted:
        response = restarted.request("GET", "/auth/me", headers={
            "cookie": restarted.settings.session_cookie + "=" + token})
        assert response.status_code == 200
        assert response.json()["user"] == identity["user"]
        assert response.json()["csrf_token"] == identity["csrf_token"]


def test_logout_does_not_revoke_another_browser_session(oidc):
    sub = str(uuid4())
    with browser(oidc) as first, browser(oidc) as second:
        a, b = first.login(sub), second.login(sub)
        assert a["user"]["id"] == b["user"]["id"]
        assert first.request("POST", "/auth/logout", headers={
            "Origin": ORIGIN, "X-CSRF-Token": a["csrf_token"]}).status_code == 204
        assert second.request("GET", "/auth/me").status_code == 200
