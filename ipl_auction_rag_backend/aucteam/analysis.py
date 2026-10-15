"""
analysis.py
Everything AUCTEAM concludes about an eleven: the live check, the metrics, the
grade, and the report -- written by the configured language model when there
is one, and by rule when there is not.

THE DIVISION OF LABOUR
======================

Arithmetic is never delegated. The metrics, the hard-rule check, the score and
the grade are computed here, deterministically, from the players table. The
model is handed those numbers and asked to *write*: to explain the balance, the
experience ratio, the missing links and the avoidable picks in prose. Two
consequences, both deliberate:

* The same eleven always earns the same grade, whichever provider answered and
  whether one answered at all. A grade that moved with the model's temperature
  would be a mood, not an assessment.
* Every sentence the model writes can be checked against a number in the
  payload it was given. It is told not to introduce any other.

THE FALLBACK
============

`local_report` writes the whole report from the same findings by rule, in the
spirit of rag/local_analyst.py: it says less than a model would, but nothing it
says is invented. It is used when no provider is configured, when every rung of
the ladder fails, or when the model's reply is not the JSON it was asked for --
and the reason is named in `notes`, so the badge on the report tells the truth.
"""
from __future__ import annotations

import json
import logging
import re
from statistics import mean
from typing import Any

from aucteam.aucteam_schema import (
    MAX_OVERSEAS,
    MIN_BOWLING_OPTIONS,
    MIN_WICKETKEEPERS,
    ROLE_BANDS,
    ROLE_NAMES,
    SQUAD_SIZE,
    TIER_NAMES,
    AucteamPlayer,
    ReportSection,
    RosterIssue,
    TeamMetrics,
    TeamReport,
)

logger = logging.getLogger(__name__)

#: The SCOUT drawer's question limit (scout/schemas/queries.py).
SCOUT_PROMPT_LIMIT = 500

#: A batting strike rate at which a player counts as a power hitter.
POWER_HITTER_SR = 140.0

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _stat(player: AucteamPlayer, key: str) -> float | None:
    for stat in player.stats:
        if stat.key == key:
            return stat.value
    return None


def compute_metrics(roster: list[AucteamPlayer]) -> TeamMetrics:
    """Every figure the report may mention, from the roster alone."""
    roles = {code: 0 for code in ROLE_BANDS}
    tiers = {code: 0 for code in TIER_NAMES}
    for player in roster:
        roles[player.role] += 1
        tiers[player.tier] += 1

    matches = [player.matches or 0 for player in roster]
    size = len(roster)

    batting_avgs = sorted(
        (v for p in roster if p.role != "BWL" and (v := _stat(p, "bat_avg")) is not None),
        reverse=True,
    )
    economies = [v for p in roster if p.role == "BWL" and (v := _stat(p, "economy")) is not None]

    by_matches = sorted(roster, key=lambda p: p.matches or 0)

    return TeamMetrics(
        size=size,
        role_counts=roles,
        tier_counts=tiers,
        overseas=sum(1 for p in roster if p.overseas),
        uncapped=sum(1 for p in roster if not p.capped),
        total_matches=sum(matches),
        avg_matches=round(mean(matches), 1) if matches else 0.0,
        marquee_share=round(tiers["MQ"] / size, 3) if size else 0.0,
        emerging_share=round(tiers["EM"] / size, 3) if size else 0.0,
        bowling_options=roles["BWL"] + roles["AR"],
        power_hitters=sum(
            1 for p in roster
            if p.role != "BWL" and (_stat(p, "bat_sr") or 0) >= POWER_HITTER_SR
        ),
        top_order_avg=round(mean(batting_avgs[:4]), 1) if batting_avgs else None,
        bowling_economy=round(mean(economies), 2) if economies else None,
        most_capped=by_matches[-1].name if roster else None,
        least_capped=by_matches[0].name if roster else None,
    )


# ---------------------------------------------------------------------------
# The live check
# ---------------------------------------------------------------------------


