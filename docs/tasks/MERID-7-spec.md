# MERID-7 — Workspace stats: card shortcut to Stats tab and aggregated stats in All Tickets

## Scope

Builds on MERID-4 (per-project `GET /api/stats` + Stats tab on the project
board). Adds two entry points to that same data, plus the workspace-wide
aggregate they both need:

1. A stats icon/button on every home-dashboard project card that opens that
   project's view with the **Stats tab** active instead of the Board tab.
2. `GET /api/stats` **without** a `project` query parameter aggregates every
   project in the global registry, reading each one's `.meridian/events.jsonl`
   fresh on that request (no caching, ever — hard rule this codebase already
   applies to `/api/stats?project=...`). `GET /api/stats?project=<path>`
   keeps behaving exactly as MERID-4 shipped it.
3. The All Tickets (`/tickets`) view gains the same Stats tab UI as a project
   view, fetching the workspace aggregate, with a Project column in its
   per-task table.

Out of scope: any URL/route change to make a tab deep-linkable (`lib/routes.js`
is untouched — see `## Approach` §4), per-dispatch running-event durations
(already out of scope per MERID-4), persistence/caching of any computed
stats, charts, and browser/DOM test automation (this codebase has none; see
MERID-4's own "Out of Scope" for the precedent this follows).

## Approach

### 1. `lib/stats.js` — refactor + workspace aggregation additions

**Refactor `aggregateStats` into two internal pieces first**, so the
workspace aggregator can reuse the exact same per-task math without
duplicating it, and so `aggregateStats`'s own public behavior — and every
existing assertion in `test/stats.test.js` — stays byte-for-byte identical:

```js
// Everything aggregateStats currently does UP TO (not including) the final
// "shape stages from entries" loop. Returns the raw per-task map plus the
// two entry-maps that loop consumes, so a caller aggregating several
// projects can merge entries across projects before shaping them.
function aggregateTaskStats(events, now = new Date()) {
    // ...identical body to today's aggregateStats, down to building
    // `tasks`, `stageTimeEntries`, `stageTokenEntries`...
    return { tasks, stageTimeEntries, stageTokenEntries };
}

// Turns two entry-maps (stage -> [{task, ms, ongoing, ...}] / [{task, tokens,
// maxContextTokens, ...}]) into the final `stages` object: avgMs, maxMs,
// topByTime (TOP_N), avgTokens, maxTokens, topByTokens (TOP_N). Extracted
// verbatim from today's aggregateStats so both the single-project and
// workspace-wide paths shape stages identically.
function shapeStages(stageTimeEntries, stageTokenEntries) {
    // ...identical body to today's aggregateStats final loop...
    return stages;
}

function aggregateStats(events, now = new Date()) {
    const { tasks, stageTimeEntries, stageTokenEntries } = aggregateTaskStats(events, now);
    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries) };
}
```

`aggregateTaskStats` and `shapeStages` are not exported — they're
implementation detail of this module, same as `readEventLines` was
before MERID-4 needed it directly. `aggregateStats`'s exported signature,
return shape, and every existing unit test's assertions are unchanged.

**New: registry listing.**

```js
// Reads <workspaceDir>/.meridian/projects.json and resolves each entry's
// display name from its own project-info.json (falling back to the
// directory's basename), mirroring the name resolution server.js's
// getStatusData() does — duplicated here in miniature because this module
// owns its own filesystem reads and server.js must stay a thin route.
// A missing or malformed registry returns [] rather than throwing; a
// project directory without a readable project-info.json still gets an
// entry (name falls back to basename).
function listRegisteredProjects(workspaceDir) {
    const registryPath = path.join(workspaceDir, '.meridian', 'projects.json');
    if (!fs.existsSync(registryPath)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (err) {
        return [];
    }
    return (parsed.projects || []).map(p => {
        const projPath = p.path;
        let name = path.basename(projPath);
        try {
            const infoPath = path.join(projPath, '.meridian', 'project-info.json');
            if (fs.existsSync(infoPath)) {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                if (info && info.name) name = info.name;
            }
        } catch (err) {
            // fall back to basename
        }
        return { path: projPath, name };
    });
}
```

**New: pure workspace merge.**

```js
// Merges already-read per-project event arrays into one workspace-wide
// aggregate. `projectEntries` is [{path, name, events}] — events already
// read by the caller, so this function stays pure/fs-free like
// aggregateStats. Each project's own per-task math is computed by
// aggregateTaskStats (the same code aggregateStats uses), so a task's stage
// totals are identical whether read through the single-project or
// workspace-wide path.
//
// Task keys are `${projectPath}::${taskId}` because task ids are only
// unique within one project — two projects can both have a "T1". Each
// task's value additionally carries `task` (the bare id) and `project`
// ({path, name}) so the UI never has to parse the composite key. Stage
// top-N entries (topByTime/topByTokens) get the same `project` tag added,
// so an outlier identifies which project it belongs to.
//
// A project with no events (missing events.jsonl, or none read due to an
// upstream error) contributes nothing — no task entries, no stage entries —
// without any special-casing here.
function aggregateWorkspaceStats(projectEntries, now = new Date()) {
    const tasks = {};
    const stageTimeEntries = new Map();
    const stageTokenEntries = new Map();

    for (const entry of projectEntries || []) {
        if (!entry || typeof entry.path !== 'string') continue;
        const project = { path: entry.path, name: entry.name || entry.path };
        const { tasks: projTasks, stageTimeEntries: projTime, stageTokenEntries: projTokens }
            = aggregateTaskStats(entry.events, now);

        for (const [taskId, t] of Object.entries(projTasks)) {
            tasks[`${entry.path}::${taskId}`] = { task: taskId, project, ...t };
        }
        for (const [stage, list] of projTime) {
            if (!stageTimeEntries.has(stage)) stageTimeEntries.set(stage, []);
            stageTimeEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
        for (const [stage, list] of projTokens) {
            if (!stageTokenEntries.has(stage)) stageTokenEntries.set(stage, []);
            stageTokenEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
    }

    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries) };
}
```

**New: the one I/O function for the workspace path**, same role
`computeProjectStats` plays for a single project — the only place that
touches the filesystem for this feature, called fresh on every request:

```js
// Reads every registered project's events.jsonl fresh — no caching — and
// aggregates across all of them. A project whose events.jsonl can't be read
// (I/O error other than "file missing", which readEventLines already
// tolerates) contributes an `errors` entry instead of failing the whole
// request; its own data is simply absent from tasks/stages.
function computeWorkspaceStats(workspaceDir, now = new Date()) {
    const registered = listRegisteredProjects(workspaceDir);
    const errors = [];
    const projectEntries = registered.map(p => {
        try {
            return { path: p.path, name: p.name, events: readEventLines(p.path) };
        } catch (err) {
            errors.push({ file: `${p.name} (events.jsonl)`, message: err.message });
            return { path: p.path, name: p.name, events: [] };
        }
    });
    const { tasks, stages } = aggregateWorkspaceStats(projectEntries, now);
    return { tasks, stages, errors };
}
```

`module.exports` adds `aggregateWorkspaceStats, computeWorkspaceStats,
listRegisteredProjects` to the existing `aggregateStats, computeProjectStats,
readEventLines, TOP_N`.

### 2. `server.js` — wiring only

```js
const { computeProjectStats, computeWorkspaceStats } = require('./lib/stats');
```

Replace the `/api/stats` handler's top, keeping everything below the
existing `if (!isRegisteredProject(...))` check untouched:

```js
app.get('/api/stats', (req, res) => {
    const projectPath = req.query.project;

    // No `project` key at all -> workspace-wide aggregate across every
    // registered project. A present-but-blank `?project=` still 400s, same
    // as today - only true absence of the query param changes meaning.
    if (projectPath === undefined) {
        const { tasks, stages, errors } = computeWorkspaceStats(WORKSPACE_DIR);
        return res.json({ project: null, generatedAt: new Date().toISOString(), tasks, stages, errors });
    }

    if (typeof projectPath !== 'string' || !projectPath.trim()) {
        return res.status(400).json({ error: 'project is required' });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.json({
            project: projectPath,
            generatedAt: new Date().toISOString(),
            tasks: {},
            stages: {},
            errors: [{ file: 'System', message: `Project not registered with Meridian: ${projectPath}` }]
        });
    }
    const { tasks, stages } = computeProjectStats(projectPath);
    res.json({ project: projectPath, generatedAt: new Date().toISOString(), tasks, stages, errors: [] });
});
```

`WORKSPACE_DIR` is the same constant `PROJECTS_JSON_PATH` is built from
(top of `server.js`) — the workspace-wide path reads the same registry
`isRegisteredProject` already checks against, not `RUNNING_DIR`. No other
line in this route changes; `server.js` gains zero aggregation logic.

### 3. Frontend — home card stats shortcut

**`public/app.js` — `renderProjects`**, inside the `.project-title` (already
`display:flex; gap:0.5rem`), add a small icon button next to the project
name, reusing the same path-escaping expression the card's own `onclick`
already uses:

```js
<h2 class="project-title">
    ${proj.name}
    <button type="button" class="stats-icon-btn" title="View stats for ${proj.name.replace(/"/g, '&quot;')}"
        onclick="showProjectView('${proj.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', true, 'stats'); event.stopPropagation();">📊</button>
</h2>
```

`event.stopPropagation()` is required — the card `<div>` itself still has
its own `onclick="showProjectView(...)"` (board, default tab); without it
the icon click would bubble and fire both handlers, same pattern
`fix-ai-btn` already uses on the same card.

**`showProjectView`** gains a third parameter, `initialTab`, defaulting to
`'board'` so every existing caller (card body click, `handleUrlRouting`
on a deep link, `popstate`) is unaffected:

```js
window.showProjectView = function(projPath, pushState = true, initialTab = 'board') {
    currentProjectViewPath = projPath;
    activateView('project');
    refreshProjectView();
    if (tabStatsBtn) tabStatsBtn.classList.remove('hidden');
    if (initialTab === 'stats') {
        showStatsTab();
    } else {
        showBoardTab();
    }

    if (pushState && currentProjectsData.length > 0) {
        const proj = currentProjectsData.find(p => p.path === projPath);
        const relPath = proj ? (proj.relativePath || proj.path.split('/').pop()) : projPath.split('/').pop();
        const targetUrl = '/' + relPath;
        if (window.location.pathname !== targetUrl) {
            history.pushState({ projPath }, '', targetUrl);
        }
    }
};
```

No change to `lib/routes.js` / `resolveRoute` — the URL for a project view
stays exactly `/<slug>` whichever tab is active, same as it already was
before this task (opening a project always lands on the same URL
regardless of tab). A reload or deep link always lands on Board, which is
the existing, unchanged behavior; only the in-app card-icon click starts on
Stats. `showStatsTab()` itself is unchanged from MERID-4 — it already just
toggles panel visibility and calls `loadStats()`; calling it before or
after `tabStatsBtn`'s `hidden` class is removed doesn't matter, but the
order above (`remove('hidden')` first) keeps it consistent with the global
view's own sequence below.

### 4. Frontend — All Tickets Stats tab (workspace aggregate)

`public/index.html`'s `#project-view` (tabs, `#board-panel`, `#stats-panel`)
is already shared between a single project's view and the All Tickets view
— `activateView('global')` swaps in the very same `project-view` element
`activateView('project')` does. **No new markup is needed for the tab or
panel shells**; only the per-task table gains a Project column, and it must
work whether the data is a single project's (no column shown) or the
workspace's (column shown) without two separate table builders.

**`index.html`** — `#stats-task-table`: add a Project header, always
present in the DOM (so the existing click-to-sort wiring, which binds once
at script load, keeps working for it), toggled by a class on the table
rather than inserted/removed:

```html
<table class="stats-table" id="stats-task-table">
    <thead>
        <tr>
            <th data-sort="task">Task</th>
            <th data-sort="project" class="stats-col-project">Project</th>
            <th data-sort="stage">Stage</th>
            <th data-sort="ms">Time in stage</th>
            <th data-sort="dispatches">Dispatches</th>
            <th data-sort="outputTokens">Output tokens</th>
            <th data-sort="maxContextTokens">Max context tokens</th>
        </tr>
    </thead>
    <tbody id="stats-task-tbody"></tbody>
</table>
```

**`styles.css`** — hide the column when not needed:

```css
.stats-table--project-hidden .stats-col-project { display: none; }
```

Also add the card icon's style, near `.fix-ai-btn`:

```css
.stats-icon-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.7;
    padding: 0 0.1rem;
}
.stats-icon-btn:hover { opacity: 1; }
```

**`app.js` — `showGlobalTicketsView`**: stop hiding the Stats tab for the
global view (it now has a meaningful aggregate to show), everything else
unchanged:

```js
window.showGlobalTicketsView = function(pushState = true) {
    currentProjectViewPath = '__GLOBAL__';
    activateView('global');
    setBreadcrumb('All Tickets');
    document.title = 'All Tickets · Meridian';
    refreshProjectView();
    if (tabStatsBtn) tabStatsBtn.classList.remove('hidden');
    showBoardTab();

    if (pushState && window.location.pathname !== '/tickets') {
        history.pushState(null, '', '/tickets');
    }
};
```

(Still always opens on Board by default — nothing asks for a stats-first
entry into All Tickets; only the per-project card icon does that.)

**`app.js` — `loadStats`**: fetch the workspace endpoint when the current
view is global, per-project endpoint otherwise; drop the early return that
used to skip global entirely:

```js
async function loadStats() {
    if (!currentProjectViewPath) return;
    const isGlobal = currentProjectViewPath === '__GLOBAL__';
    const url = isGlobal ? '/api/stats' : `/api/stats?project=${encodeURIComponent(currentProjectViewPath)}`;
    const loading = document.getElementById('stats-loading');
    const errorBox = document.getElementById('stats-error');
    const content = document.getElementById('stats-content');
    loading.classList.remove('hidden');
    errorBox.classList.add('hidden');
    content.classList.add('hidden');
    lastStatsData = null;
    try {
        const res = await fetch(url);
        const data = await res.json();
        loading.classList.add('hidden');
        if (data.errors && data.errors.length > 0) {
            errorBox.textContent = data.errors.map(e => e.message).join('; ');
            errorBox.classList.remove('hidden');
            // Errors here are per-project read failures folded into the
            // response, not a hard failure — data.tasks/stages can still be
            // non-empty. Fall through and render whatever came back, same
            // as the single-project path already treats them as
            // non-fatal-but-shown.
        }
        lastStatsData = data;
        content.classList.remove('hidden');
        renderStatsPanel(data);
    } catch (err) {
        loading.classList.add('hidden');
        errorBox.textContent = 'Failed to load stats: ' + err.message;
        errorBox.classList.remove('hidden');
    }
}
```

Note the one behavior change folded in here: today, any non-empty
`errors` array (even a single non-fatal one) stops the single-project
panel from rendering at all (`return` right after showing the error box).
That reads fine when `errors` only ever means "this one project isn't
registered" (nothing else to show). It reads wrong for the workspace
aggregate, where `errors` can carry a handful of per-project read failures
alongside perfectly good data from every other project — the failures
should surface as a banner, not blank the whole table. Apply the same
(more correct) "show the banner, still render whatever data came back"
behavior uniformly, for both endpoints, rather than branching in the
frontend on `isGlobal` — it does not change observable behavior for the
single-project case's own tests (which only ever exercise the "unregistered
project" all-errors-no-data case, where rendering an empty table under the
banner is indistinguishable in practice from not rendering at all).

