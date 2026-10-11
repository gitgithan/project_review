import subprocess

import pytest

from review_agent import repos


def _git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@x", *args],
        cwd=cwd, check=True, capture_output=True,
    )


@pytest.fixture
def upstream(tmp_path, monkeypatch):
    monkeypatch.setattr(repos, "PROJECTS_DIR", tmp_path / "projects")
    src = tmp_path / "student"
    src.mkdir()
    _git(src, "init", "-q", "-b", "main")
    (src / "calc.py").write_text("def add(a, b):\n    return a + b\n")
    (src / "blob.bin").write_bytes(b"\0" * 100)
    _git(src, "add", ".")
    _git(src, "commit", "-qm", "first")
    (src / "calc.py").write_text("def add(a, b):\n    '''Sum.'''\n    return a + b\n")
    _git(src, "commit", "-qam", "second")
    return src


def test_clone_history_and_files(upstream):
    info = repos.clone_project(f"file://{upstream}")
    assert info["name"] == "student"
    assert info["commit_count"] == 2
    with pytest.raises(repos.RepoError, match="Already cloned"):
        repos.clone_project(f"file://{upstream}")

    commits = repos.list_commits("student")
    assert [c["subject"] for c in commits] == ["second", "first"]
    detail = repos.commit_detail("student", commits[0]["sha"])
    assert detail["changes"] == [{"status": "M", "path": "calc.py"}]
    assert {f["path"] for f in repos.list_files("student", "HEAD")} == {"calc.py", "blob.bin"}


def test_preview_limits(upstream):
    repos.clone_project(f"file://{upstream}")
    assert repos.read_file("student", "HEAD", "calc.py").status == "ok"
    assert repos.read_file("student", "HEAD", "blob.bin").status == "binary"
    assert repos.read_file("student", "HEAD", "calc.py", max_bytes=10).status == "too_large"


def test_diff_compare_grep(upstream):
    repos.clone_project(f"file://{upstream}")
    first = repos.list_commits("student")[1]["sha"]
    assert "+    '''Sum.'''" in repos.file_diff("student", "HEAD", "calc.py")["diff"]
    cmp = repos.compare_files("student", first, "calc.py", "student", "HEAD", "calc.py")
    assert 0.5 < cmp["line_similarity"] < 1 and not cmp["identical"]
    assert repos.grep("student", "HEAD", r"def add")[0]["path"] == "calc.py"


def test_update_follows_force_push(upstream):
    repos.clone_project(f"file://{upstream}")
    _git(upstream, "reset", "-q", "--hard", "HEAD~1")
    (upstream / "new.py").write_text("x = 1\n")
    _git(upstream, "add", ".")
    _git(upstream, "commit", "-qm", "rewritten")
    repos.update_project("student")
    assert [c["subject"] for c in repos.list_commits("student")][0] == "rewritten"
    assert repos.read_file("student", "HEAD", "new.py").text == "x = 1\n"


@pytest.mark.parametrize("url", ["--upload-pack=touch x", "not a url", "/etc/passwd"])
def test_rejects_bad_urls(upstream, url):
    with pytest.raises(repos.RepoError):
        repos.clone_project(url)


@pytest.mark.parametrize("name", ["..", "../x", "a/b", ""])
def test_rejects_bad_project_names(upstream, name):
    with pytest.raises(repos.RepoError):
        repos.project_path(name)
