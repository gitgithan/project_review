# Project Review

A local web app for reviewing student git projects with a Gemini agent built on
[Google ADK](https://google.github.io/adk-docs/).

- Paste a student's git URL to clone it into `projects/` (git-ignored, never committed).
  Clone as many as you like; they all live side by side.
- **Update** on a project fetches the latest commits. Clones are read-only mirrors,
  so the checkout is simply reset to the remote branch (force-pushes are fine).
- Browse commit history (all branches), see each commit's message and changed files,
  and open any file as it was at that commit, or its diff. Files are shown in
  folders: folders with fewer than 10 files start expanded, bigger ones collapsed
  (+ / − expand or collapse all; filtering expands matches).
- Files larger than 512 KB, and binary files, are not previewed (like git hides them).
  You can still ask about them; the agent is told their size.
- Click a line number (shift-click to extend) or drag-select code to highlight lines,
  then **Ask about lines**; or **Ask about file**, or tick files in the file list.
  Selections can come from different projects/commits, e.g. to compare two students.
- Type a question and the agent answers in the output pane, showing the tools it used.

Example questions: *What is this function for?* · *What is this file for?* ·
*Are these 2 files versions of each other?* · *Summarise what changed in this commit.*

## Setup

Requires Python 3.10+ and `git`.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Use your own Application Default Credentials for Vertex AI
gcloud auth application-default login
cp .env.example .env   # then set GOOGLE_CLOUD_PROJECT (and location if needed)
```

`.env`:

```
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
```

Make sure the Vertex AI API is enabled on that project.

## Run

```bash
uvicorn app.main:app --reload
```

Open http://localhost:8000.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REVIEW_MODEL` | `gemini-2.5-flash` | Gemini model used by the agent (e.g. `gemini-2.5-pro`) |
| `PROJECTS_DIR` | `./projects` | Where student repos are cloned |
| `MAX_PREVIEW_BYTES` | `524288` | Files above this size are not previewed or sent to the model |
| `MAX_DIFF_BYTES` | `524288` | Diffs above this size are not shown |

Private repos: use an SSH URL (`git@github.com:student/repo.git`) or an HTTPS URL
your local git credential helper can authenticate. The app never prompts for passwords.

## How it works

```
app/main.py            FastAPI server: git endpoints + /api/ask (streams agent events)
app/static/            Single-page UI (no build step)
review_agent/agent.py  ADK Agent (root_agent) with read-only tools
review_agent/repos.py  git helpers: clone, update, log, ls-tree, cat-file, diff, grep
```

The agent's tools are read-only: `list_projects`, `list_commits`, `get_commit`,
`list_files`, `read_file` (numbered line ranges), `get_file_diff`,
`compare_files` (similarity score + unified diff, across projects/commits) and
`search_code` (git grep). Your highlighted lines are inlined into the question;
the agent reads anything else it needs with these tools.

You can also try the agent alone with ADK's dev UI: `adk web` from the repo root
and pick `review_agent`.

Conversations are kept in memory and reset when the server restarts; use
**New chat** to start fresh.

## Tests

```bash
pip install pytest && pytest
```
