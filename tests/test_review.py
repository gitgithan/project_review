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
    (src / "agents/agent.py").write_text(
        "from google.adk.agents import Agent\n"
        'KEY = "AIza' + "A" * 35 + '"\n'
        "def tool(tool_context):\n"
        '    tool_context.state["rows"] = []\n'
        'root_agent = Agent(name="a", model="gemini-2.5-flash", output_key="x")\n'
    )
    (src / "requirements.txt").write_text("google-adk\npandas==2.2.0\n")
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
    assert "Session state writes" in checks["adk"]
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