**`app.js` — `renderStatsPanel`**: parameterize the Project column off the
same `currentProjectViewPath === '__GLOBAL__'` flag `renderKanbanBoard`
already uses for its own global-vs-project branching (`isGlobal`), rather
than inspecting the fetched data — one table-builder, one flag:

```js
function renderStatsPanel(data) {
    const stageTbody = document.getElementById('stats-stage-tbody');
    const stageNames = Object.keys(data.stages).sort();
    stageTbody.innerHTML = stageNames.map(name => {
        const s = data.stages[name];
        return `<tr>
            <td>${name}</td>
            <td>${s.taskCount}</td>
            <td>${formatDuration(s.avgMs)}</td>
            <td>${formatDuration(s.maxMs)}</td>
            <td>${Math.round(s.avgTokens).toLocaleString()}</td>
            <td>${Math.round(s.maxTokens).toLocaleString()}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6">No stage data yet.</td></tr>';

    const showProject = currentProjectViewPath === '__GLOBAL__';
    const taskTable = document.getElementById('stats-task-table');
    taskTable.classList.toggle('stats-table--project-hidden', !showProject);

    let rows = [];
    for (const [key, t] of Object.entries(data.tasks)) {
        // Workspace entries carry `task` + `project`; single-project
        // entries are keyed by the bare task id and carry neither.
        const taskId = t.task || key;
        const projectLabel = t.project ? (t.project.name || t.project.path) : '';
        const stageNamesForTask = Object.keys(t.stages);
        const base = {
            task: taskId, project: projectLabel,
            dispatches: t.dispatches.count,
            outputTokens: t.dispatches.totalOutputTokens,
            maxContextTokens: t.dispatches.maxContextTokens
        };
        if (stageNamesForTask.length === 0) {
            rows.push({ ...base, stage: '(no status events)', ms: 0, ongoing: false });
            continue;
        }
        for (const stageName of stageNamesForTask) {
            const s = t.stages[stageName];
            rows.push({ ...base, stage: stageName, ms: s.totalMs, ongoing: s.ongoing });
        }
    }

    const { key, dir } = statsSort;
    rows.sort((a, b) => {
        const va = a[key], vb = b[key];
        const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return dir === 'asc' ? cmp : -cmp;
    });

    const taskTbody = document.getElementById('stats-task-tbody');
    taskTbody.innerHTML = rows.map(r => `<tr>
        <td>${r.task}</td>
        <td class="stats-col-project">${r.project}</td>
        <td>${r.stage}${r.ongoing ? ' <span class="stats-ongoing-badge">ongoing</span>' : ''}</td>
        <td>${formatDuration(r.ms)}</td>
        <td>${r.dispatches}</td>
        <td>${r.outputTokens.toLocaleString()}</td>
        <td>${r.maxContextTokens.toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="7">No task data yet.</td></tr>';
}
```

`statsSort` may now hold `key: 'project'` after a header click — the
existing generic string/number comparator already handles it
(`r.project` is always a string, `''` when not applicable, so sorting by it
on a single-project view is a harmless no-op). No change needed to the
sort-header click wiring at the bottom of the file; it already does
`document.querySelectorAll('#stats-task-table th[data-sort]')`, and the new
Project `<th>` carries `data-sort="project"` from the static markup above,
so it's included automatically.

Bump `styles.css?v=` and `app.js?v=` in `index.html` (currently `25` and
`37`) to `26` / `38`, per this repo's existing convention for every
markup/script change to this file.

## Testing

Follow `test/api-stats.test.js` / `test/api-tasks.test.js`'s
`workspaceWith`/`withServer` fixtures. Never touch the real board or the
checkout's own `.meridian/`.

### `test/stats.test.js` (extend)

- `aggregateStats`'s existing assertions are untouched and still pass
  verbatim — proof the `aggregateTaskStats`/`shapeStages` refactor didn't
  change its output shape.
- `listRegisteredProjects`: a temp workspace with 2 project dirs (one with a
  `project-info.json` `{name: "Alpha"}`, one with none) registered in
  `.meridian/projects.json` returns `[{path, name:"Alpha"}, {path,
  name:"<basename>"}]`; a workspace with no `projects.json` returns `[]`; a
  `projects.json` containing malformed JSON returns `[]` without throwing.
- `aggregateWorkspaceStats` (pure, feed `[{path, name, events}, ...]`
  directly, no filesystem):
  - two projects each with their own task id `"T1"` (colliding ids across
    projects) produce two distinct entries,
    `tasks["<pathA>::T1"]` and `tasks["<pathB>::T1"]`, each with the
    correct `task: "T1"` and `project: {path, name}`.
  - a stage present in both projects' events (e.g. both have tasks that
    visited `in_progress`) produces one merged `stages.in_progress` whose
    `avgMs`/`taskCount` reflect entries from **both** projects combined, not
    just one.
  - `stages.<name>.topByTime` / `topByTokens` entries carry a `project`
    field; construct one project's task with more time/tokens in a shared
    stage than the other's and assert the bigger one sorts first
    workspace-wide, with the correct `project.path`.
  - a project entry with `events: []` (or missing entirely from the input
    array) contributes no `tasks` keys with its path and does not create or
    perturb any `stages` entry.