def check_roster(roster: list[AucteamPlayer], metrics: TeamMetrics) -> list[RosterIssue]:
    """
    Hard-rule breaches as `block`, shape problems as `warn`, observations as
    `info`. A role-count warning is only raised once the board is nearly full:
    two batters out of four picks is a draft in progress, not a flaw.
    """
    issues: list[RosterIssue] = []
    size = metrics.size
    remaining = SQUAD_SIZE - size

    if metrics.overseas > MAX_OVERSEAS:
        issues.append(RosterIssue(
            severity="block", code="overseas",
            message=f"{metrics.overseas} overseas players picked; a playing XI allows {MAX_OVERSEAS}.",
        ))

    wks = metrics.role_counts["WK"]
    if wks < MIN_WICKETKEEPERS and remaining < MIN_WICKETKEEPERS:
        issues.append(RosterIssue(
            severity="block", code="no_keeper",
            message="No wicketkeeper picked, and no slot left to add one.",
        ))
    elif wks < MIN_WICKETKEEPERS and size >= 7:
        issues.append(RosterIssue(
            severity="warn", code="keeper_pending",
            message="Still no wicketkeeper — keep a slot for one.",
        ))

    for role, (low, high) in ROLE_BANDS.items():
        count = metrics.role_counts[role]
        name = ROLE_NAMES[role].lower() + ("s" if high != 1 else "")
        if count > high:
            issues.append(RosterIssue(
                severity="warn", code=f"too_many_{role.lower()}",
                message=f"{count} {name}; a balanced XI carries at most {high}.",
            ))
        # Short only matters once there is no room left to fix it.
        elif count + remaining < low:
            issues.append(RosterIssue(
                severity="warn", code=f"too_few_{role.lower()}",
                message=f"Only {count} {name}; a balanced XI carries at least {low}.",
            ))

    if metrics.bowling_options + remaining < MIN_BOWLING_OPTIONS:
        issues.append(RosterIssue(
            severity="warn", code="bowling_options",
            message=(
                f"{metrics.bowling_options} bowling options; twenty overs need "
                f"at least {MIN_BOWLING_OPTIONS} bowlers and all-rounders."
            ),
        ))

    if size >= 6:
        if metrics.marquee_share > 0.55:
            issues.append(RosterIssue(
                severity="warn", code="ageing",
                message="Over half the side is Marquee — a lot of experience, little legs in the field.",
            ))
        if metrics.emerging_share > 0.45:
            issues.append(RosterIssue(
                severity="warn", code="green",
                message="Nearly half the side is Emerging — upside, but thin on match-winning experience.",
            ))
    if size == SQUAD_SIZE and metrics.tier_counts["MQ"] == 0:
        issues.append(RosterIssue(
            severity="info", code="no_marquee",
            message="No Marquee player: nobody in the side has carried a franchise.",
        ))

    return issues


def is_legal(issues: list[RosterIssue]) -> bool:
    return not any(issue.severity == "block" for issue in issues)


# ---------------------------------------------------------------------------
# The SCOUT hand-off
# ---------------------------------------------------------------------------


def _short(name: str) -> str:
    """'Virat Kohli' -> 'Kohli'; 'MS Dhoni' -> 'Dhoni'. Surnames keep the prompt short."""
    parts = name.split()
    return parts[-1] if parts else name


def scout_prompt(roster: list[AucteamPlayer], metrics: TeamMetrics) -> str:
    """
    A question for the SCOUT drawer with the roster written into it, kept
    under the drawer's 500-character limit by shortening names, then dropping
    the role tags, then truncating the list -- never the question itself.
    """
    ask = (
        f" ({metrics.tier_counts['MQ']} MQ/{metrics.tier_counts['PR']} PR/"
        f"{metrics.tier_counts['EM']} EM, {metrics.overseas} overseas). "
    )
    if metrics.size < SQUAD_SIZE:
        ask += (
            f"{SQUAD_SIZE - metrics.size} slots left. How should I balance experience "
            "and youth, and which role should I fill next?"
        )
    else:
        ask += "Is the experience-to-youth balance right, and what is my weakest link?"

    head = "My AUCTEAM XI so far: " if metrics.size < SQUAD_SIZE else "My AUCTEAM XI: "
    for render in (
        lambda p: f"{_short(p.name)} ({p.tier} {p.role})",
        lambda p: f"{_short(p.name)} ({p.tier})",
        lambda p: _short(p.name),
    ):
        text = head + ", ".join(render(p) for p in roster) + ask
        if len(text) <= SCOUT_PROMPT_LIMIT:
            return text
    budget = SCOUT_PROMPT_LIMIT - len(head) - len(ask) - 1
    names = ", ".join(_short(p.name) for p in roster)
    return head + names[: max(budget, 0)].rstrip(", ") + "…" + ask


# ---------------------------------------------------------------------------
# Grade
# ---------------------------------------------------------------------------


