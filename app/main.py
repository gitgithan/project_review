"""Web server for the student project reviewer.

    uvicorn app.main:app --reload
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import FileResponse, Response, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app import reviews, usage  # noqa: E402
from review_agent import repos, review  # noqa: E402
from review_agent.agent import MODEL, root_agent  # noqa: E402

log = logging.getLogger("project_review")

APP_NAME = "project_review"
USER_ID = "reviewer"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Max characters of selected code inlined into a question; the agent can
# always read more with its tools.
MAX_CONTEXT_CHARS = 60_000

app = FastAPI(title="Student Project Reviewer")
session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)
review_runner = Runner(app_name=APP_NAME, agent=review.review_agent, session_service=session_service)
tracker = usage.Tracker()


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except repos.RepoError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ---------------------------------------------------------------- git API


class CloneRequest(BaseModel):
    url: str


@app.get("/api/projects")
def get_projects():
    return _call(repos.list_projects)


@app.post("/api/projects")
def clone(req: CloneRequest):
    return _call(repos.clone_project, req.url)


@app.post("/api/projects/{name}/update")
def update(name: str):
    return _call(repos.update_project, name)


@app.delete("/api/projects/{name}")
def delete(name: str):
    _call(repos.delete_project, name)
    return {"ok": True}


@app.get("/api/projects/{name}/graph")
def graph(name: str, limit: int = 300):
    return _call(repos.commit_graph, name, min(max(limit, 10), 2000))


@app.get("/api/projects/{name}/branches")
def branches(name: str):
    return _call(repos.list_branches, name)


@app.get("/api/projects/{name}/commits")
def commits(name: str, limit: int = 500, branch: str | None = None):
    return _call(repos.list_commits, name, limit, branch or None)


@app.get("/api/projects/{name}/commits/{sha}")
def commit(name: str, sha: str):
    return _call(repos.commit_detail, name, sha)


@app.get("/api/projects/{name}/commits/{sha}/files")
def files(name: str, sha: str):
    return _call(repos.list_files, name, sha)


@app.get("/api/projects/{name}/commits/{sha}/file")
def file(name: str, sha: str, path: str):
    return _call(repos.read_file, name, sha, path).as_dict()


@app.get("/api/projects/{name}/commits/{sha}/diff")
def diff(name: str, sha: str, path: str):
    return _call(repos.file_diff, name, sha, path)


# ---------------------------------------------------------------- agent API


class Selection(BaseModel):
    project: str
    commit: str
    path: str
    start_line: int | None = None
    end_line: int | None = None


class AskRequest(BaseModel):
    question: str
    session_id: str | None = None
    project: str | None = None
    branch: str | None = None
    commit: str | None = None
    selections: list[Selection] = Field(default_factory=list)


def _selection_text(sel: Selection) -> str:
    try:
        f = repos.read_file(sel.project, sel.commit, sel.path)
    except repos.RepoError as e:
        return f"- {sel.project}@{sel.commit[:7]}:{sel.path} (error: {e})"
    header = f"- {sel.project}@{f.commit[:7]}:{sel.path}"
    if f.status != "ok":
        return f"{header} ({f.status.replace('_', ' ')}, {f.size} bytes; not previewable)"
    lines = f.text.splitlines()
    if sel.start_line:
        start = max(sel.start_line, 1)
        end = min(sel.end_line or start, len(lines))
        header += f" lines {start}-{end}"
    else:
        start, end = 1, len(lines)
        header += " (whole file)"
    body = "\n".join(f"{i}| {lines[i - 1]}" for i in range(start, end + 1))
    return f"{header}\n```\n{body}\n```"


def _build_message(req: AskRequest) -> str:
    ctx = []
    if req.project:
        ctx.append(f"Viewing project: {req.project}")
    if req.branch:
        ctx.append(f"Viewing branch: {req.branch}")
    if req.commit:
        ctx.append(f"Viewing commit: {req.commit}")
    if req.selections:
        ctx.append("Selected by the teacher:")
        used = 0
        for sel in req.selections:
            text = _selection_text(sel)
            if used + len(text) > MAX_CONTEXT_CHARS:
                text = (f"- {sel.project}@{sel.commit[:7]}:{sel.path} "
                        "(too long to inline; read it with read_file)")
            used += len(text)
            ctx.append(text)
    if not ctx:
        return req.question
    return "[Context]\n" + "\n".join(ctx) + "\n[/Context]\n\n" + req.question


def _line(obj: dict) -> str:
    return json.dumps(obj) + "\n"


async def _new_session() -> str:
    session_id = str(uuid.uuid4())
    await session_service.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id)
    return session_id


def _explain_error(text: str) -> str:
    """Add a fix hint to errors that are usually configuration problems."""
    if "NOT_FOUND" in text and "models/" in text:
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "")
        hint = (f"\n\nThe model `{MODEL}` is not available" + (f" in `{location}`" if location else "")
                + ". Gemini 3.x models are served from the global endpoint: set "
                "GOOGLE_CLOUD_LOCATION=global in .env and restart the server. If it is still "
                "not found, set REVIEW_MODEL to the exact model ID shown in Vertex AI Model Garden.")
        return text + hint
    return text


async def _agent_events(agent_runner: Runner, session_id: str, message: types.Content):
    """Run an agent and yield UI events: tool calls, text, usage and errors.

    Text events carry final=True when they belong to the agent's final answer.
    """
    last_error = None
    turn = {**usage.empty(), "context_tokens": 0, "context_window": None, "model": MODEL}
    try:
        async for event in agent_runner.run_async(
            user_id=USER_ID, session_id=session_id, new_message=message
        ):
            if event.error_message:
                last_error = event.error_message
                yield {"type": "error", "text": _explain_error(event.error_message)}
            if event.usage_metadata and not event.partial:
                model = event.model_version or MODEL
                if not usage.price_for(model):
                    model = MODEL
                call = usage.call_usage(model, event.usage_metadata)
                tracker.record(session_id, call)
                usage.add(turn, call)
                turn.update(context_tokens=call["context_tokens"],
                            context_window=call["context_window"], model=model)
                yield {"type": "usage", "turn": dict(turn), **tracker.summary(session_id)}
            if not event.content or not event.content.parts:
                continue
            final = event.is_final_response()
            for part in event.content.parts:
                if part.function_call:
                    yield {"type": "tool", "name": part.function_call.name,
                           "args": part.function_call.args or {}}
                elif part.text and not part.thought and event.author != "user":
                    yield {"type": "text", "text": part.text, "final": final}
    except Exception as e:  # surface auth/quota problems in the UI
        if str(e) != last_error:
            yield {"type": "error", "text": _explain_error(f"{type(e).__name__}: {e}")}


@app.post("/api/ask")
async def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty")

    session_id = req.session_id
    if not session_id or not await session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    ):
        session_id = await _new_session()

    message = types.Content(role="user", parts=[types.Part(text=_build_message(req))])

    async def stream():
        yield _line({"type": "session", "session_id": session_id})
        async for ev in _agent_events(runner, session_id, message):
            yield _line(ev)
        yield _line({"type": "done"})

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/usage")
def get_usage(session_id: str | None = None):
    return {"model": MODEL, **tracker.summary(session_id)}


# ---------------------------------------------------------------- reviews


class ReviewRequest(BaseModel):
    project: str
    branch: str | None = None


@app.post("/api/review")
async def start_review(req: ReviewRequest):
    """Static architecture review of a branch tip (or HEAD), streamed as NDJSON."""

    def resolve() -> str:
        if req.branch:
            commits = repos.list_commits(req.project, limit=1, branch=req.branch)
            if not commits:
                raise repos.RepoError(f"Branch {req.branch} has no commits")
            return commits[0]["sha"]
        return repos.resolve_commit(req.project, "HEAD")

    sha = await run_in_threadpool(_call, resolve)

    async def stream():
        yield _line({"type": "status", "text": f"Collecting files at {sha[:7]}…"})
        try:
            pack = await run_in_threadpool(review.collect, req.project, sha, req.branch)
        except repos.RepoError as e:
            yield _line({"type": "error", "text": str(e)})
            yield _line({"type": "done"})
            return
        st = pack.stats
        yield _line({"type": "pack", "commit": sha, "stats": st})
        yield _line({"type": "status", "text":
                     f"Read {st['source_included']} source files"
                     + (f" ({st['source_omitted']} too big to include)" if st["source_omitted"] else "")
                     + f", sampled {st['data_sampled']} of {st['data_files']} data files, "
                     f"skipped {st['skipped_files']}. Reviewing with {MODEL}…"})

        session_id = await _new_session()
        message = types.Content(role="user", parts=[types.Part(text=pack.message)])
        final_parts, last_usage = [], None
        async for ev in _agent_events(review_runner, session_id, message):
            if ev["type"] == "text" and ev.get("final"):
                final_parts.append(ev["text"])
            if ev["type"] == "usage":
                last_usage = ev["turn"]
            yield _line(ev)

        text = "\n\n".join(final_parts).strip()
        if text:
            meta = await run_in_threadpool(
                reviews.save, req.project, req.branch, sha, (last_usage or {}).get("model", MODEL),
                text, st, last_usage or {})
            yield _line({"type": "review", "meta": meta, "markdown": text,
                         "title": reviews.title(meta), "subtitle": reviews.subtitle(meta)})
        yield _line({"type": "done"})

    return StreamingResponse(stream(), media_type="application/x-ndjson")


def _get_review(review_id: str):
    try:
        return reviews.get(review_id)
    except reviews.ReviewNotFound as e:
        raise HTTPException(status_code=404, detail="Review not found") from e


@app.get("/api/reviews")
def list_saved_reviews(project: str | None = None):
    return reviews.list_reviews(project)


@app.get("/api/reviews/{review_id}")
def saved_review(review_id: str):
    meta, text = _get_review(review_id)
    return {"meta": meta, "markdown": text, "title": reviews.title(meta), "subtitle": reviews.subtitle(meta)}


@app.get("/api/reviews/{review_id}/pdf")
async def review_pdf(review_id: str):
    meta, text = _get_review(review_id)
    try:
        from app.pdf import review_pdf as render  # imported lazily: heavy dependency
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail=f"PDF support is not installed ({e}). Run `pip install -r requirements.txt` "
                   "(needs markdown and xhtml2pdf>=0.2.23), then restart the server.",
        ) from e
    try:
        data = await run_in_threadpool(render, text, reviews.title(meta), reviews.subtitle(meta))
    except Exception as e:
        log.exception("PDF rendering failed for review %s", review_id)
        raise HTTPException(
            status_code=500,
            detail=f"Could not create the PDF ({type(e).__name__}: {e}). "
                   "Open /api/diagnostics/pdf for details and the server log for the traceback.",
        ) from e
    return Response(
        data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{reviews.pdf_filename(meta)}"'},
    )


@app.get("/api/diagnostics/pdf")
def pdf_diagnostics():
    """What the server uses to make PDFs, and the result of a test render.

    Open http://localhost:8000/api/diagnostics/pdf when Download Review fails.
    """
    import importlib.metadata as md
    import platform
    import sys
    import traceback

    def version(pkg: str) -> str | None:
        try:
            return md.version(pkg)
        except md.PackageNotFoundError:
            return None

    report = {
        "python": sys.executable,
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "packages": {p: version(p) for p in ("markdown", "xhtml2pdf", "reportlab", "pypdf")},
        "fonts": None,
        "test_render": None,
    }
    try:
        from app import pdf

        report["fonts"] = pdf._fonts()
        sample = "## Test\n| A | B |\n|---|---|\n| `code()` | x → y |\n\n- item\n  - nested"
        for label, fonts in (("system_fonts", pdf._fonts()), ("builtin_fonts", None)):
            try:
                size = len(pdf._render(sample, "PDF test", "diagnostics", fonts))
                report[label] = f"ok ({size} bytes)"
            except Exception:
                report[label] = traceback.format_exc()
        report["test_render"] = "ok" if any(
            str(report.get(k, "")).startswith("ok") for k in ("system_fonts", "builtin_fonts")) else "failed"
    except Exception:
        report["test_render"] = traceback.format_exc()
    return report


# ---------------------------------------------------------------- UI


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
