"use strict";

const state = {
  projects: [],
  project: null,       // selected project name
  branches: [],
  branch: "",          // selected branch name; "" = all branches
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

const LAST_PROJECT_KEY = "project-review:last-project";
const ALL_BRANCHES = "";

async function loadProjects() {
  state.projects = await api("/api/projects");
  renderProjects();
}

function renderProjects() {
  const sel = $("project-select");
  sel.replaceChildren();
  const has = state.projects.length > 0;
  if (!has) sel.append(el("option", { value: "" }, "No projects yet: paste a git URL above"));
  for (const p of state.projects) {
    const opt = el("option", { value: p.name, title: p.url }, `${p.name} · ${p.commit_count} commits`);
    sel.append(opt);
  }
  sel.value = state.project || "";
  sel.disabled = !has;
  $("update-btn").disabled = !state.project;
  $("remove-btn").disabled = !state.project;
  $("review-btn").disabled = !state.project || !!state.reviewing;
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

async function updateProject() {
  const name = state.project;
  if (!name) return;
  const btn = $("update-btn");
  btn.disabled = true;
  btn.textContent = "…";
  setStatus(`Updating ${name}…`);
  try {
    const p = await api(`/api/projects/${enc(name)}/update`, { method: "POST" });
    setStatus(p.new_commits ? `${name}: ${p.new_commits} new commit(s).` : `${name} is up to date.`);
    await loadProjects();
    if (state.project === name) {
      await loadBranches(state.branch);
      loadGraph();
      await loadCommits();
      const tip = state.commits[0]?.sha;
      if (tip && !state.commits.some((c) => c.sha === state.commit)) await selectCommit(tip);
    }
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.textContent = "Update";
    renderProjects();
  }
}

async function deleteProject() {
  const name = state.project;
  if (!name || !confirm(`Remove the local clone of ${name}?`)) return;
  try {
    await api(`/api/projects/${enc(name)}`, { method: "DELETE" });
    state.selections = state.selections.filter((s) => s.project !== name);
    renderSelections();
    Object.assign(state, { project: null, branch: ALL_BRANCHES, branches: [], commits: [], commit: null, detail: null, files: [], open: null, graph: null });
    await loadProjects();
    if (state.projects.length) {
      await selectProject(state.projects[0].name);
    } else {
      renderBranches(); renderCommits(); renderCommitHeader(); renderFiles(); renderViewer();
    }
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function selectProject(name) {
  if (state.project !== name) {
    state.folderOpen = new Map();
    state.commit = null;
  }
  state.project = name;
  try { localStorage.setItem(LAST_PROJECT_KEY, name); } catch (_) {}
  renderProjects();
  loadPastReviews();
  await loadBranches();
  loadGraph();
  await loadCommits();
  if (state.commits.length && !state.commits.some((c) => c.sha === state.commit)) {
    await selectCommit(state.commits[0].sha);
  }
}

// ------------------------------------------------------------ branches

// Load the project's branches and pick `keep` if it still exists, else the
// default branch.
async function loadBranches(keep) {
  const project = state.project;
  let branches = [];
  try {
    branches = await api(`/api/projects/${enc(project)}/branches`);
  } catch (e) {
    setStatus(e.message, true);
  }
  if (project !== state.project) return; // another project was picked meanwhile
  state.branches = branches;
  const names = state.branches.map((b) => b.name);
  if (keep !== undefined && (keep === ALL_BRANCHES || names.includes(keep))) state.branch = keep;
  else state.branch = (state.branches.find((b) => b.default) || state.branches[0])?.name ?? ALL_BRANCHES;
  renderBranches();
}

function renderBranches() {
  const sel = $("branch-select");
  sel.replaceChildren();
  for (const b of state.branches || []) {
    sel.append(el("option", { value: b.name, title: `${short(b.sha)} · ${fmtDate(b.date)} · ${b.subject}` },
      b.default ? `${b.name} (default)` : b.name));
  }
  if (state.project) sel.append(el("option", { value: ALL_BRANCHES }, "All branches"));
  sel.value = state.branch ?? ALL_BRANCHES;
  sel.disabled = !state.project;
}

// ------------------------------------------------------------ network graph

const NET = { dx: 18, dy: 22, r: 4.5, padX: 14, padY: 30, labelRoom: 150 };
const NET_FULL = { dx: 30, dy: 32, r: 6, padX: 20, padY: 36, labelRoom: 200 };

async function loadGraph() {
  const project = state.project;
  let graph = null;
  if (project) {
    try { graph = await api(`/api/projects/${enc(project)}/graph`); } catch (e) { setStatus(e.message, true); }
  }
  if (project !== state.project) return;
  state.graph = graph;
  state.graphBySha = new Map((graph?.commits || []).map((c) => [c.sha, c]));
  renderNetwork(true);
}

function renderNetwork(scrollToEnd = false) {
  const box = $("network");
  const g = state.graph;
  $("network-info").textContent = g ? `${g.lanes.filter((l) => l.branch).length} branches · ${g.commits.length}${g.truncated ? "+" : ""} commits` : "";
  if (!g || !g.commits.length) {
    box.replaceChildren(...(state.project ? [el("div", { class: "net-empty muted" }, "No commits.")] : []));
    return;
  }
  const full = $("network-panel").classList.contains("fullscreen");
  const { dx, dy, r, padX, padY, labelRoom } = full ? NET_FULL : NET;
  const X = (c) => padX + c.x * dx;
  const Y = (lane) => padY + lane * dy;
  const maxX = g.commits.reduce((m, c) => Math.max(m, c.x), 0);
  const width = padX * 2 + maxX * dx + labelRoom;
  const height = padY * 2 + (g.lanes.length - 1) * dy;
  const laneCls = (i) => `lane-${i % 8}`;
  const currentLane = g.lanes.findIndex((l) => l.branch && l.branch === state.branch);
  const parts = [];

  // Date row: label the first commit of each day.
  let lastDay = "";
  for (const c of [...g.commits].sort((a, b) => a.x - b.x)) {
    const d = new Date(c.date);
    const day = isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (day && day !== lastDay) {
      parts.push(`<text class="net-date" x="${X(c)}" y="12">${escapeHtml(day)}</text>`);
      parts.push(`<line class="net-day" x1="${X(c)}" y1="16" x2="${X(c)}" y2="${height}"></line>`);
      lastDay = day;
    }
  }
  if (currentLane >= 0) {
    parts.push(`<rect class="net-lane-bg current" x="0" y="${Y(currentLane) - dy / 2}" width="${width}" height="${dy}"></rect>`);
  }
  for (const c of g.commits) {
    const cx = X(c), cy = Y(c.lane);
    c.parents.forEach((psha, i) => {
      const p = state.graphBySha.get(psha);
      if (!p) {
        // Parent is older than the commits shown: trail off to the left edge.
        if (i === 0) parts.push(`<path class="net-edge net-outside ${laneCls(c.lane)}" d="M${padX - 10},${cy} L${cx},${cy}"></path>`);
        return;
      }
      const px = X(p), py = Y(p.lane);
      let d, cls;
      if (p.lane === c.lane) {
        d = `M${px},${py} L${cx},${cy}`; cls = laneCls(c.lane);
      } else if (i === 0) {
        // Branch-off: leave the parent's lane right away, then run along the child's lane.
        d = `M${px},${py} C${px + dx / 2},${py} ${px + dx / 2},${cy} ${px + dx},${cy} L${cx},${cy}`; cls = laneCls(c.lane);
      } else {
        // Merge: run along the parent's lane, then join the merge commit.
        d = `M${px},${py} L${cx - dx},${py} C${cx - dx / 2},${py} ${cx - dx / 2},${cy} ${cx},${cy}`; cls = laneCls(p.lane);
      }
      parts.push(`<path class="net-edge ${cls}" d="${d}"></path>`);
    });
  }
  for (const c of g.commits) {
    const tip = `${c.short} ${c.subject}\n${c.author} · ${fmtDate(c.date)}${c.refs.length ? `\n${c.refs.join(", ")}` : ""}`;
    const sel = c.sha === state.commit ? " selected" : "";
    parts.push(`<circle class="net-dot ${laneCls(c.lane)}${sel}" data-sha="${c.sha}" cx="${X(c)}" cy="${Y(c.lane)}" r="${sel ? r + 1.5 : r}"><title>${escapeHtml(tip)}</title></circle>`);
  }
  g.lanes.forEach((lane, i) => {
    if (!lane.branch) return;
    const tip = state.graphBySha.get(lane.tip);
    if (!tip) return;
    const cur = i === currentLane ? " current" : "";
    parts.push(`<text class="net-label ${laneCls(i)}${cur}" data-branch="${escapeHtml(lane.branch)}" x="${X(tip) + 9}" y="${Y(i) + 4}">${escapeHtml(lane.branch)}${lane.default ? " ★" : ""}<title>Switch to ${escapeHtml(lane.branch)}</title></text>`);
  });

  const { scrollLeft, scrollTop } = box;
  box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
  if (scrollToEnd) {
    box.scrollLeft = box.scrollWidth;
    box.scrollTop = 0;
  } else {
    box.scrollLeft = scrollLeft;
    box.scrollTop = scrollTop;
  }
}

async function selectFromGraph(sha) {
  const node = state.graphBySha?.get(sha);
  if (!node) return;
  if (!state.commits.some((c) => c.sha === sha)) {
    // Switch to the branch whose lane holds the commit (or all branches).
    const lane = state.graph.lanes[node.lane];
    state.branch = lane?.branch ?? ALL_BRANCHES;
    renderBranches();
    await loadCommits();
  }
  await selectCommit(sha);
  document.querySelector(`#commits li.active`)?.scrollIntoView({ block: "nearest" });
}

function setNetworkFull(on) {
  $("network-panel").classList.toggle("fullscreen", on);
  document.body.classList.toggle("has-fullscreen", on);
  $("network-full").textContent = on ? "Minimize" : "⛶";
  renderNetwork(true);
}

async function selectBranch(branch) {
  state.branch = branch;
  renderBranches();
  await loadCommits();
  // Show the branch tip, so switching branches previews that branch's files.
  if (state.branch === branch && state.commits.length) await selectCommit(state.commits[0].sha);
}

// ------------------------------------------------------------ commits

async function loadCommits() {
  const { project, branch } = state;
  const q = branch ? `?branch=${enc(branch)}` : "";
  let commits = [];
  try {
    commits = await api(`/api/projects/${enc(project)}/commits${q}`);
  } catch (e) {
    setStatus(e.message, true);
  }
  // Drop the response if the user switched project/branch while it loaded.
  if (project !== state.project || branch !== state.branch) return;
  state.commits = commits;
  renderCommits();
}

function renderCommits() {
  renderNetwork();
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
  let detail = null;
  let files = [];
  try {
    [detail, files] = await Promise.all([api(base), api(`${base}/files`)]);
  } catch (e) {
    setStatus(e.message, true);
  }
  if (state.commit !== sha) return; // a different commit was picked meanwhile
  state.detail = detail;
  state.files = files;
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

// ------------------------------------------------------------ usage

const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n || 0);
const fmtCost = (u) => (u.cost_known ? "" : "≥ ") + `$${u.cost.toFixed(u.cost >= 1 ? 2 : 4)}`;

function renderUsage(u) {
  const s = u.session;
  $("u-in").textContent = fmtTokens(s.input);
  $("u-out").textContent = fmtTokens(s.output + s.thoughts);
  $("u-cache").textContent = fmtTokens(s.cached);
  $("u-cost").textContent = fmtCost(s);
  $("u-cost").title = s.cost_known ? "" : "Some calls used a model missing from pricing.json";
  $("u-all").textContent = fmtCost(u.all_time);
  const t = u.turn;
  if (t) {
    $("u-model").textContent = t.model || "";
    $("u-ctx").textContent = fmtTokens(t.context_tokens);
    const max = t.context_window;
    $("u-ctx-max").textContent = max ? fmtTokens(max) : "?";
    const pct = max ? Math.min(100, (100 * t.context_tokens) / max) : 0;
    const fill = $("u-ctx-fill");
    fill.style.width = `${pct}%`;
    fill.className = pct > 80 ? "full" : pct > 50 ? "warn" : "";
  }
}

function resetUsage(data) {
  renderUsage({ ...data, turn: { model: data.model, context_tokens: 0, context_window: null } });
  $("u-ctx-max").textContent = "";
}

async function loadUsage() {
  try {
    resetUsage(await api(`/api/usage${state.sessionId ? `?session_id=${enc(state.sessionId)}` : ""}`));
  } catch (_) {}
}

function turnUsageText(t) {
  const parts = [`↑ ${fmtTokens(t.input)}`, `↓ ${fmtTokens(t.output + t.thoughts)}`];
  if (t.cached) parts.push(`cache ${fmtTokens(t.cached)}`);
  parts.push(`${t.calls} call${t.calls === 1 ? "" : "s"}`, t.cost_known ? `$${t.cost.toFixed(4)}` : "cost unknown");
  return parts.join(" · ");
}

// ------------------------------------------------------------ chat

function renderMarkdown(node, text) {
  if (window.marked && window.DOMPurify) {
    node.innerHTML = DOMPurify.sanitize(marked.parse(text));
    node.querySelectorAll("table").forEach((t) => {
      const wrap = el("div", { class: "table-wrap" });
      t.replaceWith(wrap);
      wrap.append(t);
    });
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
  let lastTurn = null;
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, session_id: state.sessionId, project: state.project, branch: state.branch || null, commit: state.commit, selections }),
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
        else if (ev.type === "usage") { renderUsage(ev); lastTurn = ev.turn; }
        out.scrollTop = out.scrollHeight;
      }
    }
  } catch (e) {
    agent.append(el("div", { class: "msg-error" }, e.message));
  } finally {
    if (!text) body.replaceChildren();
    if (lastTurn) agent.append(el("div", { class: "turn-usage" }, turnUsageText(lastTurn)));
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
  loadUsage();
  $("output").replaceChildren(initialHint.cloneNode(true));
  wireExamples();
}

function wireExamples() {
  document.querySelectorAll(".example").forEach((b) =>
    b.addEventListener("click", () => { $("question").value = b.textContent; $("question").focus(); }),
  );
}

// ------------------------------------------------------------ reviews

// POST and read an NDJSON event stream, calling onEvent for each event.
async function streamEvents(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// A usage panel like the chat header's, for one review run.
function usagePanel() {
  const f = {};
  const val = (key, text = "0") => (f[key] = el("b", {}, text));
  const fill = el("span");
  const node = el("div", { class: "usage review-usage" },
    el("div", { class: "usage-row" },
      el("span", { title: "Tokens for this review: input sent (↑) and output incl. thinking (↓)" }, "Tokens: ", val("in", "↑ 0"), " ", val("out", "↓ 0")),
      el("span", { title: "Input tokens served from Gemini's context cache" }, "Cache: ", val("cache")),
      el("span", { class: "spacer" }),
      (f.model = el("span", { class: "muted" }, "")),
    ),
    el("div", { class: "usage-row", title: "Size of the last request vs. the model's context window" },
      el("span", {}, "Context:"), val("ctx"), el("span", { class: "ctx-bar" }, fill), (f.max = el("span", { class: "muted" }, "")),
    ),
    el("div", { class: "usage-row" },
      el("span", { title: "Estimated cost of this review from pricing.json" }, "API Cost: ", val("cost", "$0.0000")),
      el("span", { class: "spacer" }),
      (f.calls = el("span", { class: "muted" }, "")),
    ),
  );
  const update = (t) => {
    if (!t) return;
    f.in.textContent = `↑ ${fmtTokens(t.input)}`;
    f.out.textContent = `↓ ${fmtTokens(t.output + t.thoughts)}`;
    f.cache.textContent = fmtTokens(t.cached);
    f.cost.textContent = fmtCost(t);
    f.model.textContent = t.model || "";
    f.calls.textContent = t.calls ? `${t.calls} model call${t.calls === 1 ? "" : "s"}` : "";
    f.ctx.textContent = fmtTokens(t.context_tokens || 0);
    f.max.textContent = t.context_window ? fmtTokens(t.context_window) : "";
    const pct = t.context_window ? Math.min(100, (100 * (t.context_tokens || 0)) / t.context_window) : 0;
    fill.style.width = `${pct}%`;
    fill.className = pct > 80 ? "full" : pct > 50 ? "warn" : "";
  };
  return { node, update };
}

// A review card in the chat pane; it can expand to full screen and back.
function reviewCard(heading) {
  const title = el("strong", { class: "review-title" }, heading);
  const subtitle = el("div", { class: "review-sub muted" });
  const download = el("a", { class: "button disabled", "aria-disabled": "true", title: "Download this review as a PDF" }, "Download Review");
  const expand = el("button", { title: "Full screen (Esc to exit)" }, "⛶ Full screen");
  const progress = el("div", { class: "review-progress" });
  const body = el("div", { class: "review-body md" });
  const usageBox = usagePanel();
  const card = el("div", { class: "review-card" },
    el("div", { class: "review-head" }, title, el("span", { class: "spacer" }), download, expand),
    subtitle, usageBox.node, progress, body,
  );
  const setFull = (on) => {
    card.classList.toggle("fullscreen", on);
    document.body.classList.toggle("has-fullscreen", on);
    expand.textContent = on ? "Minimize" : "⛶ Full screen";
    if (!on) card.scrollIntoView({ block: "nearest" });
  };
  expand.addEventListener("click", () => setFull(!card.classList.contains("fullscreen")));
  card.addEventListener("keydown", (e) => { if (e.key === "Escape") setFull(false); });
  return {
    card, body, progress, subtitle, usage: usageBox,
    ready(meta, markdown, heading2, sub) {
      if (heading2) title.textContent = heading2;
      if (sub) subtitle.textContent = sub;
      renderMarkdown(body, markdown);
      download.href = `/api/reviews/${enc(meta.id)}/pdf`;
      download.setAttribute("download", "");
      download.classList.remove("disabled");
      download.removeAttribute("aria-disabled");
      usageBox.update(meta.usage && meta.usage.calls ? meta.usage : null);
    },
    log(text, cls = "") { progress.append(el("div", { class: cls }, text)); },
  };
}

function showCard(card) {
  const out = $("output");
  out.querySelector(".hint")?.remove();
  out.append(card);
  card.scrollIntoView({ block: "start" });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("network-panel").classList.contains("fullscreen")) return setNetworkFull(false);
  const full = document.querySelector(".review-card.fullscreen");
  if (full) full.querySelector(".review-head button").click();
});

