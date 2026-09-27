"""
report_pdf.py
One franchise's closing report, as a PDF.

The analysis lives in `report_card.py` and this module only draws it, so the
AUCTONIQ rating can be checked without rendering a document and the layout can
be changed without touching the arithmetic.

**One document, one franchise.** Nothing on these pages describes another team:
no standings, no rival squads, no room-wide totals. Where a figure needs a
yardstick it is given against the 284-player pool — a rating percentile says
where a signing sits without reporting what anybody else did.

On the rupee sign
-----------------
reportlab's built-in Helvetica is a Type 1 face on WinAnsi encoding, which has
no U+20B9. Printing the product's own currency symbol therefore needs a TrueType
font registered first. Arial carries the glyph and is present on the machine the
backend runs on; if registration fails anywhere else the document falls back to
Helvetica and the ASCII "Rs", which is ugly but is not a missing-glyph box.
"""
from __future__ import annotations

import io
import os
import time
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from auction.report_card import TeamCard, WEIGHTS

# ------------------------------------------------------------------ #
# Fonts
# ------------------------------------------------------------------ #

_CANDIDATES = [
    ("AUCTONIQ", "AUCTONIQ-Bold", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("AUCTONIQ", "AUCTONIQ-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]

_registered = False
FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"
RUPEE = "Rs "
MARQUEE_MARK = "^"
"""
Marker for the derived top-decile tier.

A filled triangle once a Unicode face is registered. Deliberately NOT a
star: Arial has no U+2605, and reportlab draws a missing glyph as an empty
box -- which is how the first draft of this document shipped little squares
beside its best players. The aeroplane the rest of the product uses for
overseas is missing for the same reason, so this document spells it "OS".
"""


def _register_fonts() -> None:
    """Register a Unicode face once, and decide how money is spelled."""
    global _registered, FONT, FONT_BOLD, RUPEE, MARQUEE_MARK
    if _registered:
        return
    _registered = True

    for regular_name, bold_name, regular_path, bold_path in _CANDIDATES:
        if not (os.path.exists(regular_path) and os.path.exists(bold_path)):
            continue
        try:
            pdfmetrics.registerFont(TTFont(regular_name, regular_path))
            pdfmetrics.registerFont(TTFont(bold_name, bold_path))
        except Exception:  # noqa: BLE001 - a font failure must not fail the report
            continue
        FONT, FONT_BOLD, RUPEE = regular_name, bold_name, "\u20b9"
        MARQUEE_MARK = "▲"
        return


# ------------------------------------------------------------------ #
# Palette
# ------------------------------------------------------------------ #

INK = colors.HexColor("#14181F")
BODY = colors.HexColor("#3B4450")
MUTED = colors.HexColor("#6B7686")
FAINT = colors.HexColor("#9AA4B2")
RULE = colors.HexColor("#DFE4EA")
PANEL = colors.HexColor("#F5F7FA")

GOOD = colors.HexColor("#1E8E5A")
WARN = colors.HexColor("#B4761B")
BAD = colors.HexColor("#B4453A")

VERDICT_COLOR = {
    "steal": GOOD,
    "good bid": colors.HexColor("#3E7CB1"),
    "fair price": MUTED,
    "paid over": BAD,
}


def _hex(color: colors.Color) -> str:
    """`#rrggbb` for an inline <font color>. `hexval()` gives `0xrrggbb`."""
    return "#" + color.hexval()[2:]


def money(lakh: int | float | None) -> str:
    """₹ in crore, matching what the console prints."""
    if lakh is None:
        return "—"
    return f"{RUPEE}{lakh / 100:.2f} Cr"


def _team_color(card: TeamCard) -> colors.Color:
    raw = str(card.team.get("color") or "#2B3442")
    try:
        return colors.HexColor(raw if raw.startswith("#") else f"#{raw}")
    except Exception:  # noqa: BLE001
        return colors.HexColor("#2B3442")


# ------------------------------------------------------------------ #
# A rating bar, drawn rather than tabled
# ------------------------------------------------------------------ #


class ScoreBar(Flowable):
    """A 0-10 bar. Drawn because a table cell cannot show a partial fill."""

    def __init__(self, value: float, width: float, accent: colors.Color):
        super().__init__()
        self.value = max(0.0, min(10.0, value))
        self.width = width
        self.height = 5
        self.accent = accent

    def draw(self) -> None:
        canvas = self.canv
        canvas.setFillColor(RULE)
        canvas.roundRect(0, 0, self.width, self.height, 2.5, stroke=0, fill=1)
        filled = self.width * (self.value / 10.0)
        if filled > 0:
            canvas.setFillColor(self.accent)
            canvas.roundRect(0, 0, max(filled, 5), self.height, 2.5, stroke=0, fill=1)


# ------------------------------------------------------------------ #
# Styles
# ------------------------------------------------------------------ #


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()["BodyText"]
    def style(name: str, **kwargs: Any) -> ParagraphStyle:
        return ParagraphStyle(name, parent=base, alignment=TA_LEFT, **kwargs)

    return {
        "h1": style("h1", fontName=FONT_BOLD, fontSize=20, leading=23, textColor=INK,
                    spaceAfter=2),
        "h2": style("h2", fontName=FONT_BOLD, fontSize=10.5, leading=13, textColor=INK,
                    spaceBefore=12, spaceAfter=5),
        "eyebrow": style("eyebrow", fontName=FONT_BOLD, fontSize=6.6, leading=9,
                         textColor=FAINT, spaceAfter=2),
        "body": style("body", fontName=FONT, fontSize=8.6, leading=12.2, textColor=BODY),
        "small": style("small", fontName=FONT, fontSize=7.4, leading=10.4, textColor=MUTED),
        "foot": style("foot", fontName=FONT, fontSize=6.6, leading=9.4, textColor=FAINT),
        "cell": style("cell", fontName=FONT, fontSize=7.8, leading=10, textColor=BODY),
        "score": style("score", fontName=FONT_BOLD, fontSize=32, leading=34,
                       textColor=INK, spaceBefore=0, spaceAfter=0),
        "scorelabel": style("scorelabel", fontName=FONT_BOLD, fontSize=9,
                            leading=12, textColor=INK, spaceAfter=1),
        "cellb": style("cellb", fontName=FONT_BOLD, fontSize=7.8, leading=10, textColor=INK),
    }


def _table(data: list[list[Any]], widths: list[float], align_right: list[int] | None = None) -> Table:
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    commands = [
        ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ("FONTSIZE", (0, 0), (-1, 0), 6.6),
        ("TEXTCOLOR", (0, 0), (-1, 0), FAINT),
        ("FONTNAME", (0, 1), (-1, -1), FONT),
        ("FONTSIZE", (0, 1), (-1, -1), 7.8),
        ("TEXTCOLOR", (0, 1), (-1, -1), BODY),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.3, colors.HexColor("#EEF1F5")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    for column in align_right or []:
        commands.append(("ALIGN", (column, 0), (column, -1), "RIGHT"))
    table.setStyle(TableStyle(commands))
    return table


# ------------------------------------------------------------------ #
# The document
# ------------------------------------------------------------------ #


def render_team_pdf(card: TeamCard) -> bytes:
    """One franchise's report. Returns the PDF bytes."""
    _register_fonts()
    st = _styles()
    accent = _team_color(card)
    buffer = io.BytesIO()

    width = A4[0] - 32 * mm
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"{card.team['name']} — AUCTONIQ auction report",
        author="AUCTONIQ",
        subject="Franchise auction report",
    )

    story: list[Any] = []
    story += _masthead(card, st, accent, width)
    story += _rating_block(card, st, accent, width)
    story += _squad_strip(card, st, width)
    story += _best_bid(card, st, width)
    story += _steals(card, st, width)
    story += _weak_points(card, st)
    story.append(PageBreak())
    story += _acquisitions(card, st, width)
    story += _playing_xi(card, st, width)
    story += _ledger(card, st, width)
    story += _method(card, st)

    doc.build(story, onFirstPage=_page_furniture(card), onLaterPages=_page_furniture(card))
    return buffer.getvalue()


def _page_furniture(card: TeamCard):
    label = f"{card.team['name']} ({card.team['code']}) · AUCTONIQ franchise report"

    def draw(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont(FONT, 6.6)
        canvas.setFillColor(FAINT)
        canvas.drawString(16 * mm, 9 * mm, label)
        canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    return draw


def _masthead(card: TeamCard, st: dict, accent: colors.Color, width: float) -> list[Any]:
    stamp = time.strftime("%d %B %Y, %H:%M", time.localtime(card.generated_at))
    bar = Table(
        [[""]], colWidths=[width], rowHeights=[3],
        style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), accent),
                          ("LEFTPADDING", (0, 0), (-1, -1), 0),
                          ("RIGHTPADDING", (0, 0), (-1, -1), 0)]),
        hAlign="LEFT",
    )
    return [
        Paragraph("AUCTONIQ · IPL 2026 MEGA AUCTION", st["eyebrow"]),
        Paragraph(f"{card.team['name']}", st["h1"]),
        Paragraph(
            f"Franchise auction report · {card.team['code']} · generated {stamp}",
            st["small"],
        ),
        Spacer(1, 7),
        bar,
        Spacer(1, 4),
    ]


