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

Three providers are supported at once, as a ladder rather than a choice.
`LLM_PROVIDER=auto` tries Anthropic, then Gemini, then Groq, moving to the next
rung when one fails *during* a request -- a 503 under load, an exhausted quota,
a key revoked this morning. Naming a provider pins it and turns the ladder off,
because an operator who names a vendor has made a decision that silent
substitution would undo.

This matters more than it looks. Three of Gemini's own Flash models were
returning 503 the day this was written, and the previous design checked only
whether a key existed at startup -- so a mid-request failure fell all the way
through to the deterministic analyst while a perfectly good second provider sat
configured and unused.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

import httpx

from config.settings import get_settings

logger = logging.getLogger(__name__)

Provider = Literal["hermes", "anthropic", "gemini", "groq", "none"]
Task = Literal["rag", "sql", "router"]

#: Ladder order for `LLM_PROVIDER=auto`. Anthropic leads because configuring it
#: costs money, which makes it the most deliberate signal an operator can send.
#:
#: Groq sits ahead of Gemini on measurement rather than preference. Both free
#: tiers were exercised on 2026-09-19:
#:
#:     groq   qwen/qwen3.8-27b   0.48s median, 0/5 failed, no daily cap hit
#:     gemini gemini-2.5-flash   2.00s median, but 20 requests PER DAY per
#:                               model on the free tier -- exhausted in an
#:                               afternoon, after which every call 429s
#:
#: A ladder that leads with an exhausted provider pays a wasted round trip on
#: every rung-one call, and a search makes three of them. Order by what can
#: actually answer. An operator who disagrees pins it with LLM_PROVIDER.
PROVIDER_ORDER: tuple[Provider, ...] = ("anthropic", "groq", "gemini")

#: Hermes is deliberately ABSENT from PROVIDER_ORDER. It is a teammate's box,
#: reached over an OpenAI-compatible endpoint, and it must never end up serving
#: the console's own search because someone filled in a URL. A caller asks for
#: it by name -- `complete(..., prefer="hermes")` -- and falls through to the
#: ordinary ladder when it does not answer.

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Google AI Studio keys are 39 characters beginning `AIza`.
GEMINI_KEY_PREFIX = "AIza"
#: Groq keys begin `gsk_`.
GROQ_KEY_PREFIX = "gsk_"
#: Anthropic keys begin `sk-ant-`. Checked for the same reason as the other two:
#: a wrong-provider paste otherwise surfaces as an opaque 401 mid-query rather
#: than as the configuration mistake it is.
ANTHROPIC_KEY_PREFIX = "sk-ant-"

#: Gemini models that answered a `thinkingConfig` with 400. Remembered for the
#: life of the process so the wasted round trip is paid once rather than on
#: every call -- which matters more than it sounds: routing runs on a lite
#: model, routing happens on every single query, and the free tier allows five
#: requests a minute. Retrying blindly turned one router call into two and
#: halved the number of questions a user could ask before hitting a 429.
#:
#: Deliberately a runtime observation rather than a hardcoded list of model
#: names: Google ships models faster than this file changes, and the whole
#: point of detecting the 400 was to avoid maintaining such a list.
_NO_THINKING_CONFIG: set[str] = set()

#: Values that are present in .env but mean "unset".
_PLACEHOLDERS = {
    "", "none", "null", "todo", "changeme", "your_key_here", "your-key-here",
    "xxx", "xxxx", "<your_groq_api_key>", "<your_gemini_api_key>", "sk-...",
    "gsk_...", "aiza...", "sk-ant-...", "<your_anthropic_api_key>",
    "sk-ant-your-key-here",
}


class LLMError(RuntimeError):
    """
    A provider call failed. Carries a message fit to show a user.

    `retriable` says whether trying a *different* provider could plausibly
    succeed. Almost everything is: a 503, an exhausted quota, a bad key and a
    dropped connection are all facts about one vendor. A safety block is not --
    it is a fact about the prompt, so retrying elsewhere buys the same refusal
    and, on a paid rung, buys it for money.
    """

    def __init__(self, message: str, *, retriable: bool = True) -> None:
        super().__init__(message)
        self.retriable = retriable


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


def anthropic_key_ok(value: str | None) -> bool:
    """Whether a value looks like an Anthropic key."""
    key = _clean(value)
    return key.startswith(ANTHROPIC_KEY_PREFIX) and len(key) >= 20