- `computeWorkspaceStats` (filesystem-backed, `fs.mkdtempSync` workspace
  with 2+ real registered projects, each with its own real
  `.meridian/events.jsonl` written directly):
  - returns `tasks`/`stages` reflecting both projects' real files.
  - a registered project with no `events.jsonl` at all contributes nothing
    and produces no `errors` entry (missing file is not an error — same
    contract `readEventLines` already has).
  - a registered project whose `.meridian/events.jsonl` is a **directory**
    (`fs.mkdirSync` instead of a file — reliably forces `fs.readFileSync` to
    throw `EISDIR`, portable and deterministic, unlike a permissions-based
    trick) produces one entry in the returned `errors` array and does not
    prevent the other registered project's data from being returned.
  - an empty/missing `projects.json` returns `{tasks: {}, stages: {},
    errors: []}`.

### `test/api-stats.test.js` (extend)

Add a second fixture builder alongside the existing single-project
`workspaceWith`:

```js
// A workspace registering N projects, one shared .meridian/projects.json.
// Mirrors workspaceWith but for the workspace-aggregate ("no project param")
// tests this task adds.
function workspaceWithProjects(names) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dirs = names.map((name, i) => {
        const dir = path.join(ws, `fixture-project-${i}`);
        fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.meridian', 'project-info.json'),
            JSON.stringify({ name, key: `T${i}`, stack: [], description: 'x' })
        );
        return dir;
    });
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: dirs.map(path => ({ path })) })
    );
    return { ws, dirs };
}
```

