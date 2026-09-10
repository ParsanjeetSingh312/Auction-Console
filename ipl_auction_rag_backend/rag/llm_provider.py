"""
llm_provider.py
One door to whichever language model is configured.

The pipeline calls a model in three places — query routing, text-to-SQL, and
answer synthesis — and each used to construct a Groq client directly. That made
the provider a hardcoded assumption in three files. This module makes it a
setting instead: the call sites describe the completion they want, and the
provider is resolved from `.env` at call time.

Gemini is reached over its REST API with `httpx` rather than the
`google-generativeai` SDK. That is a deliberate choice: httpx is already a
dependency (Groq and huggingface_hub both pull it in), the request shape is
about fifteen lines, and adding an SDK to a machine that is currently having
trouble reaching package indexes is a poor trade for the abstraction it buys.

Both providers are supported at once. Whichever key is present wins; if both
are, `LLM_PROVIDER` decides, defaulting to Gemini.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

import httpx

from config.settings import get_settings

logger = logging.getLogger(__name__)

Provider = Literal["gemini", "groq", "none"]
Task = Literal["rag", "sql", "router"]

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Google AI Studio keys are 39 characters beginning `AIza`.
GEMINI_KEY_PREFIX = "AIza"
#: Groq keys begin `gsk_`.
GROQ_KEY_PREFIX = "gsk_"

#: Values that are present in .env but mean "unset".
_PLACEHOLDERS = {
    "", "none", "null", "todo", "changeme", "your_key_here", "your-key-here",
    "xxx", "xxxx", "<your_groq_api_key>", "<your_gemini_api_key>", "sk-...",
    "gsk_...", "aiza...",
}


class LLMError(RuntimeError):
    """A provider call failed. Carries a message fit to show a user."""


def _clean(value: str | None) -> str:
    raw = (value or "").strip()
    return "" if raw.lower() in _PLACEHOLDERS else raw


def gemini_key_ok(value: str | None) -> bool:
    """Whether a value looks like a Google AI Studio key."""
    key = _clean(value)
    return key.startswith(GEMINI_KEY_PREFIX) and len(key) >= 30


def groq_key_ok(value: str | None) -> bool:
    """Whether a value looks like a Groq key."""
    key = _clean(value)
    return key.startswith(GROQ_KEY_PREFIX) and len(key) >= 20


def active_provider() -> Provider:
    """
    Which provider will actually serve a request.

    Resolution order: an explicit `LLM_PROVIDER` wins if its key is usable;
    otherwise whichever key is well-formed. When both are configured Gemini is
    preferred, because that is the deliberate choice a user makes by adding the
    newer key alongside an existing one.
    """
    settings = get_settings()
    gemini = gemini_key_ok(settings.GEMINI_API_KEY)
    groq = groq_key_ok(settings.effective_rag_key)

    choice = (settings.LLM_PROVIDER or "auto").strip().lower()
    if choice == "gemini":
        return "gemini" if gemini else "none"
    if choice == "groq":
        return "groq" if groq else "none"

    if gemini:
        return "gemini"
    if groq:
        return "groq"
    return "none"


def available() -> bool:
    """True when some provider can be called."""
    return active_provider() != "none"


def model_for(task: Task) -> str:
    """
    The model name for a task under the active provider.

    Model names are provider-specific, so the Groq names in settings cannot be
    sent to Gemini and vice versa. Gemini 2.5 Flash handles all three tasks, so
    one setting covers them; Groq keeps its per-task models.
    """
    settings = get_settings()
    if active_provider() == "gemini":
        return settings.GEMINI_MODEL
    return {
        "rag": settings.RAG_LLM_MODEL,
        "sql": settings.SQL_LLM_MODEL,
        "router": settings.ROUTER_LLM_MODEL,
    }[task]


def complete(
    system: str,
    messages: list[dict[str, str]],
    *,
    task: Task = "rag",
    temperature: float = 0.3,
    max_tokens: int = 1500,
    timeout: float = 60.0,
) -> str:
    """
    Run a chat completion against the active provider.

    `messages` uses the OpenAI-style shape — {"role": "user"|"assistant",
    "content": str} — which is translated for Gemini. Raises LLMError on any
    failure so callers have one exception type to handle rather than one per
    SDK.
    """
    provider = active_provider()
    if provider == "none":
        raise LLMError("No language model is configured.")

    if provider == "gemini":
        return _complete_gemini(system, messages, task, temperature, max_tokens, timeout)
    return _complete_groq(system, messages, task, temperature, max_tokens)


def _complete_gemini(
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
    timeout: float,
) -> str:
    settings = get_settings()
    model = model_for(task)

    # Gemini names the assistant role "model", and carries the system prompt in
    # its own field rather than as a first message.
    contents = [
        {
            "role": "model" if m.get("role") == "assistant" else "user",
            "parts": [{"text": m.get("content", "")}],
        }
        for m in messages
        if m.get("content")
    ]

    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            # 2.5 Flash reasons before answering by default, and those tokens
            # come out of maxOutputTokens. On a 20-token router call that
            # consumes the entire budget and returns an empty candidate, so
            # thinking is switched off: these are extraction and summarisation
            # tasks over data already retrieved, not problems that need it.
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    if system:
        payload["system_instruction"] = {"parts": [{"text": system}]}

    try:
        response = httpx.post(
            GEMINI_ENDPOINT.format(model=model),
            json=payload,
            headers={
                "x-goog-api-key": _clean(settings.GEMINI_API_KEY),
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise LLMError(f"Could not reach the Gemini API: {exc}") from exc

    if response.status_code != 200:
        # Google puts a usable explanation in error.message — an invalid key,
        # a disabled API, or an exhausted quota all land here and read very
        # differently, so the message is passed through rather than flattened.
        detail = response.text[:300]
        try:
            detail = response.json().get("error", {}).get("message", detail)
        except ValueError:
            pass
        raise LLMError(f"Gemini returned {response.status_code}: {detail}")

    data = response.json()
    candidates = data.get("candidates") or []
    if not candidates:
        blocked = data.get("promptFeedback", {}).get("blockReason")
        raise LLMError(
            f"Gemini returned no candidates (blocked: {blocked})"
            if blocked
            else "Gemini returned no candidates."
        )

    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts).strip()
    if not text:
        reason = candidates[0].get("finishReason", "unknown")
        raise LLMError(f"Gemini returned an empty answer (finishReason: {reason}).")

    return text


def _complete_groq(
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
) -> str:
    from groq import Groq  # imported lazily so Gemini users need not have it

    settings = get_settings()
    key = {
        "rag": settings.effective_rag_key,
        "sql": settings.effective_sql_key,
        "router": settings.effective_router_key,
    }[task]

    payload = ([{"role": "system", "content": system}] if system else []) + messages

    try:
        client = Groq(api_key=_clean(key))
        response = client.chat.completions.create(
            model=model_for(task),
            messages=payload,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except Exception as exc:  # noqa: BLE001 — the SDK raises a family of errors
        raise LLMError(f"Groq call failed: {exc}") from exc

    content = response.choices[0].message.content
    if not content or not content.strip():
        raise LLMError("Groq returned an empty answer.")
    return content.strip()


def describe() -> str:
    """One line naming the active provider and model, for logs and health."""
    provider = active_provider()
    if provider == "none":
        return "none (deterministic analyst)"
    return f"{provider} · {model_for('rag')}"
