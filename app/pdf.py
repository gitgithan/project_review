"""Render a Markdown review to PDF (pure Python: markdown + xhtml2pdf)."""

from __future__ import annotations

import html as html_lib
import io
import re
from functools import lru_cache
from pathlib import Path

import markdown
from xhtml2pdf import pisa
from xhtml2pdf.config.resources import ResourceAccessPolicy

# Unicode TTF fonts to embed, first match wins. Without one, the built-in
# Helvetica/Courier are used and characters outside Latin-1 are transliterated.
FONT_CANDIDATES = {
    "regular": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "italic": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf",
        "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
        "/Library/Fonts/Arial Italic.ttf",
        "C:/Windows/Fonts/ariali.ttf",
    ],
    "mono": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/Library/Fonts/Courier New.ttf",
        "C:/Windows/Fonts/cour.ttf",
    ],
}

TRANSLITERATE = {
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "≥": ">=", "≤": "<=", "≠": "!=",
    "≈": "~", "×": "x", "–": "-", "—": "-", "‑": "-", "“": '"', "”": '"', "‘": "'",
    "’": "'", "…": "...", "•": "-", "✓": "[x]", "✔": "[x]", "✗": "[ ]", "✘": "[ ]",
    "⚠": "!", "\u200b": "", "\u00a0": " ",
}


@lru_cache(maxsize=1)
def _fonts() -> dict[str, str] | None:
    found = {}
    for kind, paths in FONT_CANDIDATES.items():
        found[kind] = next((p for p in paths if Path(p).is_file()), None)
    return found if found["regular"] else None


@lru_cache(maxsize=1)
def _font_charset() -> frozenset[int] | None:
    fonts = _fonts()
    if not fonts:
        return None
    try:
        from reportlab.pdfbase.ttfonts import TTFont
        return frozenset(TTFont("probe", fonts["regular"]).face.charToGlyph)
    except Exception:
        return None


def _clean_text(text: str) -> str:
    """Replace characters the chosen font cannot draw (e.g. emoji)."""
    charset = _font_charset()

    def ok(ch: str) -> bool:
        if ch in "\n\t":
            return True
        if charset is not None:
            return ord(ch) in charset
        return ord(ch) < 256

    out = []
    for ch in text:
        if ok(ch):
            out.append(ch)
        elif ch in TRANSLITERATE:
            out.append(TRANSLITERATE[ch])
        elif ord(ch) > 0xFFFF or 0x2600 <= ord(ch) <= 0x27BF:  # emoji / symbols
            continue
        else:
            out.append("?")
    return "".join(out)


def _normalize_lists(text: str) -> str:
    """Python-Markdown nests lists on 4-space indents; LLMs often use 2."""
    lines = []
    in_fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
        m = None if in_fence else re.match(r"^( +)([-*+]|\d+[.)]) ", line)
        if m and len(m.group(1)) % 4:
            indent = len(m.group(1))
            line = " " * (indent * 2) + line[indent:]
        lines.append(line)
    return "\n".join(lines)


def _breakable_table_code(html: str) -> str:
    """Let long code tokens in table cells wrap (xhtml2pdf can't split words)."""

    def fix_code(m: re.Match) -> str:
        body = m.group(1)
        if len(body) <= 24:
            return m.group(0)
        return "<code>" + re.sub(r"([/.,(=_])(?=\S)", r"\1 ", body) + "</code>"

    def fix_cell(m: re.Match) -> str:
        return re.sub(r"<code>(.*?)</code>", fix_code, m.group(0), flags=re.S)

    return re.sub(r"<t[dh][^>]*>.*?</t[dh]>", fix_cell, html, flags=re.S)


def _policy() -> ResourceAccessPolicy:
    """No network access, and local reads only from the font folders.

    The review text is model output influenced by student code, so it must not
    be able to make the renderer fetch URLs or read other local files.
    """
    fonts = _fonts() or {}
    dirs = sorted({str(Path(p).parent) for p in fonts.values() if p})
    if not dirs:
        return ResourceAccessPolicy(allow_remote=False, base_dir=None)
    return ResourceAccessPolicy(allow_remote=False, base_dir=Path(dirs[0]),
                                extra_roots=[Path(d) for d in dirs[1:]])


def _css() -> str:
    fonts = _fonts()
    faces = ""
    body_font, mono_font = "Helvetica", "Courier"
    if fonts:
        faces += f'@font-face {{ font-family: Body; src: url("{fonts["regular"]}"); }}\n'
        if fonts["bold"]:
            faces += f'@font-face {{ font-family: Body; font-weight: bold; src: url("{fonts["bold"]}"); }}\n'
        if fonts["italic"]:
            faces += f'@font-face {{ font-family: Body; font-style: italic; src: url("{fonts["italic"]}"); }}\n'
        body_font = "Body"
        if fonts["mono"]:
            faces += f'@font-face {{ font-family: Mono; src: url("{fonts["mono"]}"); }}\n'
            mono_font = "Mono"
    return faces + f"""
@page {{
  size: a4 landscape;
  margin: 1.4cm 1.4cm 1.6cm 1.4cm;
  @frame footer {{ -pdf-frame-content: footer; bottom: 0.6cm; margin-left: 1.4cm; margin-right: 1.4cm; height: 0.6cm; }}
}}
body {{ font-family: {body_font}; font-size: 9.5pt; line-height: 1.35; color: #1f2328; }}
h1 {{ font-size: 17pt; margin-bottom: 2pt; }}
h2 {{ font-size: 13pt; margin-top: 14pt; padding-bottom: 2pt; border-bottom: 0.75pt solid #d0d7de; }}
h3 {{ font-size: 11pt; margin-top: 10pt; }}
h4 {{ font-size: 10pt; margin-top: 8pt; }}
.meta {{ color: #656d76; font-size: 8.5pt; margin-bottom: 8pt; }}
table {{ width: 100%; border: 0.5pt solid #d0d7de; margin: 6pt 0; }}
th {{ background-color: #f6f8fa; font-weight: bold; text-align: left; }}
th, td {{ border: 0.5pt solid #d0d7de; padding: 3pt; vertical-align: top; font-size: 8.5pt; }}
code {{ font-family: {mono_font}; font-size: 8.5pt; background-color: #f6f8fa; }}
pre {{ font-family: {mono_font}; font-size: 8pt; background-color: #f6f8fa; padding: 5pt; border: 0.5pt solid #d0d7de; }}
blockquote {{ color: #656d76; margin-left: 8pt; padding-left: 6pt; border-left: 2pt solid #d0d7de; }}
li {{ margin-bottom: 1pt; }}
#footer {{ font-size: 7.5pt; color: #656d76; text-align: right; }}
"""


def review_pdf(markdown_text: str, title: str, meta: str) -> bytes:
    body = markdown.markdown(
        _normalize_lists(_clean_text(markdown_text)),
        extensions=["tables", "fenced_code", "sane_lists"],
    )
    body = _breakable_table_code(body)
    doc = (
        "<html><head><meta charset='utf-8'><style>" + _css() + "</style></head><body>"
        f"<h1>{html_lib.escape(_clean_text(title))}</h1>"
        f"<div class='meta'>{html_lib.escape(_clean_text(meta))}</div>"
        f"{body}"
        "<div id='footer'>Page <pdf:pagenumber> of <pdf:pagecount></div>"
        "</body></html>"
    )
    out = io.BytesIO()
    result = pisa.CreatePDF(doc, dest=out, encoding="utf-8", resource_policy=_policy())
    if result.err:
        raise RuntimeError("PDF rendering failed")
    return out.getvalue()