def score_team(metrics: TeamMetrics, issues: list[RosterIssue]) -> tuple[int, str]:
    """
    A 0-100 score and its A-D grade, by rule. Penalties, not bonuses: a sound
    eleven starts at 100 and loses marks for each named weakness, so every
    point lost corresponds to a line the report can point to.
    """
    score = 100
    for role, (low, high) in ROLE_BANDS.items():
        count = metrics.role_counts[role]
        score -= 6 * max(0, low - count) + 6 * max(0, count - high)
    score -= 8 * max(0, MIN_BOWLING_OPTIONS - metrics.bowling_options)
    if metrics.marquee_share > 0.55:
        score -= 8
    if metrics.emerging_share > 0.45:
        score -= 10
    if metrics.tier_counts["MQ"] == 0:
        score -= 5
    if metrics.power_hitters < 3:
        score -= 6 * (3 - metrics.power_hitters)
    if metrics.avg_matches < 25:
        score -= 8
    if metrics.top_order_avg is not None and metrics.top_order_avg < 28:
        score -= 6
    if metrics.bowling_economy is not None and metrics.bowling_economy > 9:
        score -= 6
    if any(issue.severity == "block" for issue in issues):
        score -= 30
    score = max(0, min(100, score))
    grade = "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D"
    return score, grade


# ---------------------------------------------------------------------------
# Findings shared by both writers
# ---------------------------------------------------------------------------


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def findings(roster: list[AucteamPlayer], metrics: TeamMetrics) -> dict[str, list[str]]:
    """
    Strengths, missing links and avoidable picks, each a sentence anchored to a
    figure. Both report writers start from these: the rule-based one prints
    them, the model is handed them as evidence.
    """
    strengths: list[str] = []
    missing: list[str] = []
    avoidable: list[str] = []

    veteran = max(roster, key=lambda p: p.matches or 0)
    if (veteran.matches or 0) >= 100:
        strengths.append(f"{veteran.name} brings {veteran.matches} IPL matches of know-how.")
    if metrics.top_order_avg is not None and metrics.top_order_avg >= 32:
        strengths.append(f"The top four bats average {metrics.top_order_avg} between them.")
    if metrics.power_hitters >= 4:
        strengths.append(f"{metrics.power_hitters} power hitters strike at {POWER_HITTER_SR:.0f}+.")
    if metrics.bowling_economy is not None and metrics.bowling_economy <= 8.2:
        strengths.append(f"The specialist bowlers concede {metrics.bowling_economy} an over.")
    if metrics.bowling_options >= 6:
        strengths.append(f"{metrics.bowling_options} bowling options give the captain room to manoeuvre.")
    if 0.15 <= metrics.marquee_share <= 0.4 and metrics.tier_counts["EM"] >= 1:
        strengths.append("Experience and youth are mixed in sensible proportion.")

    if metrics.role_counts["WK"] == 0:
        missing.append("No wicketkeeper.")
    if metrics.bowling_options < MIN_BOWLING_OPTIONS:
        missing.append(
            f"Only {metrics.bowling_options} bowling options — someone has to bowl overs they should not."
        )
    if metrics.role_counts["AR"] == 0:
        missing.append("No all-rounder, so batting depth and the fifth bowler cannot overlap.")
    if metrics.power_hitters < 3:
        missing.append(
            f"Power hitters (SR {POWER_HITTER_SR:.0f}+): only {metrics.power_hitters}. The death overs will stall."
        )
    if metrics.role_counts["BAT"] + metrics.role_counts["WK"] < 4:
        missing.append("Fewer than four specialist bats: one early collapse exposes the tail.")
    if metrics.tier_counts["MQ"] == 0:
        missing.append("No Marquee player to hold the side together in a tight chase.")
    pace_vs_spin = [
        (p, _stat(p, "sr_vs_fast"), _stat(p, "sr_vs_spin")) for p in roster if p.role != "BWL"
    ]
    spin_bashers = sum(1 for _, _, spin in pace_vs_spin if spin is not None and spin >= 140)
    if pace_vs_spin and spin_bashers == 0:
        missing.append("Nobody in the order strikes at 140+ against spin — the middle overs are a risk.")

    for role, (_, high) in ROLE_BANDS.items():
        picked = [p for p in roster if p.role == role]
        if len(picked) > high:
            weakest = min(picked, key=lambda p: (p.rating or 0, p.matches or 0))
            avoidable.append(
                f"A {_ordinal(len(picked))} {ROLE_NAMES[role].lower()} — {weakest.name} is the one to leave out."
            )
    unknowns = [p for p in roster if not p.matches]
    if len(unknowns) >= 2:
        avoidable.append(
            f"{len(unknowns)} picks with no IPL matches ({', '.join(p.name for p in unknowns)}): "
            "more than one untested player is a gamble."
        )
    if metrics.emerging_share > 0.45:
        avoidable.append("Leaning this hard on Emerging players; one or two is upside, five is a risk.")
    if metrics.marquee_share > 0.55:
        avoidable.append("Stacking Marquee names; the fielding and the death overs pay for it.")
    if metrics.overseas > MAX_OVERSEAS:
        avoidable.append(f"{metrics.overseas} overseas players — only {MAX_OVERSEAS} can take the field.")
    weak_bowlers = [
        p for p in roster
        if p.role == "BWL" and (econ := _stat(p, "economy")) is not None and econ >= 9.5
    ]
    for bowler in weak_bowlers[:2]:
        avoidable.append(f"{bowler.name} at an economy of {_stat(bowler, 'economy'):.2f}.")

    return {"strengths": strengths, "missing_links": missing, "avoidable": avoidable}


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" + ("" if n == 1 else "s")