def _rating_block(card: TeamCard, st: dict, accent: colors.Color, width: float) -> list[Any]:
    tone = GOOD if card.overall >= 7 else (WARN if card.overall >= 5 else BAD)

    headline = Table(
        [[
            Paragraph(
                f'<font color="{_hex(tone)}">{card.overall:.1f}</font>'
                f'<font size="13" color="{_hex(FAINT)}"> / 10</font>',
                st["score"],
            ),
            [
                Paragraph("AUCTONIQ RATING", st["scorelabel"]),
                Paragraph(card.verdict_line, st["body"]),
            ],
        ]],
        colWidths=[width * 0.26, width * 0.74],
        hAlign="LEFT",
        style=TableStyle([
            # Both columns centred on the same axis, so the score sits level
            # with the label instead of dropping past the panel's floor.
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND", (0, 0), (-1, -1), PANEL),
            ("LEFTPADDING", (0, 0), (0, 0), 16),
            ("LEFTPADDING", (1, 0), (1, 0), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 14),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
            ("LINEBEFORE", (0, 0), (0, -1), 3, accent),
        ]),
    )

    rows: list[list[Any]] = []
    labels = {
        "balance": "Team balance",
        "steals": "Players that were a steal",
        "rating": "Average rating",
        "budget": "Budget expenditure",
    }
    for key in ("balance", "steals", "rating", "budget"):
        score = card.components[key]
        rows.append([
            Paragraph(
                f"<b>{labels[key]}</b><br/>"
                f'<font size="6.6" color="{_hex(FAINT)}">weighted {WEIGHTS[key]:.0%}</font>',
                st["cell"],
            ),
            Paragraph(f"<b>{score.value:.1f}</b>", st["cellb"]),
            ScoreBar(score.value, width * 0.22, accent),
            Paragraph(score.detail, st["small"]),
        ])

    grid = Table(
        rows,
        colWidths=[width * 0.20, width * 0.05, width * 0.24, width * 0.51],
        hAlign="LEFT",
        style=TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("LINEBELOW", (0, 0), (-1, -2), 0.3, RULE),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ]),
    )

    return [
        headline,
        Spacer(1, 14),
        Paragraph("HOW IT WAS SCORED", st["eyebrow"]),
        grid,
    ]


