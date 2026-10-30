"""Opaque cookie sessions and single-use OIDC flows. All DB context is transaction-local."""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from sqlalchemy import delete, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth_models import AuthSession, LoginFlow
from app.errors import APIError
from app.google_oidc import AUTHORIZE_URL
from app.models import User

router = APIRouter(prefix="/auth", tags=["authentication"])
FLOW_SECONDS = 600


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def csrf_token(token: str) -> str:
    return hmac.new(token.encode("ascii"), b"adamlife-csrf-v1", hashlib.sha256).hexdigest()


def now():
    return datetime.now(timezone.utc)


def cookie_value(request: Request, name: str) -> str:
    value = request.cookies.get(name, "")
    # Bound untrusted inputs, and do not accept cookie tossing/ambiguous duplicates.
    pairs = [p.strip().split("=", 1)[0] for p in request.headers.get("cookie", "").split(";")]
    if pairs.count(name) != 1 or len(value) != 43 or not all(c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value):
        return ""
    return value


def context(session: Session, key: str, value: str):
    session.execute(text("SELECT set_config(:key, :value, true)"), {"key": key, "value": value})


def engine(request: Request):
    if request.app.state.engine is None:
        raise APIError(503, "DATABASE_UNAVAILABLE", "Database temporarily unavailable")
    return request.app.state.engine


def require_origin(request: Request):
    if request.headers.get("origin") != request.app.state.settings.frontend_origin:
        raise APIError(403, "CSRF_REJECTED", "Request origin is not permitted")


def put_cookie(response: Response, settings, name: str, value: str, age: int):
    response.set_cookie(name, value, max_age=age, httponly=True, secure=settings.secure_cookies,
                        samesite="lax", path="/")


def clear_cookie(response: Response, settings, name: str):
    response.delete_cookie(name, httponly=True, secure=settings.secure_cookies, samesite="lax", path="/")


def authenticated_session(request: Request):
    """Future finance endpoints use this dependency; never a browser-provided user_id."""
    settings = request.app.state.settings
    token = cookie_value(request, settings.session_cookie)
    if not token:
        raise APIError(401, "AUTH_REQUIRED", "Sign in to continue")
    with Session(engine(request), expire_on_commit=False) as session, session.begin():
        context(session, "app.session_hash", digest(token))
        row = session.scalar(select(AuthSession).with_for_update())
        current = now()
        if row is None or row.revoked_at is not None or row.expires_at <= current or (
            row.last_seen_at <= current - timedelta(seconds=settings.session_idle_seconds)
        ):
            raise APIError(401, "SESSION_EXPIRED", "Session has expired or been revoked")
        context(session, "app.user_id", str(row.user_id))
        user = session.get(User, row.user_id)
        if user is None:
            raise APIError(401, "AUTH_REQUIRED", "Sign in to continue")
        row.last_seen_at = current
        # Lock lasts through the request; logout cannot race a later authenticated mutation.
        yield session, row, user, token


@router.get("/config")
def config(request: Request):
    settings = request.app.state.settings
    return {"google_enabled": bool(settings.google_client_id and settings.google_client_secret)}


@router.post("/google/start")
def start(request: Request):
    require_origin(request)
    settings = request.app.state.settings
    if not settings.google_client_id or not settings.google_client_secret:
        raise APIError(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in has not been configured")
    token, state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(4))
    with Session(engine(request)) as session, session.begin():
        old = cookie_value(request, settings.flow_cookie)
        if old:
            context(session, "app.flow_hash", digest(old))
            session.execute(delete(LoginFlow))
        context(session, "app.flow_hash", digest(token))
        session.add(LoginFlow(token_hash=digest(token), state_hash=digest(state), nonce=nonce,
                              verifier=verifier, expires_at=now() + timedelta(seconds=FLOW_SECONDS)))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    url = AUTHORIZE_URL + "?" + urlencode({
        "client_id": settings.google_client_id, "redirect_uri": settings.google_redirect_uri,
        "response_type": "code", "scope": "openid email profile", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account",
    })
    response = JSONResponse({"authorization_url": url})
    put_cookie(response, settings, settings.flow_cookie, token, FLOW_SECONDS)
    return response


