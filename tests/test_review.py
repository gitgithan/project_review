import json
import subprocess

import pytest

from review_agent import repos, review


def _git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@x", *args],
        cwd=cwd, check=True, capture_output=True,
    )


@pytest.fixture
def capstone(tmp_path, monkeypatch):
    monkeypatch.setattr(repos, "PROJECTS_DIR", tmp_path / "projects")
    src = tmp_path / "capstone"
    for d in ("agents", "data/raw", "node_modules/x", "notebooks"):
        (src / d).mkdir(parents=True)
    _git(src, "init", "-q", "-b", "main")
    (src / "agents/agent.py").write_text(  # folder name kept: any source path works
        "import pandas as pd\n"
        'KEY = "AIza' + "A" * 35 + '"\n'
        "def load(engine):\n"
        '    df = pd.read_csv("data/raw/a.csv")\n'
        "    for _, row in df.iterrows():\n"
        "        pass\n"
        '    df.to_sql("t", engine, if_exists="replace")\n'
    )
    (src / "requirements.txt").write_text("sqlalchemy\npandas==2.2.0\n")
    (src / "docker-compose.yml").write_text(
        "services:\n  db:\n    image: postgres:latest\n    environment:\n      POSTGRES_PASSWORD: hunter22\n"
    )
    (src / "deploy.sh").write_text("gcloud run deploy api --source .\n")
    (src / "data/raw/a.csv").write_text("id,v\n" + "".join(f"{i},{i}\n" for i in range(1000)))
    (src / "data/raw/b.csv").write_text("id,v\n1,2\n")
    (src / "data/model.parquet").write_bytes(b"PAR1\0\0\0")
    (src / "node_modules/x/index.js").write_text("module.exports = 1\n")
    nb = {"cells": [{"cell_type": "code", "source": ["import pandas as pd\n"],
                     "outputs": [{"output_type": "stream", "text": ["OUTPUT" * 1000]}]}],
          "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    (src / "notebooks/eda.ipynb").write_text(json.dumps(nb))
    _git(src, "add", ".")
    _git(src, "commit", "-qm", "capstone")
    repos.clone_project(f"file://{src}")
    return "capstone"


@pytest.mark.parametrize("path, size, expected", [
    ("src/app.py", 100, "source"),
    ("data/raw/x.csv", 100, "data"),
    ("x.parquet", 10, "data"),
    ("config/settings.json", 500, "source"),
    ("dumps/big.json", 5_000_000, "data"),
    ("node_modules/a/b.js", 10, "skip"),
    ("package-lock.json", 10, "skip"),
    ("docs/diagram.png", 10, "skip"),
])
def test_classify(path, size, expected):
    assert review.classify(path, size) == expected


def test_collect(capstone):
    pack = review.collect(capstone, "HEAD", "main")
    st = pack.stats
    assert st["data_files"] == 3 and st["skipped_files"] == 1
    assert st["data_sampled"] == 2  # one per (type, folder): data/raw csv + parquet
    msg = pack.message
    assert "### agents/agent.py" in msg and "### node_modules" not in msg
    assert "OUTPUTOUTPUT" not in msg  # notebook outputs dropped
    assert "import pandas as pd" in msg
    assert "999,999" not in msg  # data files are sampled, not inlined

    checks = json.loads(msg.split("```json\n", 1)[1].split("\n```", 1)[0])
    assert any("Google API key" in s for s in checks["possible_secrets"])
    assert any("postgres:latest" in s for s in checks["infra"])
    assert any("POSTGRES_PASSWORD" in s for s in checks["infra"])
    assert any("unpinned requirement" in s for s in checks["infra"])
    assert "adk" not in checks
    patterns = checks["data_patterns"]
    assert "agents/agent.py:5" in patterns["Row-by-row Pandas (iterrows/itertuples/apply)"]["where"]
    assert "Full-table overwrites" in patterns
    assert checks["deployment"]["verdict"] == "application deployment to Google Cloud found"


def test_budget_omits_files(capstone):
    pack = review.collect(capstone, "HEAD", "main", max_chars=200)
    assert pack.stats["source_omitted"] > 0
    assert "## Source files omitted for size" in pack.message


def test_review_pdf():
    pytest.importorskip("xhtml2pdf")
    from app.pdf import review_pdf

    md = ("## Section 2\n| A | B |\n|---|---|\n| `spark.read.csv(\"data/raw/*.csv\")` | x → y 🚀 |\n\n"
          "- item\n  - nested\n\n<img src='/etc/passwd'>")
    data = review_pdf(md, "Architecture Review: p @ main", "meta")
    assert data.startswith(b"%PDF")


def _pdf_text(data: bytes) -> str:
    import io

    from pypdf import PdfReader  # installed with xhtml2pdf
    return "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(data)).pages)


def test_review_pdf_falls_back_to_builtin_fonts(monkeypatch):
    pytest.importorskip("xhtml2pdf")
    from app import pdf

    monkeypatch.setattr(pdf, "_fonts", lambda: {"regular": "/nonexistent/font.ttf", "bold": None,
                                                "italic": None, "mono": None})
    data = pdf.review_pdf("Shift → BigQuery ≥ 10x", "Architecture Review: p", "meta")
    assert "Shift -> BigQuery >= 10x" in _pdf_text(data)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main, reviews

    monkeypatch.setattr(reviews, "REVIEWS_DIR", tmp_path / "reviews")
    meta = reviews.save("proj", "main", "a" * 40, "gemini-3.1-flash-lite", "## Section 1\nAll good.",
                        {"source_files": 3},
                        {"input": 123456, "output": 7890, "cost": 0.4321, "calls": 3, "cost_known": True})
    return TestClient(main.app), meta["id"]


def test_pdf_download_has_no_usage_or_cost(client):
    pytest.importorskip("xhtml2pdf")
    c, review_id = client
    res = c.get(f"/api/reviews/{review_id}/pdf")
    assert res.status_code == 200 and res.headers["content-type"] == "application/pdf"
    text = _pdf_text(res.content)
    assert "All good." in text
    for leak in ("$", "0.4321", "123456", "123,456", "7890", "token", "Token", "cost", "Cost"):
        assert leak not in text


def test_pdf_download_explains_missing_packages(client, monkeypatch):
    import sys

    c, review_id = client
    monkeypatch.setitem(sys.modules, "app.pdf", None)  # makes `from app.pdf import ...` fail
    res = c.get(f"/api/reviews/{review_id}/pdf")
    assert res.status_code == 503
    assert "pip install -r requirements.txt" in res.json()["detail"]


def test_review_brief_does_not_steer_towards_adk():
    import re

    brief = review.review_instruction()
    mentions = [ln for ln in brief.splitlines() if re.search(r"(?i)\badk\b|agent", ln)]
    # Agents/LLMs are only reviewed when present; nothing else in the brief points at them.
    assert len(mentions) == 1 and "(only if present)" in mentions[0]


def test_llm_frameworks_detected_only_when_used():
    plain = review.static_checks({"etl.py": "import pandas as pd\n"})
    assert not any("ADK" in t or "LLM" in t for t in plain["technologies"])
    with_adk = review.static_checks({"agent.py": "from google.adk.agents import Agent\n"})
    assert "Google ADK (agents)" in with_adk["technologies"]