def _squad_strip(card: TeamCard, st: dict, width: float) -> list[Any]:
    rules = card.rules
    cells = [
        ("Squad", f"{card.squad_size} / {rules.get('max_squad', '—')}"),
        ("Overseas", f"{card.overseas} / {rules.get('max_overseas', '—')}"),
        ("Spent", money(card.spent)),
        ("Purse left", money(card.left)),
        ("Max bid", money(card.max_bid)),
        ("Squad rating", f"{card.squad_rating:.2f}" if card.squad_rating else "—"),
        ("XI rating", f"{card.xi_rating:.2f}" if card.xi_rating else "—"),
    ]
    table = Table(
        [
            [Paragraph(label.upper(), st["eyebrow"]) for label, _ in cells],
            [Paragraph(f"<b>{value}</b>", st["cellb"]) for _, value in cells],
        ],
        colWidths=[width / len(cells)] * len(cells),
        hAlign="LEFT",
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PANEL),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]),
    )
    return [Spacer(1, 10), table]


def _verdict_chip(verdict: str, st: dict) -> Paragraph:
    color = VERDICT_COLOR.get(verdict, MUTED)
    return Paragraph(
        f'<font color="{_hex(color)}"><b>{verdict.upper()}</b></font>', st["cell"]
    )


def _best_bid(card: TeamCard, st: dict, width: float) -> list[Any]:
    if card.best is None:
        return [
            Paragraph("BEST BID", st["h2"]),
            Paragraph("No players were bought, so there is no bid to judge.", st["body"]),
        ]

    best = card.best
    saved = best.expected - best.price
    tier = "top-decile player by rating" if best.marquee else f"{best.rating_pct:.0%} mark of the pool"
    verdict_sentence = {
        "steal": (
            f"A steal. {money(best.price)} against an expected {money(best.expected)} — "
            f"{money(saved)} of value, at {best.ratio:.0%} of the price the model put on them."
        ),
        "good bid": (
            f"A good bid. {money(best.price)} against an expected {money(best.expected)}, "
            f"{money(saved)} under the odds."
        ),
        "fair price": (
            f"A fair price: {money(best.price)} against an expected {money(best.expected)}."
        ),
        "paid over": (
            f"The best of the buys, but still over the odds — {money(best.price)} against "
            f"an expected {money(best.expected)}."
        ),
    }[best.verdict]

    body = Table(
        [[
            Paragraph(
                f"<b>{best.name}</b><br/>"
                f'<font size="7.4" color="{_hex(MUTED)}">{best.role}'
                f'{" · overseas" if best.overseas else ""} · {best.headline}'
                f'{f" · rating {best.rating:.2f}" if best.rating is not None else ""} · {tier}</font>',
                st["cell"],
            ),
            _verdict_chip(best.verdict, st),
        ]],
        colWidths=[width * 0.78, width * 0.22],
        hAlign="LEFT",
        style=TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]),
    )

    return [
        Paragraph("BEST BID", st["h2"]),
        body,
        Spacer(1, 3),
        Paragraph(verdict_sentence, st["body"]),
    ]


