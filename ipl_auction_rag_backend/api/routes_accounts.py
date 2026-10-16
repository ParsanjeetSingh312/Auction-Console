"""
routes_accounts.py
Registering, logging in and out, and "who am I", under /api/v1/accounts.

    POST /register   name, email, password, role -> the account, logged in
    POST /login      email, password             -> the account, logged in
    POST /logout                                 -> logged out
    GET  /me                                     -> the account, or 401

The session rides in an httpOnly cookie, so page scripts cannot read it, and it
is sent on the auction WebSocket's handshake as well -- which is how the room
knows whose account a connection is (auction/ws.py), with nothing in any
message for a client to lie about.

A role is chosen at registration and is what the account may do in Live
Bidding: an auctioneer account creates and runs rooms, a delegate account takes
a franchise seat and bids, a member account (the free tier) does neither. The
server enforces it; the client only displays it.
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import defaultdict, deque
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from accounts import store
from accounts.passwords import DUMMY_HASH, hash_password, verify_password
from accounts.store import Account, EmailTaken, Role
from config.settings import get_settings

router = APIRouter(prefix="/api/v1/accounts", tags=["Accounts"])

COOKIE = "auctoniq_session"

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Failed logins allowed per address, and per email, in the window.
FAILURES_ALLOWED = 10
FAILURE_WINDOW = 10 * 60
_failures: dict[str, deque[float]] = defaultdict(deque)


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=200)
    role: Role

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Enter your name.")
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL.match(value):
            raise ValueError("Enter a valid email address.")
        return value


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=200)


# ------------------------------------------------------------- helpers --


def _set_session(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=store.SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        # Behind Railway's proxy the scheme comes from X-Forwarded-Proto
        # (uvicorn runs with proxy headers), so this is True in production and
        # False on http://localhost, where a Secure cookie would never be sent.
        secure=request.url.scheme == "https",
        path="/",
    )


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _too_many(*keys: str) -> bool:
    now = time.monotonic()
    for key in keys:
        attempts = _failures[key]
        while attempts and now - attempts[0] > FAILURE_WINDOW:
            attempts.popleft()
        if len(attempts) >= FAILURES_ALLOWED:
            return True
    return False


def _failed(*keys: str) -> None:
    now = time.monotonic()
    for key in keys:
        _failures[key].append(now)


def account_from_request(request: Request) -> Account | None:
    return store.account_for_session(request.cookies.get(COOKIE))


def origin_allowed(origin: str | None, host: str | None) -> bool:
    """
    Whether a WebSocket handshake from `origin` may carry the session.

    SameSite=Lax already keeps the cookie off another site's handshake; this is
    the second lock. Same host as the server (production, where the API serves
    the page) or a configured CORS origin (the Vite dev server).
    """
    if not origin:
        return True  # not a browser, so no cookie to have been carried along
    allowed = {o.strip().rstrip("/") for o in get_settings().CORS_ORIGINS.split(",") if o.strip()}
    if origin.rstrip("/") in allowed:
        return True
    return bool(host) and urlparse(origin).netloc == host


# ------------------------------------------------------------ endpoints --


@router.post("/register")
async def register(payload: RegisterRequest, request: Request, response: Response) -> dict[str, Any]:
    # An administrator's address is reserved once it is listed, so nobody can
    # register it and inherit admin (see ADMIN_EMAILS in config/settings.py).
    if payload.email in store.admin_emails():
        raise HTTPException(status_code=403, detail="That email is reserved. Log in instead.")
    password_hash = await asyncio.to_thread(hash_password, payload.password)
    try:
        account = await asyncio.to_thread(
            store.create_account, payload.email, payload.name, payload.role, password_hash
        )
    except EmailTaken:
        raise HTTPException(status_code=409, detail="An account with that email already exists. Log in instead.")
    token = await asyncio.to_thread(store.open_session, account.id)
    _set_session(response, request, token)
    return {"account": account.public()}


@router.post("/login")
async def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    email = payload.email.strip().lower()
    keys = (f"ip:{_client(request)}", f"email:{email}")
    if _too_many(*keys):
        raise HTTPException(status_code=429, detail="Too many attempts. Wait a few minutes and try again.")
    found = await asyncio.to_thread(store.account_with_password, email)
    # The same work, and the same answer, for an unknown email as for a wrong
    # password: neither the message nor the timing says which emails exist.
    stored = found[1] if found else DUMMY_HASH
    ok = await asyncio.to_thread(verify_password, payload.password, stored)
    if not found or not ok:
        _failed(*keys)
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    account = found[0]
    token = await asyncio.to_thread(store.open_session, account.id)
    _set_session(response, request, token)
    return {"account": account.public()}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    await asyncio.to_thread(store.close_session, request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(request: Request) -> dict[str, Any]:
    account = await asyncio.to_thread(account_from_request, request)
    if account is None:
        raise HTTPException(status_code=401, detail="Not logged in.")
    return {"account": account.public()}
