"use strict";

const state = {
  projects: [],
  project: null,       // selected project name
  commits: [],
  commit: null,        // selected commit sha
  detail: null,        // commit detail (message + changes)
  files: [],           // all files in the commit tree
  fileMode: "changed", // "changed" | "all"
  open: null,          // {project, commit, path, status, change}
  view: "content",     // "content" | "diff"
  lineSel: null,       // {start, end} in the open file
  selections: [],      // context chips for the next question
  sessionId: null,
  asking: false,
};

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

const enc = encodeURIComponent;
const short = (sha) => (sha || "").slice(0, 7);
const fmtSize = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function setStatus(text, isError = false) {
  const s = $("clone-status");
  s.textContent = text;
  s.classList.toggle("error", isError);
}

// ------------------------------------------------------------ projects

async function loadProjects() {
  state.projects = await api("/api/projects");
  renderProjects();
}

function renderProjects() {
  const ul = $("projects");
  ul.replaceChildren();
  if (!state.projects.length) {
    ul.append(el("li", { class: "muted" }, "No projects yet. Paste a git URL above."));
    return;
  }
  for (const p of state.projects) {
    const li = el(
      "li",
      { class: p.name === state.project ? "active" : "", title: p.url, onclick: () => selectProject(p.name) },
      el("span", { class: "pname" }, p.name),
      el("span", { class: "pmeta", title: "commits" }, `${p.commit_count}`),
      el("button", { title: "Update: fetch latest commits", onclick: (e) => { e.stopPropagation(); updateProject(p.name, e.target); } }, "Update"),
      el("button", { title: "Remove this clone", onclick: (e) => { e.stopPropagation(); deleteProject(p.name); } }, "✕"),
    );
    ul.append(li);
  }
}

async function cloneProject(url) {
  $("clone-btn").disabled = true;
  setStatus("Cloning…");
  try {
    const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ url }) });
    setStatus(`Cloned ${p.name} (${p.commit_count} commits).`);
    $("clone-url").value = "";
    await loadProjects();
    await selectProject(p.name);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $("clone-btn").disabled = false;
  }
}

async function updateProject(name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  setStatus(`Updating ${name}…`);
  try {
    const p = await api(`/api/projects/${enc(name)}/update`, { method: "POST" });
    setStatus(p.new_commits ? `${name}: ${p.new_commits} new commit(s).` : `${name} is up to date.`);
    await loadProjects();
    if (state.project === name) await loadCommits();
  } catch (e) {
    setStatus(e.message, true);
    renderProjects();
  }
}

