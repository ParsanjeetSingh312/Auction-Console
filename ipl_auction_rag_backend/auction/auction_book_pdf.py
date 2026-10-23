"""
auction_book_pdf.py
One franchise's auction report, drawn as a dark, broadcast-style A4 document.

`auction_book.py` decides every figure; this module only places them. Pages are
drawn on the reportlab canvas rather than flowed through platypus, because the
layout is a designed spread -- panels, tiles, bars and a timeline at fixed
positions -- not a document that reflows.

Pages, in order (the reference book's numbering in brackets):

  1  Cover                         [1]
  2  The day in numbers            [2]
  3  Moments                       [3]   no purse burn-down graph
  4  Ten most expensive signings   [4]   no ranks 11-25, no price per year of age
  5  Role mix                      [5]
  6  Value for money               [6]
  7  Career record                 [7]   combined impact, batting and bowling depth
  8  The awards nobody asked for   [17 in the request, 18 in the book]
  9  The AUCTONIQ verdict          the product's own rating, redrawn to match

Fonts
-----
Headings use a condensed display face, numbers a DIN-style face and body text a
humanist sans. Each role tries a Windows face, then DejaVu (installed in the
Docker image for exactly this), then reportlab's built-in Helvetica. The display
face has no rupee glyph, so `_display` draws any "₹" in the body face.
"""
from __future__ import annotations

import io
import math
import os
from datetime import datetime
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

from auction.auction_book import IST, FranchiseReport, Sale, clock, money
from auction.report_card import WEIGHTS

W, H = A4
M = 34  # page margin

# ------------------------------------------------------------------ #
# Palette
# ------------------------------------------------------------------ #

BG = colors.HexColor("#0A0F1C")
BG_2 = colors.HexColor("#0F1729")
PANEL = colors.HexColor("#121B2E")
PANEL_EDGE = colors.HexColor("#22304D")
INK = colors.HexColor("#EEF2F8")
BODY = colors.HexColor("#B8C2D6")
MUTED = colors.HexColor("#7D8AA5")
FAINT = colors.HexColor("#4A5672")
GOLD = colors.HexColor("#F5C542")
GOOD = colors.HexColor("#34D399")
WARN = colors.HexColor("#F59E0B")
BAD = colors.HexColor("#F87171")
ROLE_COLOR = {
    "Batter": colors.HexColor("#FACC15"),
    "Wicket-keeper": colors.HexColor("#F472B6"),
    "All-rounder": colors.HexColor("#38BDF8"),
    "Bowler": colors.HexColor("#34D399"),
}
ROLE_SHORT_NAME = {"BAT": "Batter", "WK": "Wicket-keeper", "AR": "All-rounder", "BOWL": "Bowler"}

# ------------------------------------------------------------------ #
# Fonts
# ------------------------------------------------------------------ #

