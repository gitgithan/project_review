"use strict";

const state = {
  projects: [],
  project: null,       // selected project name
  commits: [],
  commit: null,        // selected commit sha
  detail: null,        // commit detail (message + changes)
  files: [],           // all files in the commit tree
  fileMode: "changed", // "changed" | "all"
  folderOpen: new Map(), // folder path -> open/closed, set by the user
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
const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (sha) => (sha || "").slice(0, 7);
const fmtSize = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

// ------------------------------------------------------------ highlighting

const LANG_BY_NAME = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  gemfile: "ruby", rakefile: "ruby", "cmakelists.txt": "plaintext",
};
const LANG_BY_EXT = { ipynb: "json", vue: "xml", svelte: "xml", gradle: "kotlin", txt: "plaintext" };
// Auto-detecting the language is slow on big files; skip it above this size.
const MAX_AUTO_DETECT_CHARS = 100_000;

if (window.hljs) hljs.configure({ ignoreUnescapedHTML: true });

function languageFor(path) {
  if (!window.hljs) return null;
  const name = path.split("/").pop().toLowerCase();
  if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  const lang = LANG_BY_EXT[ext] || ext;
  return hljs.getLanguage(lang) ? lang : null;
}

// Highlight a whole text and return one HTML string per line, closing and
// reopening spans at line breaks so multi-line tokens (comments, strings)
// keep their colour. Returns null when highlighting is unavailable.
function highlightLines(text, path) {
  if (!window.hljs) return null;
  let html;
  try {
    const lang = languageFor(path);
    if (lang) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else if (text.length <= MAX_AUTO_DETECT_CHARS) html = hljs.highlightAuto(text).value;
    else return null;
  } catch (_) {
    return null;
  }
  const lines = [];
  const open = [];
  let cur = "";
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { lines.push(cur + "</span>".repeat(open.length)); cur = open.join(""); }
    else cur += m[4];
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

function codeLine(num, text, html, cls = "") {
  const txt = el("span", { class: "txt" });
  if (html) txt.innerHTML = html || " ";
  else txt.textContent = text || " ";
  return el("div", { class: `ln ${cls}`.trim(), "data-line": num === "" ? null : num }, el("span", { class: "num" }, String(num)), txt);
}

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
  if (state.project !== name) state.folderOpen = new Map();
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

function fileRows() {
  const sizes = new Map(state.files.map((f) => [f.path, f.size]));
  if (state.fileMode === "changed") {
    return state.detail.changes.map((c) => ({ path: c.path, status: c.status, change: c, size: sizes.get(c.path) }));
  }
  const changed = new Map(state.detail.changes.map((c) => [c.path, c]));
  return state.files.map((f) => ({ path: f.path, size: f.size, status: changed.get(f.path)?.status || "", change: changed.get(f.path) }));
}

// Build a folder tree from flat paths. Folders with a single subfolder and no
// files are merged ("src/main/java") so deep paths need fewer clicks.
function buildTree(rows) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const r of rows) {
    const parts = r.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push({ ...r, name: parts[parts.length - 1] });
  }
  const finish = (node) => {
    for (const d of node.dirs.values()) finish(d);
    node.count = node.files.length + [...node.dirs.values()].reduce((n, d) => n + d.count, 0);
    node.changed = node.files.filter((f) => f.status).length + [...node.dirs.values()].reduce((n, d) => n + d.changed, 0);
  };
  const compress = (node) => {
    for (const [key, d] of node.dirs) {
      let cur = d;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const only = [...cur.dirs.values()][0];
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      node.dirs.set(key, cur);
      compress(cur);
    }
  };
  compress(root);
  finish(root);
  return root;
}

function allDirPaths(node, out = []) {
  for (const d of node.dirs.values()) { out.push(d.path); allDirPaths(d, out); }
  return out;
}

// Folders holding fewer than this many files (recursively) start expanded.
const AUTO_EXPAND_BELOW = 10;

function isFolderOpen(dir) {
  return state.folderOpen.get(dir.path) ?? dir.count < AUTO_EXPAND_BELOW;
}

function setAllFolders(expand) {
  if (!state.detail) return;
  state.folderOpen = new Map(allDirPaths(buildTree(fileRows())).map((p) => [p, expand]));
  renderFiles();
}