def hermes_configured() -> bool:
    """
    Whether a Hermes endpoint is even configured.

    Only the URL is checked. Hermes is open source and the usual ways of
    serving it want no key at all, so requiring one would refuse a working
    endpoint -- and there is no key format to validate against anyway.
    """
    return bool((get_settings().HERMES_API_BASE_URL or "").strip())


def provider_chain() -> list[Provider]:
    """
    Every provider worth trying for one request, best first.

    Under `auto` this is each configured provider in PROVIDER_ORDER. Under an
    explicit choice it is that provider alone -- naming one is a decision, and
    quietly serving the request from a vendor the operator did not name would
    undo it. An empty list means nothing is configured.
    """
    settings = get_settings()
    configured: dict[str, bool] = {
        "anthropic": anthropic_key_ok(settings.ANTHROPIC_API_KEY),
        "gemini": gemini_key_ok(settings.GEMINI_API_KEY),
        "groq": groq_key_ok(settings.effective_rag_key),
    }

    choice = (settings.LLM_PROVIDER or "auto").strip().lower()
    if choice in configured:
        return [choice] if configured[choice] else []  # type: ignore[list-item]
    return [p for p in PROVIDER_ORDER if configured[p]]


def active_provider() -> Provider:
    """
    Which provider serves a request first.

    The head of the chain. Kept as its own function because /health, the
    environment check and the RAG chain all ask this question and none of them
    care that there is a fallback behind it.
    """
    chain = provider_chain()
    return chain[0] if chain else "none"


def available() -> bool:
    """True when some provider can be called."""
    return active_provider() != "none"


def model_for(task: Task, provider: Provider | None = None) -> str:
    """
    The model name for a task under `provider`, defaulting to the active one.

    Model names are provider-specific, so a Groq name cannot be sent to Gemini
    and vice versa -- which is why the ladder re-resolves the model at each rung
    rather than carrying one name down it.

    Gemini splits only routing off. A three-way classification does not need the
    Flash model and the lite one answers it in roughly a quarter of the time,
    which comes off the front of every single query. Anthropic uses one model
    for all three, as Gemini used to, because that spread is not there.
    """
    settings = get_settings()
    provider = provider or active_provider()

    if provider == "hermes":
        # Two models on one endpoint: the advisor reasons about a squad under
        # a purse constraint, the researcher pulls fields out of a page. The
        # task names are the RAG chain's, so "rag" is the reasoning one.
        return (settings.HERMES_ADVISOR_MODEL if task == "rag"
                else settings.HERMES_RESEARCHER_MODEL)
    if provider == "anthropic":
        return settings.ANTHROPIC_MODEL
    if provider == "gemini":
        return settings.GEMINI_ROUTER_MODEL if task == "router" else settings.GEMINI_MODEL
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
    prefer: Provider | None = None,
    json_object: bool = False,
) -> str:
    """
    Run a chat completion against the active provider.

    `messages` uses the OpenAI-style shape - {"role": "user"|"assistant",
    "content": str} - which each transport translates. Raises LLMError on any
    failure so callers have one exception type to handle rather than one per SDK.

    Every configured provider is tried in turn. A caller sees the first answer
    that arrives, or one error naming every rung that failed -- which is the
    difference between "the assistant is down" and "here is what each vendor
    said", and the second is the one an operator can act on.
    """
    chain = provider_chain()

    # `prefer` puts one provider at the front without disturbing what follows.
    # This is how SCOUT asks for Hermes: it gets first refusal, and an
    # unreachable teammate's machine costs one failed rung rather than the
    # whole answer. Hermes can only arrive this way -- it is not in
    # PROVIDER_ORDER, so nothing reaches it by default.
    if prefer == "hermes" and hermes_configured():
        chain = ["hermes", *chain]
    elif prefer and prefer in chain:
        chain = [prefer, *[p for p in chain if p != prefer]]

    if not chain:
        raise LLMError("No language model is configured.", retriable=False)

    failures: list[str] = []
    for index, provider in enumerate(chain):
        try:
            return _dispatch(
                provider, system, messages, task, temperature, max_tokens, timeout,
                json_object,
            )
        except LLMError as exc:
            # A non-retriable failure is about the prompt, so the next rung
            # would refuse it too. Surface it rather than paying to confirm.
            if not exc.retriable:
                raise
            failures.append(f"{provider}: {exc}")
            remaining = chain[index + 1:]
            if remaining:
                logger.warning(
                    "%s failed (%s) - falling through to %s",
                    provider, exc, remaining[0],
                )

    raise LLMError("Every configured provider failed - " + " | ".join(failures))


