# MERID-4 — Stats panel on the board fed by GET /api/stats aggregating events.jsonl on demand

## Scope

Adds a read-only statistics view over the raw event log MERID-3 writes to
`<project>/.meridian/events.jsonl`:

1. A new endpoint, `GET /api/stats?project=<absolute path>`, that reads that
   project's `events.jsonl` **fresh on every request** and aggregates it in
   memory. No caching, no persisted aggregate file, no in-process memoization
   — this codebase's hard rule that task data is never cached applies here
   too.
2. A new `lib/stats.js` module holding the aggregation as pure functions
   (`aggregateStats(events, now)`) plus the one I/O function that reads the
   file (`computeProjectStats(projectPath, now)`). `server.js` only wires the
   route; no aggregation logic lives there.
3. A "Stats" tab on the per-project board (`public/index.html` /
   `public/app.js` / `public/styles.css`) that fetches `/api/stats` on open
   and on a manual refresh button, and renders a per-task table plus a
   per-stage summary table.

Out of scope (see `## Out of Scope` for the full list): dispatch *durations*
derived from `running` events, a cross-project/board-wide stats aggregate,
any persistence of computed stats, and any change to what MERID-3 writes to
`events.jsonl`.

## Approach

### 1. `lib/stats.js` — pure aggregation

New module, same conventions as `lib/board.js` / `lib/events.js`
(`'use strict'`, `node:`-prefixed requires, 4-space indent, CommonJS export).
Two responsibilities, cleanly separated so tests can feed arrays directly to
the pure part:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOP_N = 5;

// Reads <projectPath>/.meridian/events.jsonl, JSON.parse-ing one event per
// line. A missing file returns []. A line that fails to parse is skipped —
// this is the "unknown/malformed lines never fatal" contract; nothing here
// throws for a corrupt file, it just contributes fewer events.
function readEventLines(projectPath) {
    const file = path.join(projectPath, '.meridian', 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            events.push(JSON.parse(trimmed));
        } catch (err) {
            // malformed line: skip, never fatal
        }
    }
    return events;
}

function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
}