def _steals(card: TeamCard, st: dict, width: float) -> list[Any]:
    if not card.steals:
        return [
            Paragraph("PLAYERS THAT WERE A STEAL", st["h2"]),
            Paragraph(
                "None. Every player was bought at or above 70% of the price the "
                "model expected them to go for.",
                st["body"],
            ),
        ]

    header = ["Player", "Role", "Rating", "Expected", "Paid", "Saved", "Of expected"]
    rows: list[list[Any]] = [header]
    for buy in card.steals:
        rows.append([
            Paragraph(
                f"<b>{buy.name}</b>"
                + (f' <font size="6">{MARQUEE_MARK}</font>' if buy.marquee else ""),
                st["cell"],
            ),
            buy.role,
            f"{buy.rating:.2f}" if buy.rating is not None else "—",
            money(buy.expected),
            money(buy.price),
            money(buy.expected - buy.price),
            f"{buy.ratio:.0%}",
        ])

    widths = [width * w for w in (0.28, 0.16, 0.09, 0.13, 0.13, 0.12, 0.09)]
    return [
        Paragraph("PLAYERS THAT WERE A STEAL", st["h2"]),
        _table(rows, widths, align_right=[2, 3, 4, 5, 6]),
        Spacer(1, 3),
        Paragraph(
            f"{MARQUEE_MARK} marks the top decile of the pool by rating - a tier "
            "derived from rating, because the dataset records no marquee list.",
            st["foot"],
        ),
    ]


def _weak_points(card: TeamCard, st: dict) -> list[Any]:
    items = [
        Paragraph(f"•&nbsp;&nbsp;{point}", st["body"]) for point in card.weak_points
    ]
    return [Paragraph("WEAK POINTS", st["h2"]), *items]


def _acquisitions(card: TeamCard, st: dict, width: float) -> list[Any]:
    if not card.buys:
        return [
            Paragraph("EVERY ACQUISITION", st["h2"]),
            Paragraph("No players were bought.", st["body"]),
        ]

    header = ["Player", "Role", "Rating", "Standout", "Base", "Expected", "Paid", "Verdict"]
    rows: list[list[Any]] = [header]
    for buy in card.buys:
        rows.append([
            Paragraph(
                f"<b>{buy.name}</b>"
                + (f' <font size="6">{MARQUEE_MARK}</font>' if buy.marquee else "")
                + (f' <font size="6" color="{_hex(FAINT)}">OS</font>' if buy.overseas else ""),
                st["cell"],
            ),
            buy.role,
            f"{buy.rating:.2f}" if buy.rating is not None else "—",
            Paragraph(buy.headline, st["cell"]),
            money(buy.base) + ("*" if buy.base_assumed else ""),
            money(buy.expected),
            money(buy.price),
            _verdict_chip(buy.verdict, st),
        ])

    widths = [width * w for w in (0.21, 0.13, 0.07, 0.16, 0.10, 0.11, 0.10, 0.12)]
    return [
        Paragraph("EVERY ACQUISITION", st["h2"]),
        _table(rows, widths, align_right=[2, 4, 5, 6]),
        Spacer(1, 3),
        Paragraph(
            f"* no base price recorded for this player; the auction floor stands in, "
            f"so no premium over base is read from it.      "
            f"{MARQUEE_MARK} top decile of the pool by rating.      OS overseas.",
            st["foot"],
        ),
    ]