async function deleteProject(name) {
  if (!confirm(`Remove the local clone of ${name}?`)) return;
  try {
    await api(`/api/projects/${enc(name)}`, { method: "DELETE" });
    state.selections = state.selections.filter((s) => s.project !== name);
    renderSelections();
    if (state.project === name) {
      Object.assign(state, { project: null, commits: [], commit: null, detail: null, files: [], open: null });
      renderCommits(); renderCommitHeader(); renderFiles(); renderViewer();
    }
    await loadProjects();
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function selectProject(name) {
  state.project = name;
  renderProjects();
  await loadCommits();
  if (state.commits.length && !state.commits.some((c) => c.sha === state.commit)) {
    await selectCommit(state.commits[0].sha);
  }
}

// ------------------------------------------------------------ commits

async function loadCommits() {
  try {
    state.commits = await api(`/api/projects/${enc(state.project)}/commits`);
  } catch (e) {
    state.commits = [];
    setStatus(e.message, true);
  }
  renderCommits();
}

function renderCommits() {
  const ul = $("commits");
  ul.replaceChildren();
  $("commit-count").textContent = state.project ? `(${state.commits.length})` : "";
  for (const c of state.commits) {
    const refs = c.refs.map((r) => el("span", { class: "ref" }, r.replace("HEAD -> ", "")));
    ul.append(
      el(
        "li",
        { class: c.sha === state.commit ? "active" : "", title: c.subject, onclick: () => selectCommit(c.sha) },
        el("div", { class: "subject" }, ...refs, c.subject || "(no message)"),
        el("div", { class: "meta" }, el("span", { class: "sha" }, c.short), ` · ${c.author} · ${fmtDate(c.date)}`),
      ),
    );
  }
}

async function selectCommit(sha) {
  state.commit = sha;
  state.open = null;
  state.lineSel = null;
  renderCommits();
  renderViewer();
  const base = `/api/projects/${enc(state.project)}/commits/${sha}`;
  try {
    const [detail, files] = await Promise.all([api(base), api(`${base}/files`)]);
    state.detail = detail;
    state.files = files;
  } catch (e) {
    state.detail = null;
    state.files = [];
    setStatus(e.message, true);
  }
  renderCommitHeader();
  renderFiles();
}

function renderCommitHeader() {
  const h = $("commit-header");
  h.replaceChildren();
  const d = state.detail;
  if (!d) {
    h.className = "commit-header muted";
    h.textContent = "Select a project and a commit.";
    return;
  }
  h.className = "commit-header";
  h.append(
    el("div", { class: "msg" }, d.message || "(no message)"),
    el("div", { class: "muted" }, `${short(d.sha)} · ${d.author} · ${fmtDate(d.date)} · ${d.changes.length} file(s) changed`),
  );
}

// ------------------------------------------------------------ files

function renderFiles() {
  const ul = $("files");
  ul.replaceChildren();
  if (!state.detail) return;
  const filter = $("file-filter").value.trim().toLowerCase();
  const sizes = new Map(state.files.map((f) => [f.path, f.size]));
  let rows;
  if (state.fileMode === "changed") {
    rows = state.detail.changes.map((c) => ({ path: c.path, status: c.status, change: c, size: sizes.get(c.path) }));
  } else {
    const changed = new Map(state.detail.changes.map((c) => [c.path, c]));
    rows = state.files.map((f) => ({ path: f.path, size: f.size, status: changed.get(f.path)?.status || "", change: changed.get(f.path) }));
  }
  if (filter) rows = rows.filter((r) => r.path.toLowerCase().includes(filter));
  if (!rows.length) {
    ul.append(el("li", { class: "muted" }, state.fileMode === "changed" ? "No file changes (merge or empty commit)." : "No files."));
    return;
  }
  for (const r of rows) {
    const key = selKey({ project: state.project, commit: state.commit, path: r.path });
    const checkbox = el("input", {
      type: "checkbox",
      title: "Include this file in the next question",
      onclick: (e) => {
        e.stopPropagation();
        if (e.target.checked) addSelection({ project: state.project, commit: state.commit, path: r.path });
        else removeSelection(key);
      },
    });
    checkbox.checked = state.selections.some((s) => selKey(s) === key);
    if (r.status === "D") checkbox.disabled = true;
    const isOpen = state.open && state.open.path === r.path && state.open.commit === state.commit;
    ul.append(
      el(
        "li",
        { class: isOpen ? "active" : "", title: r.change?.old_path ? `${r.change.old_path} → ${r.path}` : r.path, onclick: () => openFile(r.path, r.change) },
        checkbox,
        el("span", { class: `badge ${r.status}` }, r.status),
        el("span", { class: "fpath" }, `‎${r.path}`),
        el("span", { class: "fsize" }, r.size !== undefined ? fmtSize(r.size) : ""),
      ),
    );
  }
}

// ------------------------------------------------------------ viewer

async function openFile(path, change) {
  state.open = { project: state.project, commit: state.commit, path, change, loading: true };
  state.lineSel = null;
  if (change?.status === "D") state.view = "diff";
  renderFiles();
  await renderViewer();
}

async function renderViewer() {
  const v = $("viewer");
  const o = state.open;
  document.querySelectorAll(".view-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  $("add-file-btn").disabled = !o || o.change?.status === "D";
  updateLinesButton();
  if (!o) {
    $("viewer-title").textContent = "No file open";
    v.replaceChildren(el("div", { class: "notice" }, "Click a file to preview it."));
    return;
  }
  $("viewer-title").textContent = `${o.path} @ ${short(o.commit)}`;
  v.replaceChildren(el("div", { class: "notice" }, "Loading…"));
  const base = `/api/projects/${enc(o.project)}/commits/${o.commit}`;
  const token = (state.renderToken = Symbol());
  try {
    if (state.view === "diff") {
      const d = await api(`${base}/diff?path=${enc(o.path)}`);
      if (token !== state.renderToken) return;
      v.replaceChildren(renderDiff(d));
    } else if (o.change?.status === "D") {
      v.replaceChildren(el("div", { class: "notice" }, "This file was deleted in this commit. See the Diff tab."));
    } else {
      const f = await api(`${base}/file?path=${enc(o.path)}`);
      if (token !== state.renderToken) return;
      o.status = f.status;
      v.replaceChildren(renderContent(f));
    }
  } catch (e) {
    if (token === state.renderToken) v.replaceChildren(el("div", { class: "notice" }, e.message));
  }
  paintLineSelection();
}

function renderContent(f) {
  if (f.status === "too_large") {
    return el("div", { class: "notice" },
      `File too large to preview (${fmtSize(f.size)}, limit ${fmtSize(f.max_preview_bytes)}). You can still ask about it.`);
  }
  if (f.status === "binary") {
    return el("div", { class: "notice" }, `Binary file not shown (${fmtSize(f.size)}).`);
  }
  const lines = f.text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const code = el("div", { class: "code" });
  const frag = document.createDocumentFragment();
  lines.forEach((text, i) => {
    const n = i + 1;
    frag.append(el("div", { class: "ln", "data-line": n }, el("span", { class: "num" }, String(n)), el("span", { class: "txt" }, text || " ")));
  });
  code.append(frag);
  return code;
}

function renderDiff(d) {
  if (d.status === "too_large") {
    return el("div", { class: "notice" }, `Diff too large to show (${fmtSize(d.size)}).`);
  }
  if (!d.diff) return el("div", { class: "notice" }, "No textual changes.");
  if (/^Binary files .* differ$/m.test(d.diff)) return el("div", { class: "notice" }, "Binary file changed; diff not shown.");
  const code = el("div", { class: "code" });
  let newLine = 0;
  let inHunk = false;
  const diffLines = d.diff.split("\n");
  if (diffLines[diffLines.length - 1] === "") diffLines.pop();
  for (const text of diffLines) {
    const m = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    let cls = "";
    let num = "";
    if (m) {
      newLine = parseInt(m[1], 10);
      inHunk = true;
      cls = "hunk";
    } else if (!inHunk) {
      cls = "hunk";
    } else if (text.startsWith("+")) {
      cls = "add"; num = newLine++;
    } else if (text.startsWith("-")) {
      cls = "del";
    } else if (text.startsWith("\\")) {
      cls = "hunk";
    } else {
      num = newLine++;
    }
    code.append(el("div", { class: `ln ${cls}`, "data-line": num === "" ? null : num }, el("span", { class: "num" }, String(num)), el("span", { class: "txt" }, text || " ")));
  }
  return code;
}

// Line selection: click a number, shift-click to extend, or drag-select text.
function onViewerClick(e) {
  const num = e.target.closest(".num");
  if (!num) return;
  const n = parseInt(num.parentElement.dataset.line, 10);
  if (!n) return;
  if (e.shiftKey && state.lineSel) {
    const anchor = state.lineSel.anchor;
    state.lineSel = { anchor, start: Math.min(anchor, n), end: Math.max(anchor, n) };
  } else if (state.lineSel && state.lineSel.start === n && state.lineSel.end === n) {
    state.lineSel = null;
  } else {
    state.lineSel = { anchor: n, start: n, end: n };
  }
  paintLineSelection();
}

function onViewerMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const lineOf = (node) => {
    const ln = (node.nodeType === 1 ? node : node.parentElement)?.closest(".ln[data-line]");
    return ln && $("viewer").contains(ln) ? parseInt(ln.dataset.line, 10) : null;
  };
  const a = lineOf(sel.anchorNode);
  const b = lineOf(sel.focusNode);
  if (!a || !b) return;
  state.lineSel = { anchor: Math.min(a, b), start: Math.min(a, b), end: Math.max(a, b) };
  paintLineSelection();
}

function paintLineSelection() {
  const s = state.lineSel;
  document.querySelectorAll("#viewer .ln[data-line]").forEach((ln) => {
    const n = parseInt(ln.dataset.line, 10);
    ln.classList.toggle("selected", !!s && n >= s.start && n <= s.end);
  });
  updateLinesButton();
}

function updateLinesButton() {
  const s = state.lineSel;
  const b = $("add-lines-btn");
  b.disabled = !s || !state.open;
  b.textContent = s ? `Ask about lines ${s.start}${s.end !== s.start ? "–" + s.end : ""}` : "Ask about lines";
}

// ------------------------------------------------------------ selections

const selKey = (s) => `${s.project}|${s.commit}|${s.path}|${s.start_line || ""}|${s.end_line || ""}`;
const selLabel = (s) =>
  `${s.project}@${short(s.commit)}:${s.path}${s.start_line ? `:${s.start_line}${s.end_line && s.end_line !== s.start_line ? "-" + s.end_line : ""}` : ""}`;

function addSelection(s) {
  if (!state.selections.some((x) => selKey(x) === selKey(s))) state.selections.push(s);
  renderSelections();
  renderFiles();
}

function removeSelection(key) {
  state.selections = state.selections.filter((s) => selKey(s) !== key);
  renderSelections();
  renderFiles();
}

function renderSelections() {
  const box = $("selections");
  box.replaceChildren();
  for (const s of state.selections) {
    const key = selKey(s);
    box.append(el("span", { class: "chip", title: selLabel(s) }, el("span", {}, selLabel(s)), el("button", { title: "Remove", onclick: () => removeSelection(key) }, "×")));
  }
}

function currentLinesSelection() {
  const o = state.open;
  if (!o || !state.lineSel) return null;
  return { project: o.project, commit: o.commit, path: o.path, start_line: state.lineSel.start, end_line: state.lineSel.end };
}

// ------------------------------------------------------------ chat

function renderMarkdown(node, text) {
  if (window.marked && window.DOMPurify) {
    node.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    node.style.whiteSpace = "pre-wrap";
    node.textContent = text;
  }
}

async function ask(question) {
  if (state.asking || !question.trim()) return;

  // Explicit chips win; otherwise use highlighted lines, else the open file.
  let selections = [...state.selections];
  const lines = currentLinesSelection();
  if (lines && !selections.some((s) => selKey(s) === selKey(lines))) selections.push(lines);
  if (!selections.length && state.open && state.open.change?.status !== "D") {
    selections.push({ project: state.open.project, commit: state.open.commit, path: state.open.path });
  }

  const out = $("output");
  out.querySelector(".hint")?.remove();
  out.append(
    el("div", { class: "msg-user" }, question,
      selections.length ? el("div", { class: "ctx" }, selections.map(selLabel).join("\n")) : null),
  );
  const agent = el("div", { class: "msg-agent" });
  const tools = el("div");
  const body = el("div", {}, el("span", { class: "thinking" }, "Thinking…"));
  agent.append(tools, body);
  out.append(agent);
  out.scrollTop = out.scrollHeight;

  state.asking = true;
  $("ask-btn").disabled = true;
  $("question").value = "";
  state.selections = [];
  renderSelections();
  renderFiles();

  let text = "";
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, session_id: state.sessionId, project: state.project, commit: state.commit, selections }),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "session") state.sessionId = ev.session_id;
        else if (ev.type === "tool") tools.append(el("div", { class: "tool-call" }, `${ev.name}(${describeArgs(ev.args)})`));
        else if (ev.type === "text") { text += (text ? "\n\n" : "") + ev.text; renderMarkdown(body, text); }
        else if (ev.type === "error") agent.append(el("div", { class: "msg-error" }, ev.text));
        out.scrollTop = out.scrollHeight;
      }
    }
  } catch (e) {
    agent.append(el("div", { class: "msg-error" }, e.message));
  } finally {
    if (!text) body.replaceChildren();
    state.asking = false;
    $("ask-btn").disabled = false;
    out.scrollTop = out.scrollHeight;
  }
}

