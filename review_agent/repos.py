"""Read-only git helpers over the cloned student projects.

Everything here shells out to the `git` CLI. Student repositories live under
PROJECTS_DIR (default ./projects), which is git-ignored by this repo.
"""

from __future__ import annotations

import difflib
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", ROOT_DIR / "projects")).resolve()

# Files larger than this are not previewed (git shows "Binary files differ"
# or hides large diffs in the same spirit).
MAX_PREVIEW_BYTES = int(os.environ.get("MAX_PREVIEW_BYTES", 512 * 1024))
MAX_DIFF_BYTES = int(os.environ.get("MAX_DIFF_BYTES", 512 * 1024))

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SHA_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")
_URL_RE = re.compile(r"^(https?://|ssh://|git://|file://|[\w.-]+@[\w.-]+:)\S+$")

_GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",  # never hang waiting for credentials
    "GIT_ASKPASS": "true",
}


class RepoError(Exception):
    """A user-facing error from a git operation."""


def _git(repo: Path | None, *args: str, timeout: int = 60, check: bool = True) -> bytes:
    cmd = ["git"]
    if repo is not None:
        cmd += ["-C", str(repo)]
    cmd += list(args)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, env=_GIT_ENV, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired as e:
        raise RepoError(f"git {args[0]} timed out") from e
    if check and proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip() or f"git {args[0]} failed"
        raise RepoError(msg)
    return proc.stdout


# ---------------------------------------------------------------- projects


def _name_from_url(url: str) -> tuple[str, str]:
    """Return (repo, owner) parsed from a git URL."""
    tail = re.split(r"[/:]", url.rstrip("/"))
    repo = tail[-1] if tail else "project"
    owner = tail[-2] if len(tail) >= 2 else ""
    repo = re.sub(r"\.git$", "", repo)
    clean = lambda s: re.sub(r"[^A-Za-z0-9._-]", "_", s).strip("._") or "project"
    return clean(repo), clean(owner) if owner else ""


def clone_project(url: str) -> dict:
    """Clone `url` into PROJECTS_DIR and return its project info."""
    url = url.strip()
    if not _URL_RE.match(url) or url.startswith("-"):
        raise RepoError("That does not look like a git URL (https://, ssh:// or git@host:path).")

    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    repo, owner = _name_from_url(url)
    candidates = [repo] + ([f"{owner}__{repo}"] if owner else [])
    for existing in candidates:
        path = PROJECTS_DIR / existing
        if path.exists() and _remote_url(path) == url:
            raise RepoError(f"Already cloned as '{existing}'. Use Update to fetch new commits.")
    name = next((c for c in candidates if not (PROJECTS_DIR / c).exists()), None)
    if name is None:
        i = 2
        while (PROJECTS_DIR / f"{candidates[-1]}_{i}").exists():
            i += 1
        name = f"{candidates[-1]}_{i}"

    dest = PROJECTS_DIR / name
    try:
        _git(None, "clone", "--no-recurse-submodules", "--", url, str(dest), timeout=600)
    except RepoError:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    return project_info(name)


def _remote_url(path: Path) -> str:
    out = _git(path, "config", "--get", "remote.origin.url", check=False)
    return out.decode().strip()


def project_path(name: str) -> Path:
    if not _NAME_RE.match(name or "") or name in (".", ".."):
        raise RepoError(f"Invalid project name: {name!r}")
    path = PROJECTS_DIR / name
    if not (path / ".git").exists():
        raise RepoError(f"Unknown project: {name}")
    return path


def project_info(name: str) -> dict:
    path = project_path(name)
    head = _git(path, "rev-parse", "--abbrev-ref", "HEAD", check=False).decode().strip()
    count = _git(path, "rev-list", "--all", "--count", check=False).decode().strip()
    return {
        "name": name,
        "url": _remote_url(path),
        "branch": head,
        "commit_count": int(count) if count.isdigit() else 0,
    }


def list_projects() -> list[dict]:
    if not PROJECTS_DIR.exists():
        return []
    names = sorted(
        p.name for p in PROJECTS_DIR.iterdir() if p.is_dir() and (p / ".git").exists()
    )
    return [project_info(n) for n in names]