_FONT_CANDIDATES = {
    "display": ["C:/Windows/Fonts/impact.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "number": ["C:/Windows/Fonts/bahnschrift.ttf",
               "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
               "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "body": ["C:/Windows/Fonts/segoeui.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    "semi": ["C:/Windows/Fonts/seguisb.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "bold": ["C:/Windows/Fonts/segoeuib.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
}
_FALLBACK = {"display": "Helvetica-Bold", "number": "Helvetica-Bold", "body": "Helvetica",
             "semi": "Helvetica-Bold", "bold": "Helvetica-Bold"}
F: dict[str, str] = dict(_FALLBACK)
_has_rupee: dict[str, bool] = {}
_fonts_ready = False


def _register_fonts() -> None:
    global _fonts_ready
    if _fonts_ready:
        return
    _fonts_ready = True
    for role, paths in _FONT_CANDIDATES.items():
        for path in paths:
            if not os.path.exists(path):
                continue
            name = f"AQ-{role}"
            try:
                face = TTFont(name, path)
                pdfmetrics.registerFont(face)
            except Exception:  # noqa: BLE001 - try the next candidate
                continue
            F[role] = name
            _has_rupee[name] = 0x20B9 in face.face.charToGlyph
            break


def _rupee_ok(font: str) -> bool:
    return _has_rupee.get(font, False)


def _txt(text: str, font: str) -> str:
    """The rupee sign where the face has it, "Rs " where it does not."""
    return text if _rupee_ok(font) else text.replace("₹", "Rs ")


# ------------------------------------------------------------------ #
# Drawing primitives
# ------------------------------------------------------------------ #


def _hex(value: str | None, default: str = "#F5C542") -> colors.Color:
    try:
        return colors.HexColor(value or default)
    except Exception:  # noqa: BLE001
        return colors.HexColor(default)


def _mix(color: colors.Color, other: colors.Color, t: float) -> colors.Color:
    return colors.Color(
        color.red + (other.red - color.red) * t,
        color.green + (other.green - color.green) * t,
        color.blue + (other.blue - color.blue) * t,
    )


def _lift(color: colors.Color) -> colors.Color:
    """A team colour bright enough to read as text on the night background."""
    lum = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue
    return _mix(color, colors.white, 0.45) if lum < 0.45 else color


class Pen:
    """The canvas plus the page's accent and the report it belongs to."""

    def __init__(self, c: rl_canvas.Canvas, report: FranchiseReport):
        self.c = c
        self.r = report
        self.accent = _lift(_hex(report.team.get("color")))
        self.page = 0

    # --- text -----------------------------------------------------------
    def text(self, x, y, text, font="body", size=9, color=BODY, align="left"):
        name = F[font]
        text = _txt(str(text), name)
        self.c.setFont(name, size)
        self.c.setFillColor(color)
        if align == "right":
            self.c.drawRightString(x, y, text)
        elif align == "center":
            self.c.drawCentredString(x, y, text)
        else:
            self.c.drawString(x, y, text)

    def width(self, text, font="body", size=9) -> float:
        name = F[font]
        return pdfmetrics.stringWidth(_txt(str(text), name), name, size)

    def display(self, x, y, text, size=30, color=INK, align="left"):
        """Display type, drawing any rupee sign in the body face."""
        text = str(text)
        disp, bold = F["display"], F["bold"]
        if "₹" in text and not _rupee_ok(disp) and _rupee_ok(bold):
            parts = text.split("₹")
            pieces: list[tuple[str, str]] = []
            for i, part in enumerate(parts):
                if i:
                    pieces.append(("₹", bold))
                if part:
                    pieces.append((part, disp))
        else:
            pieces = [(_txt(text, disp), disp)]
        total = sum(pdfmetrics.stringWidth(t, f, size) for t, f in pieces)
        cx = x - total if align == "right" else x - total / 2 if align == "center" else x
        self.c.setFillColor(color)
        for t, f in pieces:
            self.c.setFont(f, size * (0.86 if f == bold and f != disp else 1))
            self.c.drawString(cx, y, t)
            cx += pdfmetrics.stringWidth(t, f, size)

    def kicker(self, x, y, text, color=None, size=7):
        """Letter-spaced small caps label."""
        # Saved and restored: character spacing is graphics state, and without
        # this every line drawn after a label inherits its letter-spacing.
        self.c.saveState()
        t = self.c.beginText(x, y)
        t.setFont(F["semi"], size)
        t.setCharSpace(1.6)
        t.setFillColor(color or MUTED)
        t.textOut(_txt(str(text).upper(), F["semi"]))
        self.c.drawText(t)
        self.c.restoreState()

    def para(self, x, y, text, width, font="body", size=9, color=BODY, leading=None) -> float:
        """Wrapped text from (x, y) downwards. Returns the y below the last line."""
        leading = leading or size * 1.42
        name = F[font]
        for line in simpleSplit(_txt(str(text), name), name, size, width):
            self.text(x, y, line, font, size, color)
            y -= leading
        return y

    # --- shapes ---------------------------------------------------------
    def panel(self, x, y, w, h, title=None, edge=None):
        """A rounded panel; (x, y) is the TOP-left corner. Returns the content top."""
        c = self.c
        c.setFillColor(PANEL)
        c.setStrokeColor(edge or PANEL_EDGE)
        c.setLineWidth(0.6)
        c.roundRect(x, y - h, w, h, 9, stroke=1, fill=1)
        if title:
            self.kicker(x + 14, y - 20, title, color=MUTED)
            return y - 34
        return y - 14

    def bar(self, x, y, w, h, color, radius=None):
        if w <= 0:
            return
        self.c.setFillColor(color)
        self.c.roundRect(x, y, w, h, radius if radius is not None else min(h / 2, 3), stroke=0, fill=1)

    def chip(self, x, y, text, color, font="semi", size=7):
        """A small pill; (x, y) is the baseline-left. Returns its width."""
        w = self.width(text, font, size) + 10
        self.c.setFillColor(_mix(BG, color, 0.22))
        self.c.setStrokeColor(_mix(BG, color, 0.55))
        self.c.setLineWidth(0.5)
        self.c.roundRect(x, y - 3.2, w, size + 6, (size + 6) / 2, stroke=1, fill=1)
        self.text(x + 5, y, text, font, size, _lift(color))
        return w

    def bars(self, x, y, w, items, *, label_w=96, row=19, color=None, value_w=86):
        """Horizontal bar chart from a list of auction_book.Bar. Returns the y below."""
        top = max((b.value for b in items), default=0) or 1
        track = w - label_w - value_w
        for i, b in enumerate(items):
            yy = y - i * row
            self.text(x + label_w - 8, yy - 9, b.label, "body", 8.5, BODY, align="right")
            self.bar(x + label_w, yy - 12, track, 9, BG_2)
            fill = _hex(b.color) if isinstance(b.color, str) else (b.color or color or self.accent)
            self.bar(x + label_w, yy - 12, max(3, track * (b.value / top)) if b.value else 0, 9, fill)
            self.text(x + label_w + track + 8, yy - 9, b.text, "number", 8.5, MUTED)
        return y - len(items) * row

    # --- page furniture ---------------------------------------------------
    def background(self, ribbon: bool = True):
        c = self.c
        c.setFillColor(BG)
        c.rect(0, 0, W, H, stroke=0, fill=1)
        # A slow wash from the top in the franchise's colour.
        steps = 28
        for i in range(steps):
            t = i / steps
            c.setFillColor(_mix(BG, _hex(self.r.team.get("color")), 0.14 * (1 - t) ** 2))
            c.rect(0, H - (i + 1) * 9, W, 9, stroke=0, fill=1)
        if ribbon:
            self.ribbon()

    def ribbon(self):
        """The room's colours as a ribbon across the top edge."""
        c = self.c
        teams = self.r.teams or [self.r.team]
        seg = W / len(teams)
        for i, t in enumerate(teams):
            c.setFillColor(_hex(t.get("color")))
            c.rect(i * seg, H - 4, seg + 0.5, 4, stroke=0, fill=1)

    def header(self, number: int, kicker: str, title: str, intro: str | None = None) -> float:
        self.background()
        self.kicker(M, H - 34, f"{number:02d} · {kicker}", color=self.accent)
        self.display(M, H - 70, title.upper(), 30, INK)
        self.wordmark(W - M, H - 40, align="right")
        y = H - 86
        if intro:
            y = self.para(M, y - 4, intro, W - 2 * M, size=9.5, color=BODY) - 4
        return y - 6

    def wordmark(self, x, y, align="left", size=11):
        text = "AUCTONIQ"
        w = self.width(text, "display", size) + 2.2 * (len(text) - 1)
        x0 = x - w if align == "right" else x
        self.c.saveState()
        t = self.c.beginText(x0, y)
        t.setFont(F["display"], size)
        t.setCharSpace(2.2)
        t.setFillColor(GOLD)
        t.textOut(text)
        self.c.drawText(t)
        self.c.restoreState()

    def footer(self, section: str):
        self.page += 1
        team = self.r.team.get("name", "")
        self.c.setStrokeColor(PANEL_EDGE)
        self.c.setLineWidth(0.5)
        self.c.line(M, 30, W - M, 30)
        self.kicker(M, 18, f"AUCTONIQ · {team} · auction report", color=FAINT, size=6.5)
        self.kicker(W - M - 120, 18, section, color=FAINT, size=6.5)
        self.text(W - M, 18, str(self.page), "number", 8, MUTED, align="right")
        self.c.showPage()


# ------------------------------------------------------------------ #
# Pages
# ------------------------------------------------------------------ #


def _possessive(name: str) -> str:
    return f"{name}'" if name.endswith("s") else f"{name}'s"


def _cover(p: Pen) -> None:
    r, c = p.r, p.c
    p.background(ribbon=False)
    team_color = _hex(r.team.get("color"))
    # Floodlight glow behind the title: many faint discs, so the falloff reads
    # as light rather than as a disc with an edge.
    # Translucent layers rather than opaque mixes, so the outermost ring blends
    # into the wash behind it instead of drawing a hard edge over it.
    c.saveState()
    for i in range(40, 0, -1):
        c.setFillColor(team_color, alpha=0.011)
        c.circle(W * 0.80, H * 0.72, i * 6.5, stroke=0, fill=1)
    c.restoreState()
    p.ribbon()

    p.wordmark(M, H - 52, size=16)
    p.kicker(M, H - 66, "auction intelligence", color=MUTED, size=6.5)
    p.kicker(W - M - 150, H - 52, f"room {r.room_code}", color=MUTED)
    day = datetime.fromtimestamp(r.started_at or r.generated_at, IST)
    p.kicker(W - M - 150, H - 64, f"{day:%d %B %Y}", color=MUTED)

    p.kicker(M, H - 190, f"auction day · {day:%d %B %Y}", color=GOLD)
    p.display(M, H - 262, "THE AUCTION", 66, INK)
    p.display(M, H - 326, "REPORT", 66, INK)
    p.display(M, H - 372, r.team.get("name", "").upper(), 34, p.accent)

    pieces = [f"{len(r.teams)} franchises"]
    if r.auction_minutes:
        hours = r.auction_minutes / 60
        pieces.append(f"{hours:.1f} hours under the hammer" if hours >= 1 else f"{r.auction_minutes} minutes under the hammer")
    intro = (
        ". ".join(pieces).capitalize() + ". "
        f"This is {_possessive(r.team.get('name', ''))} auction: every signing, every price and "
        "the story the numbers tell, alongside the day's record bids, its moments "
        "and its awards."
    )
    p.para(M, H - 400, intro, W * 0.62, size=10.5, color=BODY)

    # --- the franchises in the room ---------------------------------------
    y = 352
    p.kicker(M, y, "the franchises", color=MUTED)
    teams = r.teams
    per_row = 6 if len(teams) > 10 else 5
    tile_w = (W - 2 * M - (per_row - 1) * 8) / per_row
    tile_h = 44
    rows_needed = math.ceil(len(teams) / per_row)
    if rows_needed > 3:  # an unusually large room: shrink rather than overflow
        per_row = 8
        tile_w = (W - 2 * M - (per_row - 1) * 6) / per_row
        tile_h = 34
    for i, t in enumerate(teams):
        col, row = i % per_row, i // per_row
        x = M + col * (tile_w + (8 if per_row < 8 else 6))
        ty = y - 12 - row * (tile_h + 8)
        mine = t.get("id") == r.team.get("id")
        tc = _hex(t.get("color"))
        c.setFillColor(_mix(PANEL, tc, 0.18 if mine else 0.07))
        c.setStrokeColor(_lift(tc) if mine else PANEL_EDGE)
        c.setLineWidth(1.2 if mine else 0.5)
        c.roundRect(x, ty - tile_h, tile_w, tile_h, 7, stroke=1, fill=1)
        c.setFillColor(tc)
        c.roundRect(x, ty - 3, tile_w, 3, 1.5, stroke=0, fill=1)
        p.display(x + 9, ty - 22, t.get("code", ""), 15 if tile_h > 40 else 12, _lift(tc))
        name = t.get("name", "")
        while p.width(name, "semi", 7) > tile_w - 16 and len(name) > 4:
            name = name[:-2] + "…"
        p.text(x + 9, ty - 34 if tile_h > 40 else ty - 29, name, "semi", 7, BODY)

    # --- the headline numbers ---------------------------------------------
    y0 = 140
    tiles = [
        (str(len(r.teams)), "teams", "in the room"),
        (str(len(r.buys)), "squad players", r.team.get("name", "")),
        (money(r.top_bid.price) if r.top_bid else "—", "top bid",
         f"{r.top_bid.name} · {r.top_bid.team_code}" if r.top_bid else "no sales"),
        (money(r.spent), "total spend", f"of {money(r.purse)} purse"),
    ]
    tw = (W - 2 * M - 3 * 10) / 4
    for i, (value, label, sub) in enumerate(tiles):
        x = M + i * (tw + 10)
        p.panel(x, y0, tw, 66)
        p.display(x + 12, y0 - 34, value, 22, GOLD)
        p.kicker(x + 12, y0 - 47, label, color=MUTED, size=6.5)
        while p.width(sub, "body", 7) > tw - 22 and len(sub) > 4:
            sub = sub[:-2] + "…"
        p.text(x + 12, y0 - 58, sub, "body", 7, FAINT)

    c.setStrokeColor(PANEL_EDGE)
    c.line(M, 50, W - M, 50)
    p.kicker(M, 36, "organised by", color=MUTED, size=6.5)
    p.wordmark(M + 72, 35, size=13)
    season = f"Career statistics: IPL through {r.season_through}" if r.season_through else ""
    p.text(W - M, 37, season, "body", 7, FAINT, align="right")
    p.c.showPage()
    p.page += 1


def _day_in_numbers(p: Pen) -> None:
    r = p.r
    intro = (
        f"{r.team.get('name')} signed {len(r.buys)} players for {money(r.spent)}"
        + (f", in an auction that ran from {clock(r.started_at)} to {clock(r.ended_at)}"
           if r.started_at and r.ended_at else "")
        + f". {money(r.left)} of the {money(r.purse)} purse was left unspent."
    )
    y = p.header(2, "the day in numbers", f"{money(r.spent)} changed hands", intro)

    tw = (W - 2 * M - 3 * 10) / 4
    for i, (value, label, sub) in enumerate(r.numbers):
        col, row = i % 4, i // 4
        x = M + col * (tw + 10)
        ty = y - row * 74
        p.panel(x, ty, tw, 66)
        p.display(x + 12, ty - 32, value, 21, GOLD)
        p.kicker(x + 12, ty - 45, label, color=INK, size=6.5)
        while p.width(sub, "body", 7) > tw - 22 and len(sub) > 4:
            sub = sub[:-2] + "…"
        p.text(x + 12, ty - 57, sub, "body", 7, MUTED)
    y -= 2 * 74 + 6

    half = (W - 2 * M - 12) / 2
    h = 168
    top = p.panel(M, y, half, h, "where the money went — price bands")
    p.bars(M + 12, top, half - 24, r.price_bands, label_w=78, value_w=64, color=colors.HexColor("#38BDF8"))
    top = p.panel(M + half + 12, y, half, h, "what each role cost on average")
    role_bars = [b for b in r.role_cost]
    for b in role_bars:
        b.color = ROLE_COLOR.get(b.label)  # type: ignore[assignment]
    p.bars(M + half + 24, top, half - 24, role_bars, label_w=84, value_w=90, row=24)
    y -= h + 12

    # --- purse spent ----------------------------------------------------------
    h = 112
    top = p.panel(M, y, W - 2 * M, h, "purse spent")
    track = W - 2 * M - 28
    used = (r.spent / r.purse) if r.purse else 0
    p.bar(M + 14, top - 26, track, 18, BG_2, radius=5)
    p.bar(M + 14, top - 26, track * min(1, used), 18, p.accent, radius=5)
    p.display(M + 14, top - 52, f"{used * 100:.1f}%", 20, INK)
    p.text(M + 80, top - 50, f"of the purse used — {money(r.spent)} spent, {money(r.left)} left",
           "body", 9, BODY)
    # The buys as segments of the spend, biggest first, so the bar reads as
    # "where the purse went" one cheque at a time.
    x = M + 14
    for s in r.buys:
        w = track * (s.price / r.purse) if r.purse else 0
        if w < 0.6:
            continue
        p.c.setStrokeColor(BG)
        p.c.setLineWidth(0.8)
        p.c.line(x + w, top - 26, x + w, top - 8)
        if w > 44:
            p.text(x + 4, top - 20, s.name.split()[-1][:12], "semi", 6.5, BG)
        x += w
    p.text(M + 14, top - 70, "Each segment is one signing, biggest cheque first.", "body", 7, FAINT)
    p.footer("the day in numbers")


def _moments_page(p: Pen) -> None:
    r = p.r
    y = p.header(3, "moments", "how the day unfolded",
                 "The auction as it happened, from the first hammer to the last. The same "
                 "timeline appears in every franchise's report.")
    top = p.panel(M, y, W - 2 * M, y - 60, "moments")
    if not r.moments:
        p.para(M + 16, top - 6, "This room recorded no sale times, so there is no timeline to draw.",
               W - 2 * M - 32, color=MUTED)
        p.footer("moments")
        return

    line_x = M + 92
    gap = min(64, (top - 90) / max(1, len(r.moments)))
    p.c.setStrokeColor(PANEL_EDGE)
    p.c.setLineWidth(1.4)
    p.c.line(line_x, top - 8, line_x, top - 8 - gap * (len(r.moments) - 1) - 4)
    palette = [GOLD, colors.HexColor("#38BDF8"), GOOD, colors.HexColor("#F472B6"),
               WARN, colors.HexColor("#A78BFA"), BAD, colors.HexColor("#2DD4BF")]
    for i, m in enumerate(r.moments):
        yy = top - 12 - i * gap
        dot = palette[i % len(palette)]
        p.c.setFillColor(_mix(BG, dot, 0.35))
        p.c.circle(line_x, yy + 3, 7, stroke=0, fill=1)
        p.c.setFillColor(dot)
        p.c.circle(line_x, yy + 3, 3.6, stroke=0, fill=1)
        p.text(line_x - 16, yy, m.at, "number", 10, INK, align="right")
        p.text(line_x + 20, yy + 4, m.title, "bold", 11, INK)
        p.para(line_x + 20, yy - 10, m.detail, W - 2 * M - (line_x - M) - 40, size=9, color=BODY)
    p.footer("moments")


def _jersey(p: Pen, cx, top, w, sale: Sale):
    """
    The back of a shirt in the buying franchise's colours, with the player's
    number on it -- the card leads with the number, not a face.

    Where the pool has no verified number the shirt carries the role code
    instead (BAT, WK, AR, BOWL). A guessed number on the largest element of the
    card would be the most visible thing on the page and the least checked.
    """
    c = p.c
    team = _hex(sale.team_color)
    h = w * 0.92
    x0, y0 = cx - w / 2, top - h
    sleeve, neck, shoulder = w * 0.20, w * 0.17, h * 0.26
    body = c.beginPath()
    body.moveTo(x0 + sleeve, y0)                       # hem, left
    body.lineTo(x0 + w - sleeve, y0)                   # hem, right
    body.lineTo(x0 + w - sleeve, y0 + h - shoulder)    # up the right side
    body.lineTo(x0 + w, y0 + h - shoulder * 0.55)      # sleeve cuff
    body.lineTo(x0 + w - sleeve * 0.55, y0 + h)        # shoulder seam
    body.lineTo(cx + neck, y0 + h)
    body.curveTo(cx + neck * 0.5, y0 + h - neck * 0.55, cx - neck * 0.5,
                 y0 + h - neck * 0.55, cx - neck, y0 + h)  # collar
    body.lineTo(x0 + sleeve * 0.55, y0 + h)
    body.lineTo(x0, y0 + h - shoulder * 0.55)
    body.lineTo(x0 + sleeve, y0 + h - shoulder)
    body.close()
    c.setFillColor(_mix(team, BG, 0.15))
    c.setStrokeColor(_lift(team))
    c.setLineWidth(0.8)
    c.drawPath(body, stroke=1, fill=1)
    # A side panel in the role colour, the way kits carry a trim.
    role = ROLE_SHORT_NAME.get(sale.role_short, "Batter")
    c.setFillColor(ROLE_COLOR.get(role, GOLD))
    c.rect(x0 + sleeve, y0, 2.4, h - shoulder, stroke=0, fill=1)
    c.rect(x0 + w - sleeve - 2.4, y0, 2.4, h - shoulder, stroke=0, fill=1)

    surname = sale.name.split()[-1].upper()[:11]
    p.text(cx, y0 + h - shoulder - 6, surname, "bold", 6.2, colors.white, align="center")
    if sale.jersey is not None:
        p.display(cx, y0 + h * 0.16, str(sale.jersey), h * 0.46, colors.white, align="center")
    else:
        p.display(cx, y0 + h * 0.24, sale.role_short, h * 0.28, _mix(colors.white, team, 0.25), align="center")


def _ten_most_expensive(p: Pen) -> None:
    r = p.r
    total = sum(s.price for s in r.ten_most_expensive)
    y = p.header(4, "the price ladder", "the ten most expensive signings",
                 f"The day's ten biggest cheques, {money(total)} between them — the same "
                 "ten in every franchise's report. Your own signings are outlined in your colours.")
    cols, gap = 5, 9
    cw = (W - 2 * M - (cols - 1) * gap) / cols
    ch = 148
    for i, s in enumerate(r.ten_most_expensive):
        col, row = i % cols, i // cols
        x = M + col * (cw + gap)
        ty = y - row * (ch + gap)
        mine = s.team_id == r.team.get("id")
        tc = _hex(s.team_color)
        p.panel(x, ty, cw, ch, edge=_lift(tc) if mine else None)
        p.c.setFillColor(tc)
        p.c.roundRect(x, ty - 3, cw, 3, 1.5, stroke=0, fill=1)
        p.chip(x + 8, ty - 18, f"#{i + 1}", GOLD, "number", 7)
        _jersey(p, x + cw / 2, ty - 22, 58, s)
        name = s.name
        while p.width(name, "bold", 8.5) > cw - 12 and len(name) > 4:
            name = name[:-2] + "…"
        p.text(x + cw / 2, ty - 92, name, "bold", 8.5, INK, align="center")
        p.text(x + cw / 2, ty - 103, s.team_name[:22], "semi", 7, _lift(tc), align="center")
        p.display(x + cw / 2, ty - 124, money(s.price), 16, GOLD, align="center")
        sub = ROLE_SHORT_NAME.get(s.role_short, "") + (" · OS" if s.overseas else "")
        p.text(x + cw / 2, ty - 137, sub, "body", 6.5, MUTED, align="center")
    rows = math.ceil(len(r.ten_most_expensive) / cols) if r.ten_most_expensive else 0
    y -= rows * (ch + gap) + 6
    if not r.ten_most_expensive:
        p.para(M, y, "No players were sold in this room.", W - 2 * M, color=MUTED)

    half = (W - 2 * M - 12) / 2
    h = min(190, y - 60)
    top = p.panel(M, y, half, h, f"{r.team.get('code')} spend concentration")
    for i, (label, amount, share) in enumerate(r.concentration):
        yy = top - 6 - i * 24
        p.text(M + 14, yy, label, "body", 9, BODY)
        p.text(M + half - 70, yy, amount, "number", 9, INK, align="right")
        p.text(M + half - 14, yy, share, "number", 9, GOLD, align="right")
        p.c.setStrokeColor(PANEL_EDGE)
        p.c.setLineWidth(0.4)
        p.c.line(M + 14, yy - 8, M + half - 14, yy - 8)
    top = p.panel(M + half + 12, y, half, h, f"{r.team.get('code')} most expensive by role")
    for i, s in enumerate(r.priciest_by_role):
        yy = top - 6 - i * 26
        role = ROLE_SHORT_NAME.get(s.role_short, "")
        w = p.chip(M + half + 26, yy, role, ROLE_COLOR.get(role, GOLD))
        p.text(M + half + 32 + w, yy, s.name[:22], "semi", 9, INK)
        p.text(W - M - 14, yy, money(s.price), "number", 9, GOLD, align="right")
    if not r.priciest_by_role:
        p.para(M + half + 26, top - 6, "No signings yet.", half - 30, color=MUTED)
    p.footer("price ladder")


def _role_mix(p: Pen) -> None:
    r = p.r
    y = p.header(5, "squad dna", "how the squad is built",
                 f"{_possessive(r.team.get('name', ''))} {len(r.buys)} signings by role, origin and status.")
    h = 230
    top = p.panel(M, y, W - 2 * M, h, "role mix")
    total = sum(b.value for b in r.role_mix) or 1
    cx, cy, rad = M + 110, top - 92, 70
    start = 90.0
    for b in r.role_mix:
        if not b.value:
            continue
        extent = -360 * b.value / total
        p.c.setFillColor(ROLE_COLOR.get(b.label, GOLD))
        p.c.wedge(cx - rad, cy - rad, cx + rad, cy + rad, start, extent, stroke=0, fill=1)
        start += extent
    p.c.setFillColor(PANEL)
    p.c.circle(cx, cy, rad * 0.62, stroke=0, fill=1)
    p.display(cx, cy - 4, str(len(r.buys)), 26, INK, align="center")
    p.kicker(cx - 16, cy - 18, "players", color=MUTED, size=6)

    lx = M + 220
    for i, b in enumerate(r.role_mix):
        yy = top - 30 - i * 30
        col = ROLE_COLOR.get(b.label, GOLD)
        p.c.setFillColor(col)
        p.c.roundRect(lx, yy - 2, 10, 10, 2, stroke=0, fill=1)
        p.text(lx + 18, yy, b.label, "semi", 10, INK)
        p.display(lx + 112, yy - 1, str(int(b.value)), 16, col)
        share = (b.value / total * 100) if total else 0
        p.text(lx + 134, yy, f"{share:.0f}%", "number", 9, MUTED)
    for i, (label, value) in enumerate(r.mix_detail):
        yy = top - 30 - i * 40
        p.kicker(W - M - 130, yy + 2, label, color=MUTED, size=6.5)
        p.text(W - M - 130, yy - 12, value, "semi", 11, INK)
    # The same mix as one stacked bar, the reference book's form of it.
    bx, bw = M + 14, W - 2 * M - 28
    x = bx
    for b in r.role_mix:
        w = bw * b.value / total
        if w > 0:
            p.c.setFillColor(ROLE_COLOR.get(b.label, GOLD))
            p.c.rect(x, y - h + 16, w, 14, stroke=0, fill=1)
            if w > 22:
                p.text(x + w / 2, y - h + 20, str(int(b.value)), "number", 8, BG, align="center")
            x += w
    y -= h + 12

    # --- the squad, by role ---------------------------------------------------
    h = y - 50
    top = p.panel(M, y, W - 2 * M, h, "the squad by role")
    cw = (W - 2 * M - 28) / 4
    for col, role in enumerate(["BAT", "WK", "AR", "BOWL"]):
        name = ROLE_SHORT_NAME[role]
        x = M + 14 + col * cw
        p.chip(x, top - 4, f"{name}s".replace("Wicket-keepers", "Keepers"), ROLE_COLOR[name])
        mine = [s for s in r.buys if s.role_short == role]
        for i, s in enumerate(mine[: int((h - 50) // 22)]):
            yy = top - 26 - i * 22
            nm = s.name
            while p.width(nm, "semi", 8) > cw - 50 and len(nm) > 4:
                nm = nm[:-2] + "…"
            p.text(x, yy, nm, "semi", 8, INK)
            p.text(x + cw - 12, yy, money(s.price), "number", 7.5, GOLD, align="right")
            tags = ("OS " if s.overseas else "") + ("UNCAPPED" if s.uncapped else "")
            if tags:
                p.text(x, yy - 9, tags, "body", 6, MUTED)
    p.footer("squad dna")


def _value_for_money(p: Pen) -> None:
    r = p.r
    y = p.header(
        6, "value for money", "who bought runs and wickets cheapest",
        f"Career IPL records for {len(r.value_points)} of {_possessive(r.team.get('name', ''))} signings with "
        "10 or more matches. Impact is career runs + 25 × career wickets, so a wicket counts "
        "like 25 runs. Players without a record are left out."
        + (f" Records run through IPL {r.season_through}." if r.season_through else ""),
    )
    h = 210
    top = p.panel(M, y, W - 2 * M, h)
    gx, gy, gw, gh = M + 48, y - h + 34, W - 2 * M - 70, h - 54
    pts = r.value_points
    max_x = max((s.price for s in pts), default=100) * 1.08 or 100
    max_y = max((s.impact for s in pts), default=100) * 1.12 or 100
    p.c.setStrokeColor(PANEL_EDGE)
    p.c.setLineWidth(0.4)
    for i in range(5):
        yy = gy + gh * i / 4
        p.c.line(gx, yy, gx + gw, yy)
        p.text(gx - 6, yy - 3, f"{max_y * i / 4:,.0f}", "number", 6.5, FAINT, align="right")
        xx = gx + gw * i / 4
        p.text(xx, gy - 12, money(max_x * i / 4), "number", 6.5, FAINT, align="center")
    p.kicker(gx, gy + gh + 6, "career impact (runs + 25 × wickets) ↑", color=MUTED, size=6)
    p.kicker(gx + gw - 70, gy - 24, "price paid →", color=MUTED, size=6)
    labelled = {s.player_id for s, _ in r.steals[:3]} | {s.player_id for s, _ in r.paid_for_potential[:2]}
    labelled |= {s.player_id for s in sorted(pts, key=lambda s: -s.impact)[:3]}
    for s in pts:
        px, py = gx + gw * s.price / max_x, gy + gh * s.impact / max_y
        role = ROLE_SHORT_NAME.get(s.role_short, "Batter")
        p.c.setFillColor(ROLE_COLOR.get(role, GOLD))
        p.c.circle(px, py, 3.4, stroke=0, fill=1)
        if s.player_id in labelled:
            p.text(px + 5, py + 2, s.name.split()[-1], "semi", 7, INK)
    if not pts:
        p.para(gx, gy + gh / 2, "No signing has a career long enough to price.", gw, color=MUTED)
    y -= h + 12

    half = (W - 2 * M - 12) / 2
    h = 178
    top = p.panel(M, y, half, h, "steals — most impact per crore")
    for i, (s, per) in enumerate(r.steals):
        yy = top - 4 - i * 23
        p.text(M + 14, yy, str(i + 1), "number", 8, FAINT)
        p.text(M + 28, yy, s.name[:22], "semi", 8.5, INK)
        rec = f"{s.runs or 0:,}r · {s.wickets or 0}w · {s.matches}m"
        p.text(M + 28, yy - 9, rec, "body", 6.5, MUTED)
        p.text(M + half - 64, yy, money(s.price), "number", 8, GOLD, align="right")
        p.text(M + half - 14, yy, f"{per:,.0f}", "number", 8.5, GOOD, align="right")
    if not r.steals:
        p.para(M + 14, top - 4, "Not enough signings with a record.", half - 28, color=MUTED)

    top2 = p.panel(M + half + 12, y, half, h, "paid for potential — least impact per crore")
    for i, (s, per) in enumerate(r.paid_for_potential):
        yy = top2 - 4 - i * 23
        p.text(M + half + 26, yy, s.name[:22], "semi", 8.5, INK)
        p.text(M + half + 26, yy - 9, f"{s.runs or 0:,}r · {s.wickets or 0}w", "body", 6.5, MUTED)
        p.text(W - M - 64, yy, money(s.price), "number", 8, GOLD, align="right")
        p.text(W - M - 14, yy, f"{per:,.0f}", "number", 8.5, WARN, align="right")
    if not r.paid_for_potential:
        p.para(M + half + 26, top2 - 4, "Too few priced careers to name any.", half - 30, color=MUTED)
    y -= h + 12

    h = y - 50
    top = p.panel(M, y, half, h, "career leaders bought")
    p.kicker(M + 14, top - 2, "runs", color=ROLE_COLOR["Batter"], size=6.5)
    for i, s in enumerate(r.run_leaders):
        p.text(M + 14, top - 16 - i * 13, f"{s.runs:,}", "number", 8, INK)
        p.text(M + 52, top - 16 - i * 13, s.name[:16], "body", 8, BODY)
    p.kicker(M + half / 2 + 6, top - 2, "wickets", color=ROLE_COLOR["Bowler"], size=6.5)
    for i, s in enumerate(r.wicket_leaders):
        p.text(M + half / 2 + 6, top - 16 - i * 13, f"{s.wickets}", "number", 8, INK)
        p.text(M + half / 2 + 34, top - 16 - i * 13, s.name[:16], "body", 8, BODY)
    top = p.panel(M + half + 12, y, half, h, "does experience get paid?")
    p.bars(M + half + 24, top, half - 24, r.experience_bands, label_w=86, value_w=84,
           row=min(22, (h - 50) / 4), color=colors.HexColor("#38BDF8"))
    p.footer("value for money")


def _career_record(p: Pen) -> None:
    r = p.r
    y = p.header(
        7, "power ranking", "the squad by career record",
        "Every signing's IPL career record added up: a reading of what this franchise "
        "assembled at the table — a form guide, not a verdict.",
    )
    h = 120
    top = p.panel(M, y, W - 2 * M, h, "combined impact points (runs + 25 × wickets)")
    p.display(M + 14, top - 44, f"{r.combined_impact:,}", 44, GOLD)
    p.kicker(M + 14, top - 60, "impact points", color=MUTED, size=6.5)
    bx = M + 230
    runs_share = r.total_runs / r.combined_impact if r.combined_impact else 0
    p.bar(bx, top - 30, W - M - 14 - bx, 16, BG_2, radius=4)
    p.bar(bx, top - 30, (W - M - 14 - bx) * runs_share, 16, ROLE_COLOR["Batter"], radius=4)
    wk_w = (W - M - 14 - bx) * (1 - runs_share) if r.combined_impact else 0
    p.bar(bx + (W - M - 14 - bx) * runs_share, top - 30, wk_w, 16, ROLE_COLOR["Bowler"], radius=4)
    p.text(bx, top - 48, f"{r.total_runs:,} career runs", "semi", 9, ROLE_COLOR["Batter"])
    p.text(W - M - 14, top - 48, f"{r.total_wickets:,} wickets × 25 = {r.total_wickets * 25:,}",
           "semi", 9, ROLE_COLOR["Bowler"], align="right")
    character = ("Batting-heavy" if runs_share > 0.6 else "Bowling-heavy" if runs_share < 0.4 else "Balanced")
    per_crore = r.combined_impact / (r.spent / 100) if r.spent else 0
    p.text(bx, top - 70, f"Character: {character}  ·  {per_crore:,.0f} impact points per crore spent",
           "body", 8.5, BODY)
    y -= h + 12

    half = (W - 2 * M - 12) / 2
    longest = max(len(r.batting_depth), len(r.bowling_depth), 3)
    h = min(y - 50, 56 + longest * 30)
    top = p.panel(M, y, half, h, "batting depth — career runs")
    row = min(30, (h - 44) / max(1, len(r.batting_depth)))
    p.bars(M + 12, top, half - 24, r.batting_depth, label_w=92, value_w=66, row=row,
           color=ROLE_COLOR["Batter"])
    if not r.batting_depth:
        p.para(M + 14, top - 6, "No career runs recorded for this squad.", half - 28, color=MUTED)
    top = p.panel(M + half + 12, y, half, h, "bowling depth — career wickets")
    row = min(30, (h - 44) / max(1, len(r.bowling_depth)))
    p.bars(M + half + 24, top, half - 24, r.bowling_depth, label_w=92, value_w=56, row=row,
           color=ROLE_COLOR["Bowler"])
    if not r.bowling_depth:
        p.para(M + half + 26, top - 6, "No career wickets recorded for this squad.", half - 30, color=MUTED)
    p.footer("power ranking")


def _awards_page(p: Pen) -> None:
    r = p.r
    y = p.header(8, "auction honours", "the awards nobody asked for",
                 "Strictly unofficial. Decided by the numbers, not the committee — and the same "
                 "in every franchise's report.")
    half = (W - 2 * M - 12) / 2
    card_h = 52
    rows = math.ceil(len(r.awards) / 2)
    for i, a in enumerate(r.awards):
        col, row = i % 2, i // 2
        x = M + col * (half + 12)
        ty = y - row * (card_h + 8)
        tc = _hex(a.team_color)
        mine = a.team_name == r.team.get("name")
        p.panel(x, ty, half, card_h, edge=_lift(tc) if mine else None)
        p.c.setFillColor(tc)
        p.c.roundRect(x, ty - card_h, 4, card_h, 2, stroke=0, fill=1)
        p.kicker(x + 14, ty - 15, a.title, color=MUTED, size=6.3)
        p.display(x + 14, ty - 33, a.team_name.upper(), 15, _lift(tc))
        p.text(x + 14, ty - 44, a.detail, "body", 7.5, BODY)
    if not r.awards:
        p.para(M, y, "No awards: nothing was sold in this room.", W - 2 * M, color=MUTED)
    y -= rows * (card_h + 8) + 6

    if r.comeback_kings and y > 140:
        h = y - 50
        top = p.panel(M, y, W - 2 * M, h, "comeback kings — unsold first, bought later")
        per_col = max(1, min(int((h - 40) // 20), math.ceil(len(r.comeback_kings) / 2)))
        cw = (W - 2 * M - 28) / 2
        for i, s in enumerate(r.comeback_kings[: per_col * 2]):
            col, row = i // per_col, i % per_col
            x = M + 14 + col * (cw + 14)
            yy = top - 6 - row * 20
            p.text(x, yy, s.name[:20], "semi", 8.5, INK)
            p.text(x + cw * 0.42, yy, s.team_name[:18], "semi", 7.5, _lift(_hex(s.team_color)))
            p.text(x + cw * 0.75, yy, f"round {s.unsold_before + 1}", "body", 7.5, MUTED)
            p.text(x + cw - 4, yy, money(s.price), "number", 8, GOLD, align="right")
    p.footer("awards")


def _verdict(p: Pen) -> None:
    r, card = p.r, p.r.card
    y = p.header(9, "the auctoniq verdict", "how the auction rates",
                 "AUCTONIQ's own rating of this franchise's auction: squad balance, value "
                 "found, squad quality and use of the purse, each with the arithmetic behind it.")
    if card is None:
        p.para(M, y, "The rating could not be computed for this room.", W - 2 * M, color=MUTED)
        p.footer("verdict")
        return
    h = 130
    top = p.panel(M, y, W - 2 * M, h)
    score_col = GOOD if card.overall >= 7 else WARN if card.overall >= 5 else BAD
    p.display(M + 20, top - 70, f"{card.overall:.1f}", 64, score_col)
    p.text(M + 20 + p.width(f"{card.overall:.1f}", "display", 64) + 6, top - 70, "/ 10", "number", 14, MUTED)
    p.para(M + 200, top - 26, card.verdict_line, W - 2 * M - 220, font="bold", size=13, color=INK)
    if card.best:
        p.para(M + 200, top - 66,
               f"Best bid: {card.best.name} for {money(card.best.price)} — a {card.best.verdict} "
               f"against an expected {money(card.best.expected)}.",
               W - 2 * M - 220, size=9, color=BODY)
    y -= h + 12

    labels = {"balance": "Squad balance", "steals": "Value found", "rating": "Squad quality",
              "budget": "Use of the purse"}
    h = 52
    for key in ("balance", "steals", "rating", "budget"):
        score = card.components[key]
        top = p.panel(M, y, W - 2 * M, h)
        p.text(M + 14, top - 2, labels[key], "bold", 10, INK)
        p.text(M + 150, top - 2, f"weight {WEIGHTS[key]:.0%}", "body", 7, MUTED)
        p.bar(M + 14, top - 18, 180, 7, BG_2)
        p.bar(M + 14, top - 18, 180 * score.value / 10, 7,
              GOOD if score.value >= 7 else WARN if score.value >= 5 else BAD)
        p.display(M + 206, top - 20, f"{score.value:.1f}", 14, INK)
        p.para(M + 240, top - 2, score.detail, W - 2 * M - 256, size=7.5, color=BODY, leading=10)
        y -= h + 8

    h = y - 50
    top = p.panel(M, y, W - 2 * M, h, "watch-outs")
    yy = top - 4
    for point in card.weak_points[:8]:
        p.c.setFillColor(WARN)
        p.c.circle(M + 18, yy + 3, 2, stroke=0, fill=1)
        yy = p.para(M + 28, yy, point, W - 2 * M - 44, size=8.5, color=BODY) - 4
        if yy < y - h + 20:
            break
    p.footer("verdict")


def render_franchise_pdf(report: FranchiseReport) -> bytes:
    """The whole document, as bytes."""
    _register_fonts()
    buffer = io.BytesIO()
    c = rl_canvas.Canvas(buffer, pagesize=A4)
    c.setTitle(f"AUCTONIQ auction report — {report.team.get('name')}")
    c.setAuthor("AUCTONIQ")
    c.setSubject(f"Auction room {report.room_code}")
    pen = Pen(c, report)
    for page in (_cover, _day_in_numbers, _moments_page, _ten_most_expensive, _role_mix,
                 _value_for_money, _career_record, _awards_page, _verdict):
        page(pen)
    c.save()
    return buffer.getvalue()