def _playing_xi(card: TeamCard, st: dict, width: float) -> list[Any]:
    if not card.playing_xi:
        return []

    header = ["#", "Player", "Role", "Country", "Rating", "Paid"]
    rows: list[list[Any]] = [header]
    for index, player in enumerate(card.playing_xi, start=1):
        rating = player.get("rating")
        price = player.get("price")
        rows.append([
            str(index),
            Paragraph(f"<b>{player.get('name', '—')}</b>", st["cell"]),
            player.get("role") or "—",
            player.get("country") or ("Overseas" if player.get("overseas") else "—"),
            f"{rating:.2f}" if isinstance(rating, (int, float)) else "—",
            money(price) if price else "—",
        ])

    widths = [width * w for w in (0.05, 0.32, 0.20, 0.18, 0.12, 0.13)]
    return [
        Paragraph("PLAYING XI", st["h2"]),
        Paragraph(
            "Picked by role first and rating second — one keeper, four batters, "
            "two all-rounders, three bowlers, with the last slot to the best "
            "player left and the overseas cap applied afterwards. A heuristic, "
            "not a selection committee.",
            st["small"],
        ),
        Spacer(1, 4),
        _table(rows, widths, align_right=[4, 5]),
    ]


def _ledger(card: TeamCard, st: dict, width: float) -> list[Any]:
    if not card.ledger:
        return [
            Paragraph("BIDDING HISTORY", st["h2"]),
            Paragraph("The room's ledger holds no entries naming this franchise.", st["body"]),
        ]

    header = ["#", "Time", "Event", "Amount"]
    rows: list[list[Any]] = [header]
    for entry in reversed(card.ledger):
        stamp = time.strftime("%H:%M:%S", time.localtime(float(entry.get("ts", 0))))
        amount = entry.get("amount")
        rows.append([
            str(entry.get("seq", "")),
            stamp,
            Paragraph(str(entry.get("what", "")), st["cell"]),
            money(amount) if amount else "—",
        ])

    widths = [width * w for w in (0.07, 0.13, 0.62, 0.18)]
    out = [Paragraph("BIDDING HISTORY", st["h2"]), _table(rows, widths, align_right=[3])]
    if card.ledger_truncated:
        out += [
            Spacer(1, 3),
            Paragraph(
                "The room keeps the most recent 400 ledger entries; anything "
                "earlier in the auction has rolled off. Every purchase is still "
                "listed in full under Every acquisition.",
                st["foot"],
            ),
        ]
    return out


def _method(card: TeamCard, st: dict) -> list[Any]:
    weights = ", ".join(
        f"{name} {WEIGHTS[key]:.0%}"
        for key, name in (
            ("balance", "team balance"),
            ("steals", "steals"),
            ("rating", "average rating"),
            ("budget", "budget expenditure"),
        )
    )
    calibration = (
        "The expected price was calibrated against this auction's own clearing "
        "prices."
        if card.calibrated
        else "Too few players had sold to calibrate against this auction's own "
        "prices, so the model's uncalibrated curve was used."
    )
    return [
        Spacer(1, 12),
        Paragraph("HOW THE RATING WAS CALCULATED", st["eyebrow"]),
        Paragraph(
            f"The AUCTONIQ rating is the weighted mean of four scores, each out "
            f"of ten: {weights}. "
            f"A player's expected price is modelled from where their rating sits "
            f"among the {card.pool_size} players in the pool, the franchise "
            f"purse, and their base price. {calibration} A buy at or under 70% "
            f"of that expectation is called a steal, under 90% a good bid. "
            f"The marquee tier is the top decile of the pool by rating — derived, "
            f"because the dataset records no marquee list. Every figure in this "
            f"document describes this franchise only.",
            st["foot"],
        ),
    ]
