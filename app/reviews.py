"""Saved architecture reviews: one Markdown file plus a JSON sidecar each.

Reviews describe student work, so they live in a git-ignored folder like the
cloned projects.
"""

from __future__ import annotations

import datetime
import json
import os
import re
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
REVIEWS_DIR = Path(os.environ.get("REVIEWS_DIR", ROOT_DIR / "reviews")).resolve()

_ID_RE = re.compile(r"^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+__\d{8}-\d{6}$")


class ReviewNotFound(Exception):
    pass


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.") or "head"


def save(project: str, branch: str | None, commit: str, model: str,
         markdown_text: str, stats: dict, usage: dict) -> dict:
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now()
    review_id = f"{project}__{_slug(branch or 'HEAD')}__{now:%Y%m%d-%H%M%S}"
    meta = {
        "id": review_id,
        "project": project,
        "branch": branch,
        "commit": commit,
        "model": model,
        "created": now.isoformat(timespec="seconds"),
        "stats": stats,
        "usage": usage,
    }
    (REVIEWS_DIR / f"{review_id}.md").write_text(markdown_text, encoding="utf-8")
    (REVIEWS_DIR / f"{review_id}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def get(review_id: str) -> tuple[dict, str]:
    if not _ID_RE.match(review_id or ""):
        raise ReviewNotFound(review_id)
    md_path = REVIEWS_DIR / f"{review_id}.md"
    meta_path = REVIEWS_DIR / f"{review_id}.json"
    if not md_path.is_file() or not meta_path.is_file():
        raise ReviewNotFound(review_id)
    return json.loads(meta_path.read_text(encoding="utf-8")), md_path.read_text(encoding="utf-8")


def list_reviews(project: str | None = None) -> list[dict]:
    if not REVIEWS_DIR.is_dir():
        return []
    metas = []
    for path in REVIEWS_DIR.glob("*.json"):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if project is None or meta.get("project") == project:
            metas.append(meta)
    return sorted(metas, key=lambda m: m.get("created", ""), reverse=True)


def title(meta: dict) -> str:
    where = meta["project"] + (f" @ {meta['branch']}" if meta.get("branch") else "")
    return f"Architecture Review: {where}"


def subtitle(meta: dict) -> str:
    created = meta.get("created", "").replace("T", " ")
    return f"Commit {meta['commit'][:10]} · {created} · {meta.get('model', '')} · static analysis"


def pdf_filename(meta: dict) -> str:
    return f"review-{_slug(meta['project'])}-{_slug(meta.get('branch') or 'HEAD')}-{meta['created'][:10]}.pdf"