// Pure aggregation over already-parsed event objects — the two shapes
// MERID-3 writes:
//   {task, field:"status", from, to, at}
//   {task, type:"dispatch_tokens", agent?, output_tokens, context_tokens, at}
// A `field:"running"` event, or anything else with a recognisable `task`/`at`
// but neither a usable `field` nor `type`, is accepted as input without
// throwing and simply ignored by this aggregation (running-derived dispatch
// durations are out of scope — see below). Anything missing `task` or a
// parseable `at` is skipped outright.
//
// `now` is injectable so tests get deterministic "ongoing" durations instead
// of a real wall-clock race.
function aggregateStats(events, now = new Date()) {
    const statusByTask = new Map();
    const dispatchByTask = new Map();

    for (const ev of events || []) {
        if (!ev || typeof ev !== 'object') continue;
        if (typeof ev.task !== 'string' || !ev.task) continue;
        const at = new Date(ev.at);
        if (!isValidDate(at)) continue;

        if (ev.field === 'status') {
            if (typeof ev.to !== 'string' || !ev.to) continue;
            if (!statusByTask.has(ev.task)) statusByTask.set(ev.task, []);
            statusByTask.get(ev.task).push({ to: ev.to, at });
        } else if (ev.type === 'dispatch_tokens') {
            if (typeof ev.output_tokens !== 'number' || !Number.isFinite(ev.output_tokens)) continue;
            if (typeof ev.context_tokens !== 'number' || !Number.isFinite(ev.context_tokens)) continue;
            if (!dispatchByTask.has(ev.task)) dispatchByTask.set(ev.task, []);
            dispatchByTask.get(ev.task).push({
                output_tokens: ev.output_tokens,
                context_tokens: ev.context_tokens,
                at
            });
        }
        // field:"running" and anything else: not used by this aggregation.
    }

    const tasks = {};
    const stageTimeEntries = new Map();   // stage -> [{task, ms, ongoing}]
    const stageTokenEntries = new Map();  // stage -> [{task, tokens, maxContextTokens}]

    for (const [taskId, rawEvents] of statusByTask) {
        // Sort chronologically. Duration is derived purely from consecutive
        // `to`/`at` pairs — `from` is never trusted for the math, only used
        // by the caller for display elsewhere.
        const sorted = [...rawEvents].sort((a, b) => a.at - b.at);
        const intervals = sorted.map((e, i) => ({
            stage: e.to,
            start: e.at,
            end: i + 1 < sorted.length ? sorted[i + 1].at : now,
            ongoing: i + 1 >= sorted.length
        }));

        const stages = {};
        for (const iv of intervals) {
            const ms = Math.max(0, iv.end.getTime() - iv.start.getTime());
            if (!stages[iv.stage]) stages[iv.stage] = { totalMs: 0, visits: 0, ongoing: false };
            stages[iv.stage].totalMs += ms;
            stages[iv.stage].visits += 1;
            // A later, closed visit to the same stage must not un-flag an
            // ongoing one — only the interval that is actually last (by
            // construction, ongoing is only ever true for the last interval)
            // sets this, so plain assignment (not OR) is fine here.
            if (iv.ongoing) stages[iv.stage].ongoing = true;
        }

        // Attribute each dispatch_tokens event to the stage the task was in
        // at that timestamp — the interval whose start is the latest one
        // not after the dispatch's `at`. A dispatch timestamped before the
        // task's first known status event (clock skew, or the ledger
        // predating the earliest retained status event) is clamped to the
        // first interval rather than dropped.
        const dispatches = dispatchByTask.get(taskId) || [];
        let dispatchCount = 0, totalOutputTokens = 0, maxContextTokens = 0;
        const stageTokenAcc = {};

        for (const d of dispatches) {
            dispatchCount += 1;
            totalOutputTokens += d.output_tokens;
            if (d.context_tokens > maxContextTokens) maxContextTokens = d.context_tokens;

            let stage = 'unknown';
            if (intervals.length > 0) {
                let match = intervals[0];
                for (const iv of intervals) {
                    if (iv.start.getTime() <= d.at.getTime()) match = iv;
                    else break; // intervals are ascending by start
                }
                stage = match.stage;
            }
            if (!stageTokenAcc[stage]) stageTokenAcc[stage] = { totalOutputTokens: 0, maxContextTokens: 0 };
            stageTokenAcc[stage].totalOutputTokens += d.output_tokens;
            if (d.context_tokens > stageTokenAcc[stage].maxContextTokens) {
                stageTokenAcc[stage].maxContextTokens = d.context_tokens;
            }
        }

        tasks[taskId] = {
            stages,
            dispatches: { count: dispatchCount, totalOutputTokens, maxContextTokens }
        };

        for (const [stage, s] of Object.entries(stages)) {
            if (!stageTimeEntries.has(stage)) stageTimeEntries.set(stage, []);
            stageTimeEntries.get(stage).push({ task: taskId, ms: s.totalMs, ongoing: s.ongoing });
        }
        for (const [stage, tk] of Object.entries(stageTokenAcc)) {
            if (!stageTokenEntries.has(stage)) stageTokenEntries.set(stage, []);
            stageTokenEntries.get(stage).push({
                task: taskId, tokens: tk.totalOutputTokens, maxContextTokens: tk.maxContextTokens
            });
        }
    }

    // A dispatch_tokens event can reference a task id with no status event at
    // all in this file (e.g. the task predates events.jsonl, or was created
    // in another way). MERID-3 tolerates that on write; this must tolerate
    // it on read too — surface the dispatch totals with no stage breakdown
    // instead of silently dropping the task.
    for (const [taskId, dispatches] of dispatchByTask) {
        if (tasks[taskId]) continue;
        let dispatchCount = 0, totalOutputTokens = 0, maxContextTokens = 0;
        for (const d of dispatches) {
            dispatchCount += 1;
            totalOutputTokens += d.output_tokens;
            if (d.context_tokens > maxContextTokens) maxContextTokens = d.context_tokens;
        }
        tasks[taskId] = { stages: {}, dispatches: { count: dispatchCount, totalOutputTokens, maxContextTokens } };
        if (!stageTokenEntries.has('unknown')) stageTokenEntries.set('unknown', []);
        stageTokenEntries.get('unknown').push({ task: taskId, tokens: totalOutputTokens, maxContextTokens });
    }

    const stages = {};
    const allStageNames = new Set([...stageTimeEntries.keys(), ...stageTokenEntries.keys()]);
    for (const stage of allStageNames) {
        const timeEntries = stageTimeEntries.get(stage) || [];
        const tokenEntries = stageTokenEntries.get(stage) || [];

        const avgMs = timeEntries.length
            ? timeEntries.reduce((s, e) => s + e.ms, 0) / timeEntries.length : 0;
        const maxMs = timeEntries.length ? Math.max(...timeEntries.map(e => e.ms)) : 0;
        const avgTokens = tokenEntries.length
            ? tokenEntries.reduce((s, e) => s + e.tokens, 0) / tokenEntries.length : 0;
        const maxTokens = tokenEntries.length ? Math.max(...tokenEntries.map(e => e.tokens)) : 0;

        stages[stage] = {
            taskCount: timeEntries.length,
            avgMs, maxMs,
            topByTime: [...timeEntries].sort((a, b) => b.ms - a.ms).slice(0, TOP_N),
            avgTokens, maxTokens,
            topByTokens: [...tokenEntries].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N)
        };
    }

    return { tasks, stages };
}