async function startReview() {
  if (!state.project || state.reviewing) return;
  const project = state.project;
  const branch = state.branch || null;
  const where = `${project}${branch ? ` @ ${branch}` : " (HEAD)"}`;
  const ui = reviewCard(`Review · ${where}`);
  ui.subtitle.textContent = "Static architecture review: reads all source files, samples data files.";
  showCard(ui.card);

  state.reviewing = true;
  const btn = $("review-btn");
  btn.disabled = true;
  btn.textContent = "Reviewing…";
  let saved = false;
  try {
    await streamEvents("/api/review", { project, branch }, (ev) => {
      if (ev.type === "status") ui.log(ev.text);
      else if (ev.type === "tool") ui.log(`${ev.name}(${describeArgs(ev.args)})`, "tool-call");
      else if (ev.type === "error") ui.log(ev.text, "msg-error");
      else if (ev.type === "usage") {
        ui.usage.update(ev.turn);
        $("u-all").textContent = fmtCost(ev.all_time);
      } else if (ev.type === "review") {
        saved = true;
        ui.progress.replaceChildren();
        ui.ready(ev.meta, ev.markdown, ev.title, ev.subtitle);
        loadPastReviews();
      }
    });
    if (!saved) ui.log("The model returned no review.", "msg-error");
  } catch (e) {
    ui.log(e.message, "msg-error");
  } finally {
    state.reviewing = false;
    btn.disabled = !state.project;
    btn.textContent = "Review this branch";
  }
}

