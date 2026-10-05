"""Stateless signed session tokens.

A token proves the holder completed a broker connection for one MT account.
It carries no secrets (never the MT password) and is verified with HMAC-SHA256,
so the API stays authenticated across restarts/dynos without a session table.
"""
import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional

TOKEN_TTL_SECONDS = 7 * 24 * 3600


def _secret() -> bytes:
    raw = os.getenv("SESSION_SECRET") or os.getenv("ENCRYPTION_KEY") or ""
    if len(raw) < 16:
        # Refuse to sign with a guessable key in production-like setups.
        raise RuntimeError("Set SESSION_SECRET (or ENCRYPTION_KEY) to a random string of 16+ characters")
    return raw.encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign_token(claims: dict, ttl: int = TOKEN_TTL_SECONDS) -> str:
    body = dict(claims)
    body["exp"] = int(time.time()) + ttl
    payload = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_token(token: Optional[str]) -> Optional[dict]:
    if not token or token.count(".") != 1:
        return None
    payload, sig = token.split(".")
    expected = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        claims = json.loads(_unb64(payload))
    except Exception:
        return None
    if claims.get("exp", 0) < time.time():
        return None
    return claims
