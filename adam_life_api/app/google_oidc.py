"""Google-only OIDC adapter. No provider URLs or key locations come from tokens/users."""
import hmac
from threading import Lock
from time import monotonic

import httpx
import jwt

from app.config import Settings
from app.errors import APIError

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"


class GoogleOIDC:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.http = httpx.Client(timeout=8, follow_redirects=False, trust_env=False)
        self._keys = {}
        self._until = 0.0
        self._lock = Lock()

    def close(self):
        self.http.close()

    def key(self, kid: str):
        with self._lock:
            if monotonic() >= self._until or kid not in self._keys:
                response = self.http.get(JWKS_URL)
                response.raise_for_status()
                keys = jwt.PyJWKSet.from_dict(response.json()).keys
                self._keys = {k.key_id: k.key for k in keys if k.key_type == "RSA" and k.algorithm_name == "RS256"}
                self._until = monotonic() + 300
            if kid not in self._keys:
                raise ValueError("Unknown signing key")
            return self._keys[kid]

    def verify(self, encoded: str, nonce: str) -> dict:
        if not isinstance(encoded, str) or len(encoded) > 16384:
            raise ValueError("Invalid token")
        header = jwt.get_unverified_header(encoded)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise ValueError("Invalid signing algorithm")
        claims = jwt.decode(
            encoded, self.key(header["kid"]), algorithms=["RS256"],
            audience=self.settings.google_client_id,
            issuer=["https://accounts.google.com", "accounts.google.com"],
            options={"require": ["iss", "aud", "sub", "exp", "iat", "nonce"]},
            leeway=30,
        )
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub or len(sub) > 255:
            raise ValueError("Invalid subject")
        if not isinstance(claims["nonce"], str) or not claims["nonce"].isascii() or not hmac.compare_digest(claims["nonce"], nonce):
            raise ValueError("Invalid nonce")
        aud = claims["aud"]
        if (isinstance(aud, list) and len(aud) > 1 and not claims.get("azp")) or (
            "azp" in claims and claims["azp"] != self.settings.google_client_id
        ):
            raise ValueError("Invalid authorized party")
        return claims

    def exchange(self, code: str, verifier: str, nonce: str) -> dict:
        try:
            response = self.http.post(TOKEN_URL, data={
                "grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                "redirect_uri": self.settings.google_redirect_uri,
                "client_id": self.settings.google_client_id,
                "client_secret": self.settings.google_client_secret.get_secret_value(),
            })
            response.raise_for_status()
            # Access/refresh tokens are not stored, logged, or returned to the frontend.
            return self.verify(response.json()["id_token"], nonce)
        except (httpx.HTTPError, jwt.PyJWTError, ValueError, KeyError, TypeError):
            raise APIError(400, "GOOGLE_LOGIN_FAILED", "Google sign-in could not be verified") from None