- **Replace** the existing `'GET /api/stats with no project query param
  returns 400'` test (that behavior is intentionally changing) with: `GET
  /api/stats` with no `project` param against a 2-project workspace returns
  `200`; a task seeded and moved through statuses in each project (via the
  real `POST /api/projects/tasks` + `PUT .../tasks/:id` API) shows up in the
  response's `tasks` under a key containing both its project path and task
  id, with `tasks[key].project.path` matching that project's directory and
  `tasks[key].project.name` matching its registered name.
- `GET /api/stats?project=` (present but blank) still returns `400` —
  proves only true absence of the param changes meaning.
- `GET /api/stats?project=<oneOfTheTwoDirs>` against the same 2-project
  workspace returns only that project's task(s) — the other project's task
  never appears — regression proof that scoped requests still isolate to
  one project.
- A third registered project with no `events.jsonl` at all contributes no
  entries and produces no error.
- A malformed line appended directly to one project's `events.jsonl` (same
  `fs.appendFileSync(eventsPath(dir), 'not json\n')` trick as the existing
  single-project test) does not fail the no-`project`-param request — still
  `200`, the other project's well-formed data intact.
- Two consecutive `GET /api/stats` (no `project` param) calls, with a task
  mutation to one project's task in between, return different `tasks`
  content on the second call — no caching in aggregate mode either.
