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


@pytest.mark.parametrize("url", ["--upload-pack=touch x", "/etc/passwd"])
def test_rejects_bad_urls(upstream, url):
    with pytest.raises(repos.RepoError):
        repos.clone_project(url)


@pytest.mark.parametrize("name", ["..", "a/b"])
def test_rejects_bad_project_names(upstream, name):
    with pytest.raises(repos.RepoError):
        repos.project_path(name)


def test_branches(upstream):
    _git(upstream, "checkout", "-q", "-b", "feature/login")
    (upstream / "login.py").write_text("def login(): pass\n")
    _git(upstream, "add", ".")
    _git(upstream, "commit", "-qm", "add login")
    _git(upstream, "checkout", "-q", "main")
    repos.clone_project(f"file://{upstream}")

    branches = repos.list_branches("student")
    assert [b["name"] for b in branches] == ["main", "feature/login"]
    assert branches[0]["default"] and not branches[1]["default"]

    main = [c["subject"] for c in repos.list_commits("student", branch="main")]
    feature = [c["subject"] for c in repos.list_commits("student", branch="feature/login")]
    assert main == ["second", "first"]
    assert feature == ["add login", "second", "first"]
    assert len(repos.list_commits("student")) == 3  # all branches
    tip = repos.list_commits("student", branch="feature/login")[0]["sha"]
    assert repos.read_file("student", tip, "login.py").status == "ok"
    with pytest.raises(repos.RepoError, match="Unknown branch"):
        repos.list_commits("student", branch="nope")

    # New branches appear and deleted ones disappear after Update.
    _git(upstream, "branch", "-q", "hotfix")
    _git(upstream, "branch", "-q", "-D", "feature/login")
    repos.update_project("student")
    assert sorted(b["name"] for b in repos.list_branches("student")) == ["hotfix", "main"]


def test_commit_graph_lanes(upstream):
    # main: first, second, then merge of feature; feature/x branched from second.
    _git(upstream, "checkout", "-q", "-b", "feature/x")
    (upstream / "f.py").write_text("x = 1\n")
    _git(upstream, "add", ".")
    _git(upstream, "commit", "-qm", "feature work")
    _git(upstream, "checkout", "-q", "-b", "wip", "main")
    (upstream / "w.py").write_text("w = 1\n")
    _git(upstream, "add", ".")
    _git(upstream, "commit", "-qm", "wip work")
    _git(upstream, "checkout", "-q", "main")
    _git(upstream, "merge", "-q", "--no-ff", "-m", "merge feature", "feature/x")
    _git(upstream, "branch", "-q", "-D", "feature/x")  # merged and deleted
    repos.clone_project(f"file://{upstream}")

    g = repos.commit_graph("student")
    lane_names = [lane["branch"] for lane in g["lanes"]]
    assert lane_names[0] == "main" and "wip" in lane_names
    by_subject = {c["subject"]: c for c in g["commits"]}
    main_lane = 0
    assert by_subject["first"]["lane"] == main_lane
    assert by_subject["merge feature"]["lane"] == main_lane
    assert by_subject["wip work"]["lane"] == lane_names.index("wip")
    # The deleted branch's commit gets an unnamed lane.
    assert g["lanes"][by_subject["feature work"]["lane"]]["branch"] is None
    xs = [c["x"] for c in g["commits"]]
    assert sorted(xs) == list(range(len(xs))) and by_subject["first"]["x"] == 0
