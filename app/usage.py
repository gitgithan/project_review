"""Token usage and cost tracking, in the spirit of Cline's task header.

Prices come from pricing.json (USD per 1M tokens). Every model call is appended
to a JSONL ledger so the all-time spend survives restarts.
"""

from __future__ import annotations

import datetime
import json
import os
import threading
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
PRICING_FILE = Path(os.environ.get("PRICING_FILE", ROOT_DIR / "pricing.json"))
USAGE_LOG = Path(os.environ.get("USAGE_LOG", ROOT_DIR / "usage_log.jsonl"))

_FIELDS = ("input", "output", "cached", "thoughts", "calls")
_lock = threading.Lock()


def _load_pricing() -> dict:
    try:
        return json.loads(PRICING_FILE.read_text())["models"]
    except (OSError, ValueError, KeyError):
        return {}


PRICING = _load_pricing()


def price_for(model: str) -> dict | None:
    """Pricing entry whose id is the longest prefix of `model`."""
    model = (model or "").split("/")[-1]
    matches = [k for k in PRICING if model.startswith(k)]
    return PRICING[max(matches, key=len)] if matches else None


def empty() -> dict:
    return {**{f: 0 for f in _FIELDS}, "cost": 0.0, "cost_known": True}


def _rates(price: dict, prompt_tokens: int, location: str, today: datetime.date) -> dict:
    """Pick the rates that apply to one request."""
    rates = {k: price[k] for k in ("input", "output", "cached_input") if k in price}
    regional = location.lower() != "global"
    if regional:
        rates.update(price.get("non_global", {}))
    for promo in price.get("promotions", []):
        if today <= datetime.date.fromisoformat(promo["until"]):
            rates.update({k: promo[k] for k in ("input", "output", "cached_input") if k in promo})
            if regional:
                rates.update(promo.get("non_global", {}))
            break
    long_ctx = price.get("long_context")
    if long_ctx and prompt_tokens > long_ctx["threshold_tokens"]:
        rates.update({k: long_ctx[k] for k in ("input", "output", "cached_input") if k in long_ctx})
    rates.setdefault("cached_input", rates["input"])
    return rates


def call_usage(model: str, usage_metadata, location: str | None = None, today=None) -> dict:
    """Token counts and cost of one model call from genai usage metadata."""
    prompt = usage_metadata.prompt_token_count or 0
    prompt += usage_metadata.tool_use_prompt_token_count or 0
    cached = usage_metadata.cached_content_token_count or 0
    output = usage_metadata.candidates_token_count or 0
    thoughts = usage_metadata.thoughts_token_count or 0

    location = location or os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
    price = price_for(model)
    cost = None
    if price:
        r = _rates(price, prompt, location, today or datetime.date.today())
        cost = (
            (prompt - cached) * r["input"]
            + cached * r["cached_input"]
            + (output + thoughts) * r["output"]
        ) / 1_000_000
    return {
        "model": model,
        "input": prompt,
        "cached": cached,
        "output": output,
        "thoughts": thoughts,
        "calls": 1,
        "cost": cost or 0.0,
        "cost_known": cost is not None,
        "context_tokens": prompt + output + thoughts,
        "context_window": price.get("context_window") if price else None,
    }


def add(total: dict, call: dict) -> dict:
    for f in _FIELDS:
        total[f] += call[f]
    total["cost"] += call["cost"]
    total["cost_known"] = total["cost_known"] and call["cost_known"]
    return total


class Tracker:
    """Per-session totals in memory plus an all-time ledger on disk."""

    def __init__(self, log_path: Path = USAGE_LOG):
        self.log_path = log_path
        self.sessions: dict[str, dict] = {}
        self.all_time = empty()
        self._load_ledger()

    def _load_ledger(self) -> None:
        try:
            with self.log_path.open() as f:
                for line in f:
                    try:
                        add(self.all_time, json.loads(line))
                    except (ValueError, KeyError):
                        continue
        except OSError:
            pass

    def session(self, session_id: str) -> dict:
        return self.sessions.setdefault(session_id, empty())

    def record(self, session_id: str, call: dict) -> None:
        with _lock:
            add(self.session(session_id), call)
            add(self.all_time, call)
            try:
                with self.log_path.open("a") as f:
                    f.write(json.dumps({"ts": time.time(), "session_id": session_id, **call}) + "\n")
            except OSError:
                pass

    def summary(self, session_id: str | None) -> dict:
        return {
            "session": dict(self.session(session_id)) if session_id else empty(),
            "all_time": dict(self.all_time),
        }