- `GET /app.js` (served statically) contains `'stats-icon-btn'` and
  `initialTab === 'stats'` — mechanical proof the card shortcut and its
  tab-selection branch shipped in the served script, consistent with how
  `GET /` is already checked for the Stats tab's static markup below.
- Existing `'GET / serves index.html containing the Stats tab and panel
  markup'` test gains two more assertions: `id="stats-col-project"` is not
  a real id (it's a class) — instead assert `class="stats-col-project"`
  appears in the body, and that the task table's header row includes
  `data-sort="project"`.

## Expected Results

- [ ] Every project card on the home dashboard renders a stats icon button (`.stats-icon-btn`) inside its title, separate from the card's own click target; verifiable by fetching `GET /app.js` and finding both the `stats-icon-btn` class and its `onclick` handler invoking `showProjectView(..., true, 'stats')` with `event.stopPropagation()`.
- [ ] `showProjectView`'s default third argument is `'board'`, so the existing card-body click, `handleUrlRouting`, and `popstate` navigation all continue to land on the Board tab unchanged; only a call with `'stats'` opens on the Stats tab.
- [ ] `GET /api/stats` with no `project` query parameter returns HTTP 200 (not 400) with a workspace-wide aggregate whose `tasks` are keyed per (project, task), each entry carrying `task` (bare id) and `project: {path, name}`.
- [ ] `GET /api/stats?project=` (present but blank) still returns HTTP 400 — only the param's complete absence triggers the workspace-wide path.
- [ ] `GET /api/stats?project=<path>` returns the exact same shape as before this task (`tasks` keyed by bare task id, no `project` field on entries, same `errors` semantics) — regression-safe.
- [ ] For a workspace with two or more registered projects, each seeded with a task via the real task API, `GET /api/stats` (no `project` param) includes both projects' tasks and its `stages.<name>` aggregates (`avgMs`, `maxMs`, `topByTime`, `avgTokens`, `maxTokens`, `topByTokens`) reflect combined data from every project, not just one; `topByTime`/`topByTokens` entries identify which project each outlier belongs to.
- [ ] A registered project with no `.meridian/events.jsonl` contributes nothing to the workspace aggregate's `tasks`/`stages` and produces no entry in `errors`.
- [ ] A malformed line in any one registered project's `events.jsonl` does not fail a no-`project`-param `GET /api/stats` request — still HTTP 200, other projects' well-formed data intact.
- [ ] A registered project whose `events.jsonl` cannot be read (e.g. it is a directory, not a file) produces one entry in the workspace aggregate's `errors` array without failing the request or omitting other registered projects' data.
- [ ] Two consecutive no-`project`-param `GET /api/stats` calls, with a task mutation to any registered project in between, return different `tasks` content on the second call — proof of no caching in the workspace-aggregate path.
- [ ] `lib/stats.js` exports `aggregateWorkspaceStats(projectEntries, now)`, `computeWorkspaceStats(workspaceDir, now)`, and `listRegisteredProjects(workspaceDir)`, in addition to its pre-existing exports; `aggregateStats`'s own return shape and every pre-existing `test/stats.test.js` assertion on it are unchanged.
- [ ] `server.js`'s `/api/stats` route contains no aggregation logic beyond branching on the presence of `project` and calling `computeProjectStats` or `computeWorkspaceStats`.
- [ ] `public/index.html`'s `#stats-task-table` header row includes a `data-sort="project"` `<th class="stats-col-project">`, present unconditionally in the markup (verifiable via `GET /`).
- [ ] Opening the Stats tab from the All Tickets (`/tickets`) view fetches `GET /api/stats` with no `project` parameter (verifiable by reading `loadStats`'s implementation: the request URL branches on `currentProjectViewPath === '__GLOBAL__'`), and `renderStatsPanel` adds the `stats-table--project-hidden` class to `#stats-task-table` only when a single project's data is shown, revealing the Project column for the workspace aggregate.
- [ ] `npm test` (`node --test test/*.test.js`) passes, including the extended `test/stats.test.js` and `test/api-stats.test.js`.

## Out of Scope

- Any change to `lib/routes.js` / `resolveRoute`, or to the URL a project
  view lands on — which tab is active is never encoded in the URL, before
  or after this task; a reload or deep link always opens on Board.
- A stats-first entry point into the All Tickets view (e.g. from the
  header's "All Tickets" button) — only the per-project card icon opens
  directly onto Stats; `showGlobalTicketsView` still defaults to Board.
- Any persistence or caching of computed stats, workspace-wide or
  per-project — every request re-reads and re-aggregates from scratch, per
  MERID-4's hard rule this task extends rather than relaxes.
- Per-dispatch durations derived from `field:"running"` events (already out
  of scope per MERID-4).
- A chart/graph library or any visual treatment beyond plain HTML tables.
- Automated browser/DOM testing of `public/app.js`'s rendering — this
  codebase has no DOM test runner; frontend correctness for dynamically
  generated markup (the card icon, the Project column) is verified via
  served-file content checks and code review, consistent with MERID-4's own
  precedent.