def finish_login(request: Request, claims: dict) -> str:
    settings = request.app.state.settings
    raw = secrets.token_urlsafe(32)
    with Session(engine(request)) as session, session.begin():
        context(session, "app.google_sub", claims["sub"])
        # Atomic upsert handles parallel first logins to the SAME Google subject.
        # An email change updates profile; equal emails never merge different subjects.
        email = claims.get("email") if claims.get("email_verified") is True else None
        if not isinstance(email, str) or len(email) > 320:
            email = None
        name = claims.get("name")
        name = name[:200] if isinstance(name, str) and name.strip() else "Пользователь"
        stmt = insert(User).values(id=uuid4(), google_sub=claims["sub"], email=email, display_name=name)
        uid = session.scalar(stmt.on_conflict_do_update(
            index_elements=[User.google_sub], set_={"email": email, "display_name": name}
        ).returning(User.id))
        context(session, "app.google_sub", "")
        old = cookie_value(request, settings.session_cookie)
        if old:
            context(session, "app.session_hash", digest(old))
            session.execute(update(AuthSession).values(revoked_at=now()))
        context(session, "app.session_hash", digest(raw))
        context(session, "app.user_id", str(uid))
        session.add(AuthSession(token_hash=digest(raw), user_id=uid,
                                expires_at=now() + timedelta(seconds=settings.session_lifetime_seconds)))
    return raw


@router.get("/google/callback")
def callback(request: Request):
    settings = request.app.state.settings
    target = settings.frontend_origin + "/"
    response = RedirectResponse(target + "?auth_error=failed", status_code=303)
    clear_cookie(response, settings, settings.flow_cookie)
    if not settings.google_client_id or not settings.google_client_secret:
        return response
    token = cookie_value(request, settings.flow_cookie)
    state = request.query_params.get("state", "")
    if not token or len(state) != 43 or len(request.query_params.getlist("state")) != 1:
        return response
    with Session(engine(request)) as session, session.begin():
        context(session, "app.flow_hash", digest(token))
        # DELETE RETURNING is atomic: only one callback can consume this flow.
        flow = session.execute(delete(LoginFlow).where(
            LoginFlow.state_hash == digest(state), LoginFlow.expires_at > now()
        ).returning(LoginFlow.nonce, LoginFlow.verifier)).first()
    if flow is None:
        return response
    if request.query_params.get("error"):
        response.headers["location"] = target + "?auth_error=cancelled"
        return response
    code = request.query_params.get("code", "")
    if not code or len(code) > 4096 or len(request.query_params.getlist("code")) != 1:
        return response
    try:
        claims = request.app.state.google.exchange(code, flow.verifier, flow.nonce)
    except APIError:
        return response
    raw = finish_login(request, claims)
    response.headers["location"] = target
    put_cookie(response, settings, settings.session_cookie, raw, settings.session_lifetime_seconds)
    return response


@router.get("/me")
def me(auth=Depends(authenticated_session, scope="function")):
    _, row, user, token = auth
    return {"user": {"id": str(user.id), "display_name": user.display_name, "email": user.email},
            "csrf_token": csrf_token(token), "expires_at": row.expires_at.isoformat()}


@router.post("/logout", status_code=204)
def logout(request: Request, auth=Depends(authenticated_session, scope="function")):
    require_origin(request)
    _, row, _, token = auth
    header = request.headers.get("x-csrf-token", "")
    if len(header) != 64 or not header.isascii() or not hmac.compare_digest(header, csrf_token(token)):
        raise APIError(403, "CSRF_REJECTED", "CSRF token is invalid")
    row.revoked_at = now()
    response = Response(status_code=204)
    settings = request.app.state.settings
    clear_cookie(response, settings, settings.session_cookie)
    clear_cookie(response, settings, settings.flow_cookie)
    return response