def update_project(name: str) -> dict:
    """Fetch the latest commits and move the checkout to the remote branch.

    These clones are read-only mirrors (nothing is committed locally), so the
    working copy is simply reset to its upstream; that also copes with a
    student force-pushing their branch.
    """
    path = project_path(name)
    before = project_info(name)["commit_count"]
    _git(path, "fetch", "--all", "--prune", "--tags", "--force", timeout=600)
    _git(path, "reset", "--hard", "@{u}", check=False)
    info = project_info(name)
    info["new_commits"] = max(0, info["commit_count"] - before)
    return info


def delete_project(name: str) -> None:
    shutil.rmtree(project_path(name))


# ---------------------------------------------------------------- commits


def resolve_commit(name: str, rev: str) -> str:
    path = project_path(name)
    if rev != "HEAD" and not _SHA_RE.match(rev or ""):
        raise RepoError(f"Invalid commit id: {rev!r}")
    out = _git(path, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}", check=False)
    sha = out.decode().strip()
    if not sha:
        raise RepoError(f"Commit not found: {rev}")
    return sha


def list_commits(name: str, limit: int = 500, all_refs: bool = True) -> list[dict]:
    path = project_path(name)
    fmt = "%x1f".join(["%H", "%h", "%an", "%ae", "%aI", "%s", "%P", "%D"]) + "%x1e"
    args = ["log", f"--max-count={int(limit)}", "--date-order", f"--format={fmt}"]
    if all_refs:
        args.append("--all")
    out = _git(path, *args, check=False).decode("utf-8", "replace")
    commits = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        sha, short, author, email, date, subject, parents, refs = rec.split("\x1f")
        commits.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "email": email,
                "date": date,
                "subject": subject,
                "parents": parents.split(),
                "refs": [r.strip() for r in refs.split(",") if r.strip()],
            }
        )
    return commits


def commit_detail(name: str, rev: str) -> dict:
    """Commit metadata, full message and the list of files it changed."""
    path = project_path(name)
    sha = resolve_commit(name, rev)
    fmt = "%x1f".join(["%H", "%an", "%ae", "%aI", "%P", "%B"])
    meta = _git(path, "show", "-s", f"--format={fmt}", sha).decode("utf-8", "replace")
    full, author, email, date, parents, body = meta.split("\x1f", 5)
    parents = parents.split()

    diff_args = ["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id"]
    if parents:
        diff_args += [parents[0], sha]
    else:
        diff_args += ["--root", sha]
    raw = _git(path, *diff_args).decode("utf-8", "replace").split("\0")
    changes = []
    i = 0
    while i < len(raw) and raw[i]:
        status = raw[i]
        if status[0] in "RC":
            changes.append({"status": status[0], "old_path": raw[i + 1], "path": raw[i + 2]})
            i += 3
        else:
            changes.append({"status": status[0], "path": raw[i + 1]})
            i += 2
    return {
        "sha": full,
        "author": author,
        "email": email,
        "date": date,
        "parents": parents,
        "message": body.strip(),
        "changes": changes,
    }


def list_files(name: str, rev: str) -> list[dict]:
    """All files in the tree of a commit, with sizes."""
    path = project_path(name)
    sha = resolve_commit(name, rev)
    out = _git(path, "ls-tree", "-r", "-l", "-z", sha).decode("utf-8", "replace")
    files = []
    for entry in out.split("\0"):
        if not entry:
            continue
        meta, file_path = entry.split("\t", 1)
        mode, kind, _obj, size = meta.split()
        if kind != "blob":  # skip submodules
            continue
        files.append({"path": file_path, "size": int(size) if size.isdigit() else 0, "mode": mode})
    return files


# ---------------------------------------------------------------- contents


@dataclass
class FileContent:
    path: str
    commit: str
    size: int
    status: str  # "ok" | "too_large" | "binary"
    text: str | None = None

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "commit": self.commit,
            "size": self.size,
            "status": self.status,
            "text": self.text,
            "max_preview_bytes": MAX_PREVIEW_BYTES,
        }