async function loadPastReviews() {
  const sel = $("past-reviews");
  const project = state.project;
  let list = [];
  if (project) {
    try { list = await api(`/api/reviews?project=${enc(project)}`); } catch (_) {}
  }
  if (project !== state.project) return;
  sel.replaceChildren(el("option", { value: "" }, list.length ? `Past reviews (${list.length})` : "No past reviews"));
  for (const m of list) {
    const cost = m.usage && m.usage.calls ? ` · ${fmtCost(m.usage)}` : "";
    sel.append(el("option", { value: m.id }, `${m.branch || "HEAD"} · ${m.created.replace("T", " ").slice(0, 16)}${cost}`));
  }
  sel.disabled = !list.length;
}

async function openPastReview(id) {
  if (!id) return;
  $("past-reviews").value = "";
  try {
    const r = await api(`/api/reviews/${enc(id)}`);
    const ui = reviewCard(r.title);
    ui.ready(r.meta, r.markdown, r.title, r.subtitle);
    showCard(ui.card);
  } catch (e) {
    setStatus(e.message, true);
  }
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
$("project-select").addEventListener("change", (e) => { if (e.target.value) selectProject(e.target.value); });
$("branch-select").addEventListener("change", (e) => selectBranch(e.target.value));
$("update-btn").addEventListener("click", updateProject);
$("remove-btn").addEventListener("click", deleteProject);
$("review-btn").addEventListener("click", startReview);
$("network").addEventListener("click", (e) => {
  const label = e.target.closest("[data-branch]");
  const dot = e.target.closest("[data-sha]");
  if (label) {
    selectBranch(label.dataset.branch);
  } else if (dot) {
    selectFromGraph(dot.dataset.sha);
  }
});
$("network-full").addEventListener("click", () => setNetworkFull(!$("network-panel").classList.contains("fullscreen")));
$("past-reviews").addEventListener("change", (e) => openPastReview(e.target.value));
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

async function init() {
  await loadProjects();
  renderBranches();
  let last = null;
  try { last = localStorage.getItem(LAST_PROJECT_KEY); } catch (_) {}
  const start = state.projects.find((p) => p.name === last) || state.projects[0];
  if (start) await selectProject(start.name);
}

init().catch((e) => setStatus(e.message, true));
loadUsage();
