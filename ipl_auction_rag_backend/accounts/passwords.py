"""
passwords.py
Storing passwords so a copy of the database does not give them away.

scrypt from the standard library rather than a dependency: it is a memory-hard
key-derivation function built for exactly this, and hashlib has carried it
since Python 3.6. Each password gets its own random salt, and the stored string
records the parameters, so they can be raised later without invalidating the
hashes already stored -- `verify` reads them back from the string.

    scrypt$<n>$<r>$<p>$<salt, base64>$<hash, base64>
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

N, R, P = 2**14, 8, 1  # ~16 MB and a few tens of ms per hash
DKLEN = 32


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=N, r=R, p=P, dklen=DKLEN)
    return f"scrypt${N}${R}${P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Whether `password` matches `stored`. Constant-time; False for anything malformed."""
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# A hash to check against when no account has the email, so a login for an
# unknown address costs as long as one for a known address with a wrong
# password: response time does not reveal which emails are registered.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