def _dispatch(
    provider: Provider,
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
    timeout: float,
    json_object: bool = False,
) -> str:
    """One rung of the ladder. Split out so `complete` reads as the policy."""
    if provider == "hermes":
        return _complete_hermes(system, messages, task, temperature, max_tokens,
                                timeout, json_object)
    if provider == "anthropic":
        # Anthropic has no response_format; the prompt asks for JSON and the
        # caller validates it, which is what every rung ultimately relies on.
        return _complete_anthropic(
            system, messages, task, temperature, max_tokens, timeout
        )
    if provider == "gemini":
        return _complete_gemini(system, messages, task, temperature, max_tokens,
                                timeout, json_object)
    return _complete_groq(system, messages, task, temperature, max_tokens, json_object)


def _complete_gemini(
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
    timeout: float,
    json_object: bool = False,
) -> str:
    settings = get_settings()
    model = model_for(task, "gemini")

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

    generation: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_tokens,
        # Flash models reason before answering by default, and those tokens come
        # out of maxOutputTokens. On a 20-token router call that consumes the
        # entire budget and returns an empty candidate, so thinking is switched
        # off: these are extraction and summarisation tasks over data already
        # retrieved, not problems that need it.
        "thinkingConfig": {"thinkingBudget": 0},
    }
    # Already learned this model refuses it - do not spend a request finding out
    # again.
    if model in _NO_THINKING_CONFIG:
        generation.pop("thinkingConfig", None)

    if json_object:
        # Native structured output beats asking nicely: without it a reasoning
        # model spends its budget thinking and the JSON arrives truncated.
        generation["responseMimeType"] = "application/json"

    payload: dict[str, Any] = {"contents": contents, "generationConfig": generation}
    if system:
        payload["system_instruction"] = {"parts": [{"text": system}]}

    response = _gemini_post(payload, model, settings, timeout)

    # ...and the *lite* models reject thinkingConfig outright, with a bare 400
    # ("Request contains an invalid argument") that names no field. They have no
    # thinking to disable, so dropping it costs nothing. Retrying on the error
    # rather than consulting a list of model names keeps this correct as the
    # catalogue changes, which it does faster than this file will.
    if response.status_code == 400 and "thinkingConfig" in generation:
        _NO_THINKING_CONFIG.add(model)
        logger.info(
            "%s does not support thinkingConfig - retrying without it, and "
            "remembering for the rest of this process. The 400 logged above is "
            "this probe, not a failed query.",
            model,
        )
        generation.pop("thinkingConfig")
        response = _gemini_post(payload, model, settings, timeout)

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
        if blocked:
            raise LLMError(
                f"Gemini returned no candidates (blocked: {blocked})",
                retriable=False,
            )
        raise LLMError("Gemini returned no candidates.")

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
    json_object: bool = False,
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
            model=model_for(task, "groq"),
            messages=payload,
            temperature=temperature,
            max_tokens=max_tokens,
            # gpt-oss reasons before answering and those tokens come out of
            # max_tokens, so a long schema plus a long context leaves the JSON
            # truncated mid-object. Asking the API for a JSON object makes the
            # server guarantee the shape instead of the prompt requesting it.
            **({"response_format": {"type": "json_object"}} if json_object else {}),
        )
    except Exception as exc:  # noqa: BLE001 — the SDK raises a family of errors
        raise LLMError(f"Groq call failed: {exc}") from exc

    content = response.choices[0].message.content
    if not content or not content.strip():
        raise LLMError("Groq returned an empty answer.")
    return content.strip()


