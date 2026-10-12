import datetime

import pytest
from google.genai import types

from app import usage


def meta(prompt=0, cached=0, output=0, thoughts=0):
    return types.GenerateContentResponseUsageMetadata(
        prompt_token_count=prompt,
        cached_content_token_count=cached,
        candidates_token_count=output,
        thoughts_token_count=thoughts,
    )


M = 1_000_000


@pytest.mark.parametrize(
    "model, location, day, expected",
    [
        ("gemini-2.5-flash-001", "global", None, 0.30 + 2.50),       # prefix match
        ("gemini-3.5-flash", "us-central1", None, 1.65 + 9.90),      # regional rate
        ("gemini-3.8-flash", "global", datetime.date(2026, 12, 31), 0.75 + 3.75),  # promo
        ("gemini-3.8-flash", "global", datetime.date(2027, 1, 1), 1.50 + 7.50),    # after promo
    ],
)
def test_cost_per_million(model, location, day, expected):
    call = usage.call_usage(model, meta(prompt=M, output=M), location, day)
    assert call["cost_known"]
    assert call["cost"] == pytest.approx(expected)


def test_long_context_cached_and_thinking():
    # 300k prompt (> 200k tier), 100k of it cached, 1k output + 1k thinking.
    call = usage.call_usage("gemini-2.5-pro", meta(300_000, 100_000, 1_000, 1_000), "global")
    expected = (200_000 * 2.50 + 100_000 * 0.25 + 2_000 * 15.00) / M
    assert call["cost"] == pytest.approx(expected)
    assert call["context_tokens"] == 302_000


def test_unknown_model_has_tokens_but_no_cost():
    call = usage.call_usage("some-other-model", meta(100, 0, 10), "global")
    assert not call["cost_known"] and call["cost"] == 0 and call["input"] == 100


def test_tracker_sessions_and_ledger(tmp_path):
    log = tmp_path / "usage.jsonl"
    t = usage.Tracker(log)
    c = usage.call_usage("gemini-2.5-flash", meta(M, 0, 0), "global")
    t.record("a", c)
    t.record("a", c)
    t.record("b", c)
    assert t.summary("a")["session"]["calls"] == 2
    assert t.summary("b")["session"]["input"] == M
    assert t.summary(None)["all_time"]["cost"] == pytest.approx(0.90)
    # All-time totals are rebuilt from the ledger after a restart.
    assert usage.Tracker(log).all_time["cost"] == pytest.approx(0.90)