def _pct(share: float) -> str:
    return f"{round(share * 100)}%"


def local_report(
    roster: list[AucteamPlayer],
    metrics: TeamMetrics,
    issues: list[RosterIssue],
    score: int,
    grade: str,
) -> dict[str, Any]:
    """The whole report by rule. Every sentence is a figure stated plainly."""
    found = findings(roster, metrics)
    roles = metrics.role_counts
    shape = (
        f"{_count(roles['BAT'], 'batter')}, {_count(roles['WK'], 'keeper')}, "
        f"{_count(roles['AR'], 'all-rounder')} and {_count(roles['BWL'], 'bowler')}"
    )
    warnings = [issue.message for issue in issues if issue.severity != "info"]
    balance_verdict = "Sound shape" if not warnings else "Shape needs work"
    tiers = metrics.tier_counts
    if metrics.marquee_share > 0.55:
        exp_verdict = "Top-heavy with experience"
    elif metrics.emerging_share > 0.45:
        exp_verdict = "Young and untested"
    else:
        exp_verdict = "Experience and youth in balance"

    return {
        "headline": f"Grade {grade}: {balance_verdict.lower()}, {exp_verdict.lower()}.",
        "summary": (
            f"This XI fields {shape}, with {_count(metrics.overseas, 'overseas player')} and "
            f"{metrics.total_matches} IPL matches between them ({metrics.avg_matches} a head). "
            f"It scores {score}/100 on balance, experience and coverage."
        ),
        "balance": {
            "title": "Team balance",
            "verdict": balance_verdict,
            "body": (
                f"{shape.capitalize()}: {metrics.bowling_options} bowling options and "
                f"{metrics.power_hitters} power hitters."
                + (" " + " ".join(warnings) if warnings else " Every role sits inside its band.")
            ),
        },
        "experience": {
            "title": "Experience vs youth",
            "verdict": exp_verdict,
            "body": (
                f"{tiers['MQ']} Marquee, {tiers['PR']} Prime and {tiers['EM']} Emerging — "
                f"{_pct(metrics.marquee_share)} veterans, {_pct(metrics.emerging_share)} prospects. "
                f"{metrics.most_capped} is the most experienced; {metrics.least_capped} the least."
            ),
        },
        **found,
    }


SYSTEM_PROMPT = """You are SCOUT, the analyst inside AUCTONIQ, an IPL auction simulator.
A user has built a fantasy playing XI. Write their team analysis report.

Rules:
- Use ONLY the figures in the payload. Do not introduce any statistic, record, form note or fact that is not there.
- The grade and score are already decided; explain them, do not change them.
- Be direct and specific: name players, quote their numbers.
- British spelling. No markdown.

Reply with a single JSON object and nothing else:
{
  "headline": "one punchy line, max 90 chars",
  "summary": "2-3 sentences on the side as a whole",
  "balance": {"title": "Team balance", "verdict": "max 6 words", "body": "3-4 sentences on role balance and bowling/batting coverage"},
  "experience": {"title": "Experience vs youth", "verdict": "max 6 words", "body": "3-4 sentences on the Marquee/Prime/Emerging mix"},
  "strengths": ["2-4 short sentences"],
  "missing_links": ["1-4 short sentences: what the side lacks"],
  "avoidable": ["1-4 short sentences: picks or patterns the user could have avoided, naming players"]
}"""