def _gemini_post(
    payload: dict[str, Any], model: str, settings: Any, timeout: float
) -> httpx.Response:
    """One Gemini request. Separate so the thinkingConfig retry can repeat it."""
    try:
        return httpx.post(
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


def _complete_hermes(
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
    timeout: float,
    json_object: bool = False,
) -> str:
    """
    A Hermes endpoint, over the OpenAI chat-completions shape.

    httpx rather than the OpenAI SDK, for the same reason Gemini is: the
    request is fifteen lines, httpx is already a dependency, and an SDK would
    add a package to reach an endpoint whose whole appeal is that it speaks a
    format everything already speaks.

    The timeout is the caller's, not the setting's. During a live lot the
    advisor passes what is left of its budget, and a remote host that has gone
    to sleep must cost that much and no more.
    """
    settings = get_settings()
    base = (settings.HERMES_API_BASE_URL or "").strip().rstrip("/")
    if not base:
        raise LLMError("HERMES_API_BASE_URL is not set.", retriable=True)

    key = _clean(settings.HERMES_API_KEY)
    # No header at all when there is no key: an unauthenticated server rejects
    # a bare "Bearer " rather than ignoring it.
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    payload: dict[str, Any] = {
        "model": model_for(task, "hermes"),
        "messages": ([{"role": "system", "content": system}] if system else []) + messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_object:
        payload["response_format"] = {"type": "json_object"}

    try:
        response = httpx.post(f"{base}/chat/completions", json=payload,
                              headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise LLMError(f"Could not reach Hermes at {base}: {exc}") from exc

    if response.status_code != 200:
        detail = response.text[:200].replace("\n", " ")
        raise LLMError(f"Hermes returned {response.status_code}: {detail}")

    try:
        choices = response.json().get("choices") or []
        text = (choices[0]["message"]["content"] or "").strip()
    except (ValueError, KeyError, IndexError) as exc:
        # A server that speaks "OpenAI-compatible" loosely lands here. Naming
        # the shape problem beats a KeyError three frames up.
        raise LLMError(f"Hermes returned an unreadable response: {exc}") from exc

    if not text:
        raise LLMError("Hermes returned an empty answer.")
    return text


def _complete_anthropic(
    system: str,
    messages: list[dict[str, str]],
    task: Task,
    temperature: float,
    max_tokens: int,
    timeout: float,
) -> str:
    from anthropic import Anthropic  # lazy, so Gemini users need not have it

    # `temperature` is accepted and honoured by the other two providers and is
    # deliberately not forwarded here: anthropic 1.6.0 removed it from
    # Messages.create(), which raises TypeError rather than ignoring it. The
    # nearest equivalent is output_config.effort ("low".."max"), which maps onto
    # the thinking budget the Gemini arm already sets to zero for router calls.
    # It is left alone until there is a key to test it against: a dormant arm
    # with an untested parameter is an arm that breaks on the day it is needed.
    settings = get_settings()

    # Anthropic carries the system prompt in its own parameter rather than as a
    # first message, rejects empty content, and requires the conversation to
    # open on a user turn. History arriving from /api/v1/chat can begin with an
    # assistant turn after a trim, so lead assistant turns are dropped rather
    # than sent to be refused.
    turns = [
        {
            "role": "assistant" if m.get("role") == "assistant" else "user",
            "content": m["content"],
        }
        for m in messages
        if (m.get("content") or "").strip()
    ]
    while turns and turns[0]["role"] == "assistant":
        turns.pop(0)
    if not turns:
        raise LLMError("No message content to send to Anthropic.", retriable=False)

    try:
        client = Anthropic(
            api_key=_clean(settings.ANTHROPIC_API_KEY),
            timeout=timeout,
            # The SDK retries failed calls on its own, and this function is
            # already one rung of a ladder that retries at a higher level. Left
            # at the default, a dead key cost 22 seconds of internal retrying
            # before the ladder was allowed to try Gemini -- three times the
            # auction's entire 7-second bid window. Failing fast here is what
            # makes the fallback worth having.
            max_retries=0,
        )
        response = client.messages.create(
            model=model_for(task, "anthropic"),
            max_tokens=max_tokens,
            messages=turns,  # type: ignore[arg-type]
            **({"system": system} if system else {}),
        )
    except Exception as exc:  # noqa: BLE001 - the SDK raises a family of errors
        raise LLMError(f"Anthropic call failed: {exc}") from exc

    if getattr(response, "stop_reason", None) == "refusal":
        raise LLMError("Anthropic declined to answer this prompt.", retriable=False)

    text = "".join(
        block.text
        for block in response.content
        if getattr(block, "type", "") == "text"
    ).strip()
    if not text:
        raise LLMError("Anthropic returned an empty answer.")
    return text


def describe() -> str:
    """
    One line naming who serves a request and who catches it, for logs and
    /health. The fallback is named because "gemini" and "gemini, then groq
    behind it" are different operational situations.
    """
    chain = provider_chain()
    if not chain:
        return "none (deterministic analyst)"
    line = f"{chain[0]} - {model_for('rag', chain[0])}"
    if len(chain) > 1:
        line += f" (falls back to {', '.join(chain[1:])})"
    return line
