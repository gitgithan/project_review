"""Web server for the student project reviewer.

    uvicorn app.main:app --reload
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app import usage  # noqa: E402
from review_agent import repos  # noqa: E402
from review_agent.agent import MODEL, root_agent  # noqa: E402

APP_NAME = "project_review"
USER_ID = "reviewer"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Max characters of selected code inlined into a question; the agent can
# always read more with its tools.
MAX_CONTEXT_CHARS = 60_000

app = FastAPI(title="Student Project Reviewer")
session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)
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


@app.post("/api/ask")
async def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty")

    session_id = req.session_id
    if not session_id or not await session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    ):
        session_id = str(uuid.uuid4())
        await session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID, session_id=session_id
        )

    message = types.Content(role="user", parts=[types.Part(text=_build_message(req))])

    async def stream():
        yield json.dumps({"type": "session", "session_id": session_id}) + "\n"
        last_error = None
        turn = {**usage.empty(), "context_tokens": 0, "context_window": None, "model": MODEL}
        try:
            async for event in runner.run_async(
                user_id=USER_ID, session_id=session_id, new_message=message
            ):
                if event.error_message:
                    last_error = event.error_message
                    yield json.dumps({"type": "error", "text": event.error_message}) + "\n"
                if event.usage_metadata and not event.partial:
                    model = event.model_version or MODEL
                    if not usage.price_for(model):
                        model = MODEL
                    call = usage.call_usage(model, event.usage_metadata)
                    tracker.record(session_id, call)
                    usage.add(turn, call)
                    turn.update(context_tokens=call["context_tokens"],
                                context_window=call["context_window"], model=model)
                    yield json.dumps({"type": "usage", "turn": turn,
                                      **tracker.summary(session_id)}) + "\n"
                if not event.content or not event.content.parts:
                    continue
                for part in event.content.parts:
                    if part.function_call:
                        yield json.dumps({
                            "type": "tool",
                            "name": part.function_call.name,
                            "args": part.function_call.args or {},
                        }) + "\n"
                    elif part.text and not part.thought and event.author != "user":
                        yield json.dumps({"type": "text", "text": part.text}) + "\n"
        except Exception as e:  # surface auth/quota problems in the UI
            if str(e) != last_error:
                yield json.dumps({"type": "error", "text": f"{type(e).__name__}: {e}"}) + "\n"
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/usage")
def get_usage(session_id: str | None = None):
    return {"model": MODEL, **tracker.summary(session_id)}


# ---------------------------------------------------------------- UI


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