def _payload(
    roster: list[AucteamPlayer],
    metrics: TeamMetrics,
    issues: list[RosterIssue],
    score: int,
    grade: str,
) -> str:
    players = [
        {
            "name": p.name,
            "role": p.role_label,
            "tier": TIER_NAMES[p.tier],
            "overseas": p.overseas,
            "capped": p.capped,
            **{s.key: s.value for s in p.stats if s.value is not None},
        }
        for p in roster
    ]
    return json.dumps(
        {
            "grade": grade,
            "score": score,
            "metrics": metrics.model_dump(),
            "rule_findings": findings(roster, metrics),
            "issues": [issue.message for issue in issues],
            "players": players,
        },
        ensure_ascii=False,
    )


def _parse_reply(text: str) -> dict[str, Any]:
    """The model's JSON, tolerating a code fence; raises ValueError if unusable."""
    text = text.strip()
    fenced = re.search(r"\{.*\}", text, re.S)
    if not fenced:
        raise ValueError("no JSON object in the reply")
    data = json.loads(fenced.group(0))
    if not isinstance(data, dict):
        raise ValueError("reply is not an object")
    return data


def _merge(model: dict[str, Any], fallback: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """
    Take each field from the model if it is the right shape, else from the
    rule-based report. Returns the merged report and the fields replaced.
    """
    merged: dict[str, Any] = {}
    replaced: list[str] = []

    def use_fallback(key: str) -> None:
        merged[key] = fallback[key]
        replaced.append(key)

    for key in ("headline", "summary"):
        value = model.get(key)
        if isinstance(value, str) and value.strip():
            merged[key] = value.strip()[:400]
        else:
            use_fallback(key)
    for key in ("balance", "experience"):
        value = model.get(key)
        if isinstance(value, dict) and all(isinstance(value.get(k), str) and value[k].strip() for k in ("verdict", "body")):
            merged[key] = {
                "title": fallback[key]["title"],
                "verdict": value["verdict"].strip()[:80],
                "body": value["body"].strip()[:1200],
            }
        else:
            use_fallback(key)
    for key in ("strengths", "missing_links", "avoidable"):
        value = model.get(key)
        items = [v.strip()[:300] for v in value if isinstance(v, str) and v.strip()] if isinstance(value, list) else []
        if items:
            merged[key] = items[:5]
        else:
            use_fallback(key)
    return merged, replaced


def build_report(team_name: str | None, roster: list[AucteamPlayer]) -> TeamReport:
    """
    The finished report. Blocking: it may call a language model over HTTP, so
    the route runs it in a worker thread.
    """
    metrics = compute_metrics(roster)
    issues = check_roster(roster, metrics)
    score, grade = score_team(metrics, issues)
    fallback = local_report(roster, metrics, issues, score, grade)

    notes: list[str] = []
    body: dict[str, Any] = fallback
    mode = "local_analyst"

    try:
        from rag import llm_provider
    except Exception as exc:  # noqa: BLE001 - a missing optional dependency costs prose, not the report
        llm_provider = None  # type: ignore[assignment]
        notes.append(f"Language model unavailable ({type(exc).__name__}); report written by rule.")

    if llm_provider is not None and llm_provider.available():
        answered: list[str] = []
        try:
            reply = llm_provider.complete(
                SYSTEM_PROMPT,
                [{"role": "user", "content": _payload(roster, metrics, issues, score, grade)}],
                task="rag",
                temperature=0.4,
                max_tokens=1400,
                timeout=45.0,
                json_object=True,
                on_answer=answered.append,
            )
            body, replaced = _merge(_parse_reply(reply), fallback)
            mode = "llm"
            if answered:
                notes.append(f"Written by {answered[0]}.")
            if replaced:
                notes.append("Rule-based text used for: " + ", ".join(replaced) + ".")
        except llm_provider.LLMError as exc:
            notes.append(f"Language model failed ({exc}); report written by rule.")
        except (ValueError, json.JSONDecodeError) as exc:
            notes.append(f"Language model reply was not usable JSON ({exc}); report written by rule.")
    elif llm_provider is not None:
        notes.append("No language model is configured; report written by rule.")

    return TeamReport(
        grade=grade,  # type: ignore[arg-type]
        score=score,
        headline=body["headline"],
        summary=body["summary"],
        balance=ReportSection(**body["balance"]),
        experience=ReportSection(**body["experience"]),
        strengths=body["strengths"],
        missing_links=body["missing_links"],
        avoidable=body["avoidable"],
        mode=mode,  # type: ignore[arg-type]
        notes=notes,
        metrics=metrics,
        issues=issues,
        roster=roster,
        team_name=team_name,
    )