function renderFiles() {
  const ul = $("files");
  ul.replaceChildren();
  if (!state.detail) return;
  const filter = $("file-filter").value.trim().toLowerCase();
  let rows = fileRows();
  if (filter) rows = rows.filter((r) => r.path.toLowerCase().includes(filter));
  if (!rows.length) {
    ul.append(el("li", { class: "muted" }, state.fileMode === "changed" ? "No file changes (merge or empty commit)." : "No files."));
    return;
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const walk = (node, depth) => {
    for (const d of [...node.dirs.values()].sort(byName)) {
      // Small folders start open, big ones collapsed, unless the user toggled
      // them; while filtering, show every match.
      const open = !!filter || isFolderOpen(d);
      const info = state.fileMode === "all" && d.changed ? `${d.changed}/${d.count}` : `${d.count}`;
      ul.append(
        el(
          "li",
          {
            class: "folder",
            style: `padding-left:${6 + depth * 14}px`,
            title: d.path,
            onclick: () => {
              if (filter) return;
              state.folderOpen.set(d.path, !isFolderOpen(d));
              renderFiles();
            },
          },
          el("span", { class: "caret" }, open ? "▾" : "▸"),
          el("span", { class: "fpath" }, `${d.name}/`),
          el("span", { class: "fsize", title: state.fileMode === "all" ? "changed / files" : "files" }, info),
        ),
      );
      if (open) walk(d, depth + 1);
    }
    for (const f of [...node.files].sort(byName)) ul.append(fileRow(f, depth));
  };
  walk(buildTree(rows), 0);
}

function fileRow(r, depth) {
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
  return el(
    "li",
    {
      class: isOpen ? "active" : "",
      style: `padding-left:${6 + depth * 14 + 14}px`,
      title: r.change?.old_path ? `${r.change.old_path} → ${r.path}` : r.path,
      onclick: () => openFile(r.path, r.change),
    },
    checkbox,
    el("span", { class: `badge ${r.status}` }, r.status),
    el("span", { class: "fpath" }, r.name),
    el("span", { class: "fsize" }, r.size !== undefined ? fmtSize(r.size) : ""),
  );
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
  const html = highlightLines(lines.join("\n"), f.path);
  const code = el("div", { class: "code" });
  const frag = document.createDocumentFragment();
  lines.forEach((text, i) => frag.append(codeLine(i + 1, text, html && html[i])));
  code.append(frag);
  return code;
}

function renderDiff(d) {
  if (d.status === "too_large") {
    return el("div", { class: "notice" }, `Diff too large to show (${fmtSize(d.size)}).`);
  }
  if (!d.diff) return el("div", { class: "notice" }, "No textual changes.");
  if (/^Binary files .* differ$/m.test(d.diff)) return el("div", { class: "notice" }, "Binary file changed; diff not shown.");
  const diffLines = d.diff.split("\n");
  if (diffLines[diffLines.length - 1] === "") diffLines.pop();

  // Highlight the code part of every +/-/context line together (without the
  // marker column) so the diff gets the file's syntax colours.
  const codeIdx = [];
  let hunkSeen = false;
  diffLines.forEach((t, i) => {
    if (t.startsWith("@@")) hunkSeen = true;
    else if (hunkSeen && /^[ +-]/.test(t)) codeIdx.push(i);
  });
  const hl = highlightLines(codeIdx.map((i) => diffLines[i].slice(1)).join("\n"), d.path);
  const htmlAt = new Map();
  if (hl) codeIdx.forEach((i, k) => htmlAt.set(i, escapeHtml(diffLines[i][0]) + hl[k]));

  const code = el("div", { class: "code" });
  let newLine = 0;
  let inHunk = false;
  for (const [idx, text] of diffLines.entries()) {
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
    code.append(codeLine(num, text, htmlAt.get(idx), cls));
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
    if (window.hljs) {
      node.querySelectorAll("pre code").forEach((c) => {
        const lang = (c.className.match(/language-([\w+#-]+)/) || [])[1];
        if (lang && !hljs.getLanguage(lang)) c.classList.remove(`language-${lang}`);
        hljs.highlightElement(c);
      });
    }
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

// ------------------------------------------------------------ resizable columns

const COLUMN_DEFAULTS = { 1: 290, 2: 260, 4: 420 };
const MIN_COLUMN = 150;
const MIN_VIEWER = 200;
const WIDTHS_KEY = "project-review:column-widths";

function columnWidths() {
  const layout = document.querySelector(".layout");
  const w = {};
  for (const col of Object.keys(COLUMN_DEFAULTS)) {
    w[col] = parseFloat(getComputedStyle(layout).getPropertyValue(`--w${col}`)) || COLUMN_DEFAULTS[col];
  }
  return w;
}

// Clamp `cols` (default: all) so each stays >= MIN_COLUMN and the viewer keeps
// MIN_VIEWER; columns not listed keep their width.
function applyColumnWidths(w, cols = Object.keys(w)) {
  const layout = document.querySelector(".layout");
  const gutters = 15;
  for (const col of cols) {
    const others = Object.entries(w).filter(([c]) => c !== col).reduce((n, [, v]) => n + v, 0);
    const max = window.innerWidth - others - MIN_VIEWER - gutters;
    w[col] = Math.max(MIN_COLUMN, Math.min(w[col], Math.max(MIN_COLUMN, max)));
    layout.style.setProperty(`--w${col}`, `${Math.round(w[col])}px`);
  }
}

function saveColumnWidths() {
  try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(columnWidths())); } catch (_) {}
}

function initResizers() {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) || "null");
    if (saved) applyColumnWidths({ ...COLUMN_DEFAULTS, ...saved });
  } catch (_) {}

  document.querySelectorAll(".gutter").forEach((g) => {
    const col = g.dataset.col;
    // The chat column sits to the right of its gutter, so it shrinks as you drag right.
    const sign = col === "4" ? -1 : 1;
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = columnWidths();
      g.classList.add("dragging");
      document.body.classList.add("resizing");
      const move = (ev) => applyColumnWidths({ ...start, [col]: start[col] + sign * (ev.clientX - startX) }, [col]);
      const up = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        g.classList.remove("dragging");
        document.body.classList.remove("resizing");
        saveColumnWidths();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    g.addEventListener("dblclick", () => {
      applyColumnWidths({ ...columnWidths(), [col]: COLUMN_DEFAULTS[col] }, [col]);
      saveColumnWidths();
    });
  });
}

// ------------------------------------------------------------ wiring

initResizers();

$("clone-form").addEventListener("submit", (e) => { e.preventDefault(); cloneProject($("clone-url").value); });
document.querySelectorAll(".file-tabs .tab[data-mode]").forEach((t) =>
  t.addEventListener("click", () => {
    state.fileMode = t.dataset.mode;
    document.querySelectorAll(".file-tabs .tab[data-mode]").forEach((x) => x.classList.toggle("active", x === t));
    renderFiles();
  }),
);
$("file-filter").addEventListener("input", renderFiles);
$("expand-all").addEventListener("click", () => setAllFolders(true));
$("collapse-all").addEventListener("click", () => setAllFolders(false));
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