def _blob_spec(sha: str, file_path: str) -> str:
    file_path = file_path.lstrip("/")
    if not file_path or "\0" in file_path:
        raise RepoError("Invalid file path")
    return f"{sha}:{file_path}"


def _is_binary(data: bytes) -> bool:
    # Same heuristic git uses: a NUL byte in the first 8000 bytes.
    return b"\0" in data[:8000]


def read_file(name: str, rev: str, file_path: str, max_bytes: int = MAX_PREVIEW_BYTES) -> FileContent:
    path = project_path(name)
    sha = resolve_commit(name, rev)
    spec = _blob_spec(sha, file_path)
    size_out = _git(path, "cat-file", "-s", spec, check=False).decode().strip()
    if not size_out.isdigit():
        raise RepoError(f"File not found in {sha[:7]}: {file_path}")
    size = int(size_out)
    if size > max_bytes:
        return FileContent(file_path, sha, size, "too_large")
    data = _git(path, "cat-file", "blob", spec)
    if _is_binary(data):
        return FileContent(file_path, sha, size, "binary")
    return FileContent(file_path, sha, size, "ok", data.decode("utf-8", "replace"))


def file_diff(name: str, rev: str, file_path: str) -> dict:
    """Patch of one file in a commit against its first parent."""
    path = project_path(name)
    sha = resolve_commit(name, rev)
    parents = commit_detail(name, sha)["parents"]
    base = parents[0] if parents else _git(path, "hash-object", "-t", "tree", "/dev/null").decode().strip()
    out = _git(path, "diff", "-M", base, sha, "--", file_path)
    if len(out) > MAX_DIFF_BYTES:
        return {"path": file_path, "status": "too_large", "size": len(out), "diff": None}
    return {"path": file_path, "status": "ok", "size": len(out), "diff": out.decode("utf-8", "replace")}


def compare_files(name_a: str, rev_a: str, path_a: str, name_b: str, rev_b: str, path_b: str) -> dict:
    """Similarity ratio and unified diff between two files (any project/commit)."""
    a = read_file(name_a, rev_a, path_a)
    b = read_file(name_b, rev_b, path_b)
    for f in (a, b):
        if f.status != "ok":
            return {"error": f"{f.path} is {f.status.replace('_', ' ')} ({f.size} bytes); cannot compare"}
    a_lines = a.text.splitlines(keepends=True)
    b_lines = b.text.splitlines(keepends=True)
    matcher = difflib.SequenceMatcher(None, a_lines, b_lines, autojunk=False)
    diff = "".join(
        difflib.unified_diff(
            a_lines, b_lines,
            fromfile=f"{name_a}@{a.commit[:7]}:{path_a}",
            tofile=f"{name_b}@{b.commit[:7]}:{path_b}",
        )
    )
    if len(diff) > MAX_DIFF_BYTES:
        diff = diff[:MAX_DIFF_BYTES] + "\n... (diff truncated)"
    return {
        "line_similarity": round(matcher.ratio(), 3),
        "identical": a.text == b.text,
        "a_lines": len(a_lines),
        "b_lines": len(b_lines),
        "unified_diff": diff,
    }


def grep(name: str, rev: str, pattern: str, max_results: int = 200) -> list[dict]:
    """Search text files of a commit with `git grep` (extended regex)."""
    path = project_path(name)
    sha = resolve_commit(name, rev)
    out = _git(
        path, "grep", "-n", "-I", "-E", "--full-name", "-e", pattern, sha, "--",
        check=False, timeout=60,
    ).decode("utf-8", "replace")
    results = []
    prefix = f"{sha}:"
    for line in out.splitlines():
        if line.startswith(prefix):
            line = line[len(prefix):]
        parts = line.split(":", 2)
        if len(parts) == 3 and parts[1].isdigit():
            results.append({"path": parts[0], "line": int(parts[1]), "text": parts[2][:300]})
        if len(results) >= max_results:
            break
    return results