function describeArgs(args) {
  return Object.entries(args || {})
    .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 12 && /^[0-9a-f]+$/.test(v) ? v.slice(0, 7) : JSON.stringify(v)}`)
    .join(", ");
}

function newChat() {
  state.sessionId = null;
  $("output").replaceChildren(initialHint.cloneNode(true));
  wireExamples();
}

function wireExamples() {
  document.querySelectorAll(".example").forEach((b) =>
    b.addEventListener("click", () => { $("question").value = b.textContent; $("question").focus(); }),
  );
}

// ------------------------------------------------------------ wiring

$("clone-form").addEventListener("submit", (e) => { e.preventDefault(); cloneProject($("clone-url").value); });
document.querySelectorAll(".file-tabs .tab").forEach((t) =>
  t.addEventListener("click", () => {
    state.fileMode = t.dataset.mode;
    document.querySelectorAll(".file-tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
    renderFiles();
  }),
);
$("file-filter").addEventListener("input", renderFiles);
document.querySelectorAll(".view-tabs .tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (state.view === t.dataset.view) return;
    state.view = t.dataset.view;
    state.lineSel = null;
    renderViewer();
  }),
);
$("viewer").addEventListener("click", onViewerClick);
$("viewer").addEventListener("mouseup", onViewerMouseUp);
$("add-lines-btn").addEventListener("click", () => {
  const s = currentLinesSelection();
  if (s) addSelection(s);
});
$("add-file-btn").addEventListener("click", () => {
  const o = state.open;
  if (o) addSelection({ project: o.project, commit: o.commit, path: o.path });
});
$("ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("question").value); });
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask($("question").value); }
});
$("new-chat-btn").addEventListener("click", newChat);
const initialHint = document.querySelector(".hint").cloneNode(true);
wireExamples();

loadProjects().catch((e) => setStatus(e.message, true));
