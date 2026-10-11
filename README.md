# Project Review

A local web app for reviewing student git projects with a Gemini agent built on
[Google ADK](https://google.github.io/adk-docs/).

- Paste a student's git URL to clone it into `projects/` (git-ignored, never committed).
  Clone as many as you like; they all live side by side.
- **Update** on a project fetches the latest commits. Clones are read-only mirrors,
  so the checkout is simply reset to the remote branch (force-pushes are fine).
- Pick the project from a dropdown (it remembers the last one) and switch **branches**
  with the branch dropdown, default branch first, or "All branches". Switching
  branches jumps to that branch's latest commit so you preview its files.
- Browse commit history, see each commit's message and changed files,
  and open any file as it was at that commit, or its diff. Files are shown in
  folders: folders with fewer than 10 files start expanded, bigger ones collapsed
  (+ / − expand or collapse all; filtering expands matches).
- Files larger than 512 KB, and binary files, are not previewed (like git hides them).
  You can still ask about them; the agent is told their size.
- Click a line number (shift-click to extend) or drag-select code to highlight lines,
  then **Ask about lines**; or **Ask about file**, or tick files in the file list.
  Selections can come from different projects/commits, e.g. to compare two students.
- Syntax highlighting (highlight.js, served locally) in the file viewer, diffs and
  code blocks in answers; the language comes from the file name or is auto-detected.
- Type a question and the agent answers in the output pane, showing the tools it used.
- Token use and cost like Cline: the chat header shows tokens sent ↑ / received ↓,
  cached tokens, a context-window bar, this chat's API cost and the all-time total;
  each answer shows its own tokens, model calls and cost.
- Drag the borders between the four columns to resize them (double-click a border to
  reset it); widths are remembered in your browser.

Example questions: *What is this function for?* · *What is this file for?* ·
*Are these 2 files versions of each other?* · *Summarise what changed in this commit.*

## Setup

Requires Python 3.10+ and `git`.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then connect Gemini in **one** of two ways. Nothing in the code changes between them;
Google's client library picks the backend from these environment variables.

### Option A: Vertex AI (your Google Cloud project / credits)

```bash
gcloud auth application-default login
```

`.env`:

```
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
```

Make sure the Vertex AI API is enabled on that project.

### Option B: Gemini API key (free tier, no Google Cloud project)

1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey).
2. `.env` (leave out the Vertex lines; no `gcloud` login needed):

   ```
   GOOGLE_GENAI_USE_VERTEXAI=FALSE
   GOOGLE_API_KEY=your-api-key
   ```

Before using the free tier for student work, note:

- **Privacy.** On the free (unpaid) tier Google may use what you send, here students'
  code and commit history (names, emails), to improve its products. Vertex AI and the
  paid API tier don't. Check the current
  [Gemini API terms](https://ai.google.dev/gemini-api/terms) and your institution's rules.
- **Rate limits.** Free keys are limited in requests per minute and per day, and one
  question usually takes 3 to 6 model calls (the agent reads and searches files between
  steps). Hitting a limit shows a `429` / "resource exhausted" error in the answer pane;
  wait and ask again.
- **Model.** The default model must be available to your key. If it's rejected, set
  `REVIEW_MODEL` to one that [AI Studio](https://aistudio.google.com) lists for the free
  tier.
- **Cost display.** The cost figures use the paid prices in `pricing.json`, so on the
  free tier read them as "what this would cost if billed"; you pay $0. Token counts and
  the context bar are accurate either way.

To switch back and forth, edit `.env` and restart the server.

### Without Gemini

Browsing projects, branches, commits, files and diffs works with neither option set
up. Only **Ask** needs Gemini; without it the answer pane shows an error and nothing
is sent anywhere. (`google-adk` still has to be installed.)

## Run

```bash
uvicorn app.main:app --reload
```

Open http://localhost:8000.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REVIEW_MODEL` | `gemini-3.1-flash-lite` | Gemini model used by the agent (e.g. `gemini-3.5-flash`, `gemini-3.1-pro-preview`) |
| `PROJECTS_DIR` | `./projects` | Where student repos are cloned |
| `MAX_PREVIEW_BYTES` | `524288` | Files above this size are not previewed or sent to the model |
| `MAX_DIFF_BYTES` | `524288` | Diffs above this size are not shown |
| `PRICING_FILE` | `./pricing.json` | Gemini prices used for cost estimates |
| `USAGE_LOG` | `./usage_log.jsonl` | Ledger of every model call (git-ignored), used for the all-time total |

### Token and cost tracking

Costs are estimates computed from the token counts Gemini returns and the rates in
`pricing.json` (USD per 1M tokens, Vertex AI Standard tier, copied from the
[Vertex AI pricing page](https://cloud.google.com/vertex-ai/generative-ai/pricing)).
It handles cached input, thinking tokens (billed as output), the >200K long-context
tier, global vs. regional rates (from `GOOGLE_CLOUD_LOCATION`) and dated promotions.
Prices change: update `pricing.json` when Google does. A model missing from the
file still shows tokens, and its cost shows as "cost unknown" / "≥ $…".
Your Cloud Billing report remains the source of truth. With a free-tier API key
(Option B) the figures are what the usage would cost if billed; you pay nothing.

Private repos: use an SSH URL (`git@github.com:student/repo.git`) or an HTTPS URL
your local git credential helper can authenticate. The app never prompts for passwords.

## How it works

```
app/main.py            FastAPI server: git endpoints + /api/ask (streams agent events)
app/static/            Single-page UI (no build step)
review_agent/agent.py  ADK Agent (root_agent) with read-only tools
review_agent/repos.py  git helpers: clone, update, log, ls-tree, cat-file, diff, grep
```

The agent's tools are read-only: `list_projects`, `list_branches`, `list_commits` (per branch), `get_commit`,
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