// The only function that touches the filesystem. server.js calls this, and
// only this, per request — never a cached copy.
function computeProjectStats(projectPath, now = new Date()) {
    const events = readEventLines(projectPath);
    return aggregateStats(events, now);
}

module.exports = { aggregateStats, computeProjectStats, readEventLines, TOP_N };
```

Notes on the design, so the "per stage ... by time and by tokens" outlier
requirement is unambiguous:

- **Stage attribution of tokens is derived, not stored.** `dispatch_tokens`
  events carry no stage/status field (MERID-3 didn't add one). This module
  derives it from the enclosing status interval by comparing the dispatch's
  `at` to the task's own status-interval boundaries, built from the same
  status events already needed for stage durations. This is the only way to
  produce a *per-stage* token outlier list from what MERID-3 actually wrote,
  and it costs nothing extra since the intervals are already computed.
- **`stages['unknown']`** collects dispatches that cannot be placed in a real
  interval (task has dispatch events but no status events at all). It behaves
  like any other stage bucket in the response — same shape, same top-N logic
  — the board only needs to render whatever stage keys are present.
- Durations are in **milliseconds**, unrounded; formatting is a display
  concern for `public/app.js`, not this module.
- `TOP_N = 5` is exported so tests and the UI never hardcode the count in two
  places if it needs to change later.

### 2. `server.js` — wiring only

```js
const { computeProjectStats } = require('./lib/stats');
```

New route, placed next to `/api/status`:

```js
// REST API: on-demand stats aggregated from events.jsonl. Never cached —
// every request re-reads and re-aggregates the file from scratch.
app.get('/api/stats', (req, res) => {
    const projectPath = req.query.project;
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

`isRegisteredProject` already exists in `server.js` (added by MERID-3 for
`POST /api/projects/events`); this reuses it rather than re-implementing the
registry lookup. It is defined later in the file as a `function` declaration,
so it is hoisted and callable from a route registered earlier in file order —
place the new route directly after `app.get('/api/status', ...)` for
readability, no reordering needed.

**Response shape decisions, both deliberate:**

- **Unregistered project → HTTP 200** with the error folded into an `errors`
  array, exactly mirroring how `getStatusData()` / `GET /api/status` reports
  an unregistered `project` query param (it never 404s or 400s for that
  case) — this is the "same not-registered error shape /api/status uses"
  the task calls for, shape *and* status code both.
- **Missing/blank `project` query param → HTTP 400** `{ error: 'project is
  required' }`. This is a different case from `/api/status`'s bare `GET
  /api/status` (which reports *every* project): `/api/stats` has no
  board-wide meaning to fall back to — reading and aggregating every
  registered project's `events.jsonl` on a single request is explicitly out
  of scope (see below) — so a missing `project` is a plain client error, not
  an empty-but-valid result.
- **Registered project with no `events.jsonl` yet → HTTP 200**, `tasks: {}`,
  `stages: {}`, `errors: []`. `readEventLines` already returns `[]` for a
  missing file, and `aggregateStats([])` returns `{tasks:{}, stages:{}}` —
  no special-casing needed in the route.

### 3. Frontend — `public/index.html`, `public/app.js`, `public/styles.css`

**`index.html`** — inside `#project-view`, replace the existing
`#running-tickets-section` + `#kanban-board` block (leave both elements'
existing markup untouched, just wrap them and add siblings):

```html
<div class="view-tabs" id="project-view-tabs">
    <button type="button" id="tab-board-btn" class="view-tab view-tab--active" data-tab="board">Board</button>
    <button type="button" id="tab-stats-btn" class="view-tab" data-tab="stats">Stats 📊</button>
</div>

<div id="board-panel">
    <div id="running-tickets-section" class="running-tickets-section hidden">
        <!-- unchanged -->
    </div>
    <div class="kanban-board" id="kanban-board">
        <!-- unchanged -->
    </div>
</div>

<div id="stats-panel" class="stats-panel hidden">
    <div class="stats-toolbar">
        <h3>Task Stats</h3>
        <button type="button" id="stats-refresh-btn" class="secondary-btn">Refresh</button>
    </div>
    <div id="stats-loading" class="stats-loading hidden">Loading stats…</div>
    <div id="stats-error" class="stats-error hidden"></div>
    <div id="stats-content" class="hidden">
        <table class="stats-table" id="stats-stage-table">
            <thead>
                <tr><th>Stage</th><th>Tasks</th><th>Avg time</th><th>Max time</th><th>Avg tokens</th><th>Max tokens</th></tr>
            </thead>
            <tbody id="stats-stage-tbody"></tbody>
        </table>
        <table class="stats-table" id="stats-task-table">
            <thead>
                <tr>
                    <th data-sort="task">Task</th>
                    <th data-sort="stage">Stage</th>
                    <th data-sort="ms">Time in stage</th>
                    <th data-sort="dispatches">Dispatches</th>
                    <th data-sort="outputTokens">Output tokens</th>
                    <th data-sort="maxContextTokens">Max context tokens</th>
                </tr>
            </thead>
            <tbody id="stats-task-tbody"></tbody>
        </table>
    </div>
</div>
```

The Stats tab button is only ever shown for a real project — hide it
(`display:none` via a `hidden` class, same pattern already used for
`btnEdit`/`addTaskForm`) whenever `currentProjectViewPath === '__GLOBAL__'`,
since `/api/stats` takes exactly one project path and a board-wide aggregate
is out of scope.

**`app.js`** additions (near the other `#project-view` wiring, alongside
`refreshProjectView`):

```js
const tabBoardBtn = document.getElementById('tab-board-btn');
const tabStatsBtn = document.getElementById('tab-stats-btn');
const boardPanel = document.getElementById('board-panel');
const statsPanel = document.getElementById('stats-panel');

function showBoardTab() {
    tabBoardBtn.classList.add('view-tab--active');
    tabStatsBtn.classList.remove('view-tab--active');
    boardPanel.classList.remove('hidden');
    statsPanel.classList.add('hidden');
}

function showStatsTab() {
    tabBoardBtn.classList.remove('view-tab--active');
    tabStatsBtn.classList.add('view-tab--active');
    boardPanel.classList.add('hidden');
    statsPanel.classList.remove('hidden');
    loadStats();
}

tabBoardBtn.addEventListener('click', showBoardTab);
tabStatsBtn.addEventListener('click', showStatsTab);

document.getElementById('stats-refresh-btn').addEventListener('click', loadStats);

// Client-side sort state for the already-fetched rows only — never a
// substitute for re-fetching. Every open of the Stats tab and every click of
// Refresh calls loadStats(), which replaces lastStatsData wholesale; sorting
// only ever re-renders what the most recent fetch returned.
let lastStatsData = null;
let statsSort = { key: 'ms', dir: 'desc' };

async function loadStats() {
    if (!currentProjectViewPath || currentProjectViewPath === '__GLOBAL__') return;
    const loading = document.getElementById('stats-loading');
    const errorBox = document.getElementById('stats-error');
    const content = document.getElementById('stats-content');
    loading.classList.remove('hidden');
    errorBox.classList.add('hidden');
    content.classList.add('hidden');
    lastStatsData = null;
    try {
        const res = await fetch(`/api/stats?project=${encodeURIComponent(currentProjectViewPath)}`);
        const data = await res.json();
        loading.classList.add('hidden');
        if (data.errors && data.errors.length > 0) {
            errorBox.textContent = data.errors.map(e => e.message).join('; ');
            errorBox.classList.remove('hidden');
            return;
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

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
}

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

    // Flatten tasks x stages into one row per (task, stage) so outliers sort
    // to the top regardless of which task or stage they belong to.
    let rows = [];
    for (const [taskId, t] of Object.entries(data.tasks)) {
        const stageNamesForTask = Object.keys(t.stages);
        if (stageNamesForTask.length === 0) {
            rows.push({
                task: taskId, stage: '(no status events)', ms: 0, ongoing: false,
                dispatches: t.dispatches.count,
                outputTokens: t.dispatches.totalOutputTokens,
                maxContextTokens: t.dispatches.maxContextTokens
            });
            continue;
        }
        for (const stageName of stageNamesForTask) {
            const s = t.stages[stageName];
            rows.push({
                task: taskId, stage: stageName, ms: s.totalMs, ongoing: s.ongoing,
                dispatches: t.dispatches.count,
                outputTokens: t.dispatches.totalOutputTokens,
                maxContextTokens: t.dispatches.maxContextTokens
            });
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
        <td>${r.stage}${r.ongoing ? ' <span class="stats-ongoing-badge">ongoing</span>' : ''}</td>
        <td>${formatDuration(r.ms)}</td>
        <td>${r.dispatches}</td>
        <td>${r.outputTokens.toLocaleString()}</td>
        <td>${r.maxContextTokens.toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="6">No task data yet.</td></tr>';
}

document.querySelectorAll('#stats-task-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (statsSort.key === key) {
            statsSort.dir = statsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            statsSort = { key, dir: 'desc' };
        }
        if (lastStatsData) renderStatsPanel(lastStatsData);
    });
});
```

Reset to the Board tab whenever a new project (or the global view) is
entered, so a stale Stats view is never left showing for the wrong project —
add `showBoardTab();` as the first line of `showProjectView` and
`showGlobalTicketsView`, and toggle `tabStatsBtn`'s own visibility there too:

```js
tabStatsBtn.classList.toggle('hidden', currentProjectViewPath === '__GLOBAL__');
```

**`styles.css`** additions (near `.status-summary-bar` / `.summary-card`,
reusing the existing dark-card look):

```css
.view-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
}
.view-tab {
    background: transparent;
    border: 1px solid var(--card-border);
    color: var(--text-secondary);
    padding: 0.5rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
}
.view-tab--active {
    border-color: var(--accent);
    color: #fff;
    background: rgba(99, 102, 241, 0.15);
}
.stats-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
}
.stats-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 10px;
    overflow: hidden;
}
.stats-table th, .stats-table td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--card-border);
    font-size: 0.85rem;
}
.stats-table th[data-sort] {
    cursor: pointer;
    color: var(--text-secondary);
    user-select: none;
}
.stats-ongoing-badge {
    font-size: 0.7rem;
    color: #818cf8;
    background: rgba(99, 102, 241, 0.2);
    padding: 0.1rem 0.4rem;
    border-radius: 6px;
}
.stats-error {
    color: #fca5a5;
}
```

Increment the cache-busting query strings on `styles.css?v=` and
`app.js?v=` in `index.html` (currently `24` and `36`) so the browser doesn't
serve a stale copy — matches the existing convention every markup/script
change in this file already follows.

## Testing

Follow `test/api-tasks.test.js` / `test/api-events.test.js`'s
`workspaceWith`/`withServer` fixtures for everything server-side — a temp
workspace, temp project, spawned `server.js` via `MERIDIAN_RUNNING_DIR`.
Never touch the real board or the checkout's own `.meridian/`.

- **`test/stats.test.js`** (new) — unit tests for `lib/stats.js`'s pure
  `aggregateStats(events, now)`, feeding plain arrays of event objects
  directly (no filesystem):
  - a single task with `{from:null,to:"backlog",at:T0}` then
    `{from:"backlog",to:"in_progress",at:T1}`, aggregated with `now=T2`:
    `tasks["X"].stages.backlog = {totalMs: T1-T0, visits:1, ongoing:false}`,
    `tasks["X"].stages.in_progress = {totalMs: T2-T1, visits:1, ongoing:true}`.
  - two separate visits to the same stage (`backlog` → `in_progress` →
    `backlog` → `done`) sum into one `stages.backlog.totalMs` covering both
    visits, with `visits: 2`.
  - `dispatch_tokens` events for a task sum into
    `tasks["X"].dispatches = {count, totalOutputTokens, maxContextTokens}`
    (`maxContextTokens` is a max, not a sum — assert with three dispatches of
    different `context_tokens`).
  - a dispatch_tokens event timestamped inside a given status interval is
    attributed to that stage's `topByTokens`/token totals in the board-wide
    `stages` map; one timestamped inside a different interval for the same
    task is attributed to the other stage — assert both stages carry the
    correct, non-overlapping token totals.
  - a dispatch_tokens event for a task with no status events at all still
    appears in `tasks` with `stages: {}` and correct dispatch totals, and
    contributes to `stages.unknown`.
  - board-wide `stages.<name>.avgMs`/`maxMs`/`topByTime` computed correctly
    across three tasks with different totals in the same stage; `topByTime`
    length capped at `TOP_N` when more than `TOP_N` tasks visited a stage.
  - a malformed event (missing `task`, missing/unparseable `at`, `field:
    "status"` with no `to`, `type:"dispatch_tokens"` with a non-numeric
    `output_tokens`) is silently skipped — does not throw, does not appear in
    the output, and does not corrupt aggregation of the well-formed events
    surrounding it in the same array.
  - a `field: "running"` event and an event with neither `field` nor `type`
    are accepted without throwing and contribute nothing.
  - `aggregateStats([])` returns `{tasks: {}, stages: {}}`.
  - `readEventLines` (separate, filesystem-backed tests with
    `fs.mkdtempSync`): a missing `events.jsonl` returns `[]`; a file with one
    malformed line among well-formed ones returns only the well-formed ones
    parsed; two-line file returns both in order.

- **`test/api-stats.test.js`** (new) — server integration:
  - `GET /api/stats` with no `project` query param returns `400`.
  - `GET /api/stats?project=<unregistered path>` returns `200` with
    `tasks: {}`, `stages: {}`, and `errors[0].message` matching
    `/not registered/i` — same shape `GET /api/status` uses for the same
    condition.
  - `GET /api/stats?project=<registered, no events.jsonl yet>` returns `200`
    with `tasks: {}`, `stages: {}`, `errors: []`.
  - Seed a project via the real API (`POST /api/projects/tasks`, `PUT
    .../tasks/:id`) so `events.jsonl` gets real status-change lines, then
    `GET /api/stats?project=<dir>` and assert the returned task's stage
    durations are consistent with the timestamps the server itself stamped
    (`created_at`/`moved_at` read back from the task) — a coarse
    `duration >= 0` and stage-key-presence check is enough here; the exact
    arithmetic is already covered by the `lib/stats.js` unit tests.
  - `POST /api/projects/events` a `dispatch_tokens` event for a seeded task,
    then `GET /api/stats?project=<dir>` and assert
    `tasks[id].dispatches.count === 1` and the token fields match.
  - Append one clearly malformed line (`fs.appendFileSync(eventsPath,
    'not json\n')`) directly to `events.jsonl` alongside well-formed lines
    written by the API above, then assert `GET /api/stats` still returns
    `200` with the well-formed data intact — the malformed line does not
    fail the request.
  - Two consecutive `GET /api/stats` calls with a task mutation (e.g. another
    `PUT` changing status) in between return different `tasks[id].stages`
    contents — proof the endpoint re-reads and re-aggregates rather than
    caching a first response.

- **Extend the existing SPA-fallback test** (`test/api-tasks.test.js`'s "GET
  /<slug> and GET /tickets serve index.html") or add a small new assertion:
  fetch `/` and assert the body includes `id="tab-stats-btn"`,
  `id="stats-panel"`, `id="stats-stage-tbody"`, and `id="stats-task-tbody"` —
  a mechanical, file-content check that the markup shipped, since there is no
  browser/DOM test runner in this project (consistent with how `lib/board.js`
  /`lib/routes.js` are unit-tested while their `app.js` counterparts are not
  executed under test).

## Expected Results

- [ ] `GET /api/stats` with no `project` query parameter returns HTTP 400 with `{ "error": "project is required" }` (or equivalent message).
- [ ] `GET /api/stats?project=<path not in projects.json>` returns HTTP 200 with `tasks: {}`, `stages: {}`, and an `errors` array whose message matches `/not registered/i`, mirroring `GET /api/status`'s shape for an unregistered project.
- [ ] `GET /api/stats?project=<registered project with no events.jsonl>` returns HTTP 200 with `tasks: {}`, `stages: {}`, `errors: []`.
- [ ] For a project whose `events.jsonl` records a task entering `backlog` then `in_progress`, `GET /api/stats?project=<path>` returns that task's `tasks[id].stages.backlog` and `.in_progress` each with a non-negative `totalMs`, and the still-current status flagged `ongoing: true`.
- [ ] A task's time in a stage visited more than once (e.g. `backlog` → `in_progress` → `backlog`) is summed across both visits into one `stages.backlog.totalMs`, not overwritten by the later visit.
- [ ] `dispatch_tokens` events for a task are reflected in `tasks[id].dispatches` as `count` (number of events), `totalOutputTokens` (sum of `output_tokens`), and `maxContextTokens` (max, not sum, of `context_tokens`).
- [ ] The board-wide `stages.<name>` object exposes `avgMs`, `maxMs`, and a `topByTime` list (capped at 5 entries) of the tasks with the most time in that stage, plus `avgTokens`, `maxTokens`, and a `topByTokens` list (capped at 5) of the tasks with the most dispatch tokens attributed to that stage.
- [ ] A malformed or unrecognized line in `events.jsonl` (invalid JSON, missing `task`, a `status` event with no `to`, a `dispatch_tokens` event with non-numeric `output_tokens`) does not fail the `GET /api/stats` request — the response is still HTTP 200 and includes every well-formed line's data.
- [ ] Two `GET /api/stats?project=<path>` calls, with a task mutation via the API in between, return different data on the second call — proof the endpoint re-reads and re-aggregates `events.jsonl` per request rather than caching.
- [ ] `lib/stats.js` exports `aggregateStats(events, now)`, `computeProjectStats(projectPath, now)`, `readEventLines(projectPath)`, and `TOP_N`; `server.js`'s `/api/stats` route contains no aggregation logic of its own beyond calling `computeProjectStats` and shaping the JSON response.
- [ ] `public/index.html` contains a Stats tab and panel (`id="tab-stats-btn"`, `id="stats-panel"`, `id="stats-stage-tbody"`, `id="stats-task-tbody"`), verifiable by fetching `/` and checking the served HTML.
- [ ] `public/app.js` fetches `GET /api/stats?project=...` when the Stats tab is opened and again when its refresh button is clicked, and never renders a previous response without first issuing a fresh fetch (verifiable by reading `loadStats`'s implementation: it is the only place `lastStatsData` is assigned a fetched value, and it is called from both the tab-open and refresh-button handlers).
- [ ] `npm test` (`node --test test/*.test.js`) passes, including the new `test/stats.test.js` and `test/api-stats.test.js`.

## Out of Scope

- Per-dispatch **durations** derived from `field:"running"` events (start/stop
  timing of an individual dispatch). MERID-3's design note calls this
  optional ("if cheap to include"); the required deliverables are stage
  durations and token sums, both fully covered above. `running` events are
  parsed-tolerant (never crash aggregation) but otherwise unused.
- A board-wide or cross-project aggregate (e.g. "stats across every
  registered project in one call"). The endpoint is scoped to exactly one
  `project` per the task's own signature.
- Persisting computed stats anywhere (file, memory cache, `tasks.json`
  field). Every request recomputes from `events.jsonl` from scratch.
- Any change to what MERID-3 writes to `events.jsonl` or to the
  `POST /api/projects/events` endpoint.
- A chart/graph library or any visual treatment beyond plain HTML tables and
  numbers.
- Automated browser/DOM testing of `public/app.js`'s rendering — this
  codebase has no DOM test runner; frontend correctness here is verified via
  the markup-presence test and code review, consistent with how `app.js`'s
  other duplicated-logic counterparts (`lib/board.js`, `lib/routes.js`) are
  the only side that's unit-tested.
