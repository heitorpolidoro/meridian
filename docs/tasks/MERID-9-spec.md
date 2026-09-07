# MERID-9 — Stats stage table: replace task count column with the agent that consumed the tokens

## Scope

Elaborates the operator-approved design (see task description) on top of
MERID-4/MERID-7's shipped `lib/stats.js` + Stats tab:

1. `lib/stats.js`'s per-stage aggregate (`stages.<name>`) gains an `agents`
   array — the agent(s) whose `dispatch_tokens` events were attributed to
   that stage, each with a token total and dispatch count, sorted by tokens
   descending. Pure-function change, both the single-project (`aggregateStats`)
   and workspace-wide (`aggregateWorkspaceStats`) paths get it, because both
   already share `aggregateTaskStats` / `shapeStages`.
2. The per-stage Stats table — shared markup between the per-project Stats
   tab and the All Tickets (workspace) Stats tab, per MERID-7 — drops its
   **Tasks** column and shows an **Agent** column instead, rendering the
   dominant agent plus a compact "+N" count when a stage saw dispatches from
   more than one agent, with a `title` attribute listing every agent's token
   total. A stage with no dispatch tokens at all shows a neutral placeholder
   (`—`).
3. Display strips the `meridian:` plugin-namespace prefix from an agent name
   (e.g. `meridian:developer` → `developer`) — every agent this codebase
   dispatches through the plugin carries that prefix, so it is redundant in
   a table this narrow. An event whose `agent` field is absent groups under
   a `null` key and displays as `(no agent)`. The neutral placeholder (`—`)
   is reserved for the case where the stage has **zero** dispatch tokens
   attributed to it at all — a stage whose only contributor is the
   `null`/no-agent group still renders `(no agent)`, not the placeholder;
   see `## Approach` §2 for the precise rule.
4. **Response shape decision (explicit):** `stages.<name>.taskCount` is
   **kept** in the API response — nothing reads or removes it server-side;
   only the frontend stops rendering it in the stage table. Adding
   `stages.<name>.agents` is purely additive; no existing field changes
   shape or is removed from `GET /api/stats`.

Out of scope: any change to what `POST /api/projects/events` accepts or
writes (the `agent` field already exists per MERID-3), any change to the
per-task table (its own `Dispatches`/`Output tokens`/`Max context tokens`
columns are untouched), attributing individual `topByTime`/`topByTokens`
entries to an agent, charts/graphs, and browser/DOM test automation (no such
runner exists in this codebase — consistent with MERID-4/MERID-7's own
precedent).

## Approach

### 1. `lib/stats.js` — per-stage `agents` aggregate

**Event parsing** (inside `aggregateTaskStats`, the `dispatch_tokens` branch
of the initial event loop): carry `agent` through onto each parsed dispatch,
normalized to a `string` or `null` (never `undefined`, so later `Map` keys
are stable):

```js
} else if (ev.type === 'dispatch_tokens') {
    if (typeof ev.output_tokens !== 'number' || !Number.isFinite(ev.output_tokens)) continue;
    if (typeof ev.context_tokens !== 'number' || !Number.isFinite(ev.context_tokens)) continue;
    if (!dispatchByTask.has(ev.task)) dispatchByTask.set(ev.task, []);
    dispatchByTask.get(ev.task).push({
        output_tokens: ev.output_tokens,
        context_tokens: ev.context_tokens,
        agent: typeof ev.agent === 'string' && ev.agent ? ev.agent : null,
        at
    });
}
```

**New entry map**, declared alongside `stageTimeEntries` / `stageTokenEntries`:

```js
const stageAgentEntries = new Map();  // stage -> [{task, agent, tokens}]
```

One entry per individual `dispatch_tokens` event (not pre-summed per task),
so `shapeStages` can both sum tokens **and** count dispatches per agent.
Pushed in the same two places `stageTokenEntries` already is:

- **Per-task loop**, inside `for (const d of dispatches)`, right after the
  existing `stageTokenAcc[stage]` update:

  ```js
  if (!stageAgentEntries.has(stage)) stageAgentEntries.set(stage, []);
  stageAgentEntries.get(stage).push({ task: taskId, agent: d.agent, tokens: d.output_tokens });
  ```

- **Second loop** (tasks with `dispatch_tokens` events but no status events
  at all — attributed to `'unknown'`), inside its own `for (const d of
  dispatches)`:

  ```js
  if (!stageAgentEntries.has('unknown')) stageAgentEntries.set('unknown', []);
  stageAgentEntries.get('unknown').push({ task: taskId, agent: d.agent, tokens: d.output_tokens });
  ```

`aggregateTaskStats` returns `{ tasks, stageTimeEntries, stageTokenEntries,
stageAgentEntries }`.

**`shapeStages`** gains a third parameter and rolls per-dispatch agent
entries up into one row per distinct agent, sorted by tokens descending —
`agents[0]` is always the stage's dominant agent by output tokens:

```js
function shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries) {
    const stages = {};
    const allStageNames = new Set([
        ...stageTimeEntries.keys(), ...stageTokenEntries.keys(), ...stageAgentEntries.keys()
    ]);
    for (const stage of allStageNames) {
        const timeEntries = stageTimeEntries.get(stage) || [];
        const tokenEntries = stageTokenEntries.get(stage) || [];
        const agentEntries = stageAgentEntries.get(stage) || [];

        const avgMs = timeEntries.length
            ? timeEntries.reduce((s, e) => s + e.ms, 0) / timeEntries.length : 0;
        const maxMs = timeEntries.length ? Math.max(...timeEntries.map(e => e.ms)) : 0;
        const avgTokens = tokenEntries.length
            ? tokenEntries.reduce((s, e) => s + e.tokens, 0) / tokenEntries.length : 0;
        const maxTokens = tokenEntries.length ? Math.max(...tokenEntries.map(e => e.tokens)) : 0;

        // One row per distinct agent (a dispatch_tokens event with no
        // `agent` field groups under the `null` key rather than being
        // dropped), sorted so the dominant agent is always index 0.
        const agentTotals = new Map();
        for (const e of agentEntries) {
            if (!agentTotals.has(e.agent)) agentTotals.set(e.agent, { totalOutputTokens: 0, dispatches: 0 });
            const acc = agentTotals.get(e.agent);
            acc.totalOutputTokens += e.tokens;
            acc.dispatches += 1;
        }
        const agents = [...agentTotals.entries()]
            .map(([agent, v]) => ({ agent, totalOutputTokens: v.totalOutputTokens, dispatches: v.dispatches }))
            .sort((a, b) => b.totalOutputTokens - a.totalOutputTokens);

        stages[stage] = {
            taskCount: timeEntries.length,
            avgMs, maxMs,
            topByTime: [...timeEntries].sort((a, b) => b.ms - a.ms).slice(0, TOP_N),
            avgTokens, maxTokens,
            topByTokens: [...tokenEntries].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N),
            agents
        };
    }
    return stages;
}
```

`stages.<name>.taskCount` is unchanged and still present (decision §Scope
point 4) — only `agents` is new.

**`aggregateStats`**:

```js
function aggregateStats(events, now = new Date()) {
    const { tasks, stageTimeEntries, stageTokenEntries, stageAgentEntries } = aggregateTaskStats(events, now);
    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries) };
}
```

**`aggregateWorkspaceStats`** merges the new map across projects exactly the
way it already merges `stageTimeEntries` / `stageTokenEntries` — concatenate
per-project lists, tag each entry with `project` for shape-consistency with
its two siblings even though the UI does not surface it in this task:

```js
function aggregateWorkspaceStats(projectEntries, now = new Date()) {
    const tasks = {};
    const stageTimeEntries = new Map();
    const stageTokenEntries = new Map();
    const stageAgentEntries = new Map();

    for (const entry of projectEntries || []) {
        if (!entry || typeof entry.path !== 'string') continue;
        const project = { path: entry.path, name: entry.name || entry.path };
        const { tasks: projTasks, stageTimeEntries: projTime, stageTokenEntries: projTokens, stageAgentEntries: projAgents }
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
        for (const [stage, list] of projAgents) {
            if (!stageAgentEntries.has(stage)) stageAgentEntries.set(stage, []);
            stageAgentEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
    }

    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries) };
}
```

`computeProjectStats`, `computeWorkspaceStats`, `module.exports` — unchanged.
`server.js`'s `/api/stats` route needs **no edit**: it already just spreads
whatever `computeProjectStats`/`computeWorkspaceStats` return into the JSON
response, so `stages.<name>.agents` flows through automatically.

### 2. Frontend — stage table Agent column

**`public/index.html`** — `#stats-stage-table` header, replace `Tasks` with
`Agent` (column count and `colspan` on the empty-state row stay 6):

```html
<tr><th>Stage</th><th>Agent</th><th>Avg time</th><th>Max time</th><th>Avg tokens</th><th>Max tokens</th></tr>
```

Bump `styles.css?v=` and `app.js?v=` (currently `27` / `38`) to `28` / `39`,
per this repo's existing convention for every markup/script change to this
file.

**`public/app.js`** — two small helpers near `formatDuration`, plus the
stage-row template in `renderStatsPanel`:

```js
// Every agent this codebase dispatches through the plugin is named
// "meridian:<role>" — the prefix is redundant once it's the only kind of
// name shown in this table, so it's stripped for display only (the raw
// value from the API is untouched).
function formatAgentName(agent) {
    if (!agent) return '(no agent)';
    return agent.startsWith('meridian:') ? agent.slice('meridian:'.length) : agent;
}

// `agents` is stages.<name>.agents from the API: already sorted by
// totalOutputTokens desc, one entry per distinct agent (a `null` agent
// groups dispatch_tokens events that carried no `agent` field). An empty
// array means the stage had zero dispatch_tokens attributed to it at all —
// that, and only that, is the placeholder case; a stage whose one and only
// contributor is the `null`/no-agent group still renders "(no agent)", not
// the placeholder. More than one agent renders the dominant one plus a
// compact "+N" suffix, with a title attribute listing every agent's token
// total for the full picture on hover.
function formatStageAgentCell(agents) {
    if (!agents || agents.length === 0) {
        return '<span class="stats-agent-placeholder">—</span>';
    }
    const label = formatAgentName(agents[0].agent);
    const suffix = agents.length > 1 ? ` (+${agents.length - 1})` : '';
    const title = agents
        .map(a => `${formatAgentName(a.agent)}: ${Math.round(a.totalOutputTokens).toLocaleString()} tokens`)
        .join('\n');
    return `<span class="stats-agent-cell" title="${title.replace(/"/g, '&quot;')}">${label}${suffix}</span>`;
}
```

`renderStatsPanel`'s stage-row template — replace the `taskCount` cell:

```js
stageTbody.innerHTML = stageNames.map(name => {
    const s = data.stages[name];
    return `<tr>
        <td>${name}</td>
        <td>${formatStageAgentCell(s.agents)}</td>
        <td>${formatDuration(s.avgMs)}</td>
        <td>${formatDuration(s.maxMs)}</td>
        <td>${Math.round(s.avgTokens).toLocaleString()}</td>
        <td>${Math.round(s.maxTokens).toLocaleString()}</td>
    </tr>`;
}).join('') || '<tr><td colspan="6">No stage data yet.</td></tr>';
```

Nothing else in `renderStatsPanel` changes — the per-task table, its Project
column (MERID-7), and its sort wiring are untouched. This is the one shared
function both the per-project and All Tickets Stats tabs already call
(MERID-7 made `renderStatsPanel` tab-agnostic), so this one edit covers both
surfaces without branching.

**`public/styles.css`** — near `.stats-ongoing-badge`:

```css
.stats-agent-placeholder {
    color: var(--text-secondary);
}
.stats-agent-cell {
    cursor: default;
}
```

No other markup, route, or `showStatsTab`/`loadStats` logic changes — this
task only touches the stage table's data and one column.

## Testing

Follow `test/stats.test.js` / `test/api-stats.test.js`'s existing fixtures.
Never touch the real board or the checkout's own `.meridian/`. Run with
`npm test` (`node --test test/*.test.js` — never `node --test test/`).
Fixtures under `fs.mkdtempSync` in the OS temp dir, as the existing tests
already do.

### `test/stats.test.js` (extend)

- A single task whose `dispatch_tokens` events (attributed to the same
  stage via existing interval-matching) all carry `agent: "meridian:developer"`
  produces `stages.<stage>.agents` = `[{ agent: "meridian:developer",
  totalOutputTokens: <sum>, dispatches: <count> }]`.
- Two tasks whose dispatches land in the same stage, one carrying
  `agent: "meridian:developer"` and the other `agent: "meridian:qa"` with a
  larger total, produce `stages.<stage>.agents` with **both** entries, sorted
  with the larger-token agent first (`agents[0].agent === "meridian:qa"`).
- A `dispatch_tokens` event with no `agent` field at all contributes to an
  `agents` entry with `agent: null`; mixed with a same-stage event that does
  carry an `agent`, both entries appear, each with its own correct
  `totalOutputTokens`/`dispatches`.
- A stage with time/status data but **zero** `dispatch_tokens` events
  attributed to it (e.g. a task visited `backlog` but only ever dispatched
  tokens while `in_progress`) has `stages.backlog.agents` equal to `[]`.
- A `dispatch_tokens` event for a task with no status events at all (the
  existing `stages.unknown` case) still produces `stages.unknown.agents`
  reflecting that event's `agent` (or `null`).
- `dispatches` inside one `agents` entry counts **events**, not tokens —
  three same-agent `dispatch_tokens` events of 100 tokens each in one stage
  produce `{ agent, totalOutputTokens: 300, dispatches: 3 }`, not `1`.
- Regression: every pre-existing `test/stats.test.js` assertion on
  `tasks`/`stages.<name>.{taskCount,avgMs,maxMs,topByTime,avgTokens,maxTokens,topByTokens}`
  still passes unmodified — `agents` is additive only.
- `aggregateWorkspaceStats`: two projects each contributing a
  `dispatch_tokens` event with a different `agent` to the same shared stage
  name (e.g. both have a task in `in_progress`) produce one merged
  `stages.in_progress.agents` array containing both agents' totals combined
  across projects (a same-named agent in both projects sums into one entry,
  not two).

### `test/api-stats.test.js` (extend)

- Seed a task, `PUT` it to `in_progress`, then `POST /api/projects/events`
  a `dispatch_tokens` event with `agent: "meridian:developer"`. `GET
  /api/stats?project=<dir>` returns `body.stages.in_progress.agents` equal to
  `[{ agent: "meridian:developer", totalOutputTokens: 500, dispatches: 1 }]`
  (or matching whatever `output_tokens` value was posted).
- The existing `'GET / serves index.html containing the Stats tab and panel
  markup'` test gains an assertion that the stage table header row contains
  `<th>Agent</th>` and does **not** contain a `<th>Tasks</th>` cell (a
  literal string check on the served body is sufficient, consistent with how
  this test already checks for other markup fragments).
- `GET /app.js` (served statically) contains `'formatStageAgentCell'` and
  `'stats-agent-placeholder'` — mechanical proof the new rendering logic
  shipped, consistent with the existing `'stats-icon-btn'` check MERID-7
  added for the same file.
- Regression: the existing `'GET /api/stats reflects a dispatch_tokens event
  posted via the API'` test's assertions on `stats.dispatches.{count,
  totalOutputTokens, maxContextTokens}` are unchanged and still pass — this
  task only adds a field under `stages`, it does not touch `tasks[id]`.

## Expected Results

- [ ] `lib/stats.js`'s `aggregateStats` and `aggregateWorkspaceStats` both
      return `stages.<name>.agents`: an array of
      `{ agent, totalOutputTokens, dispatches }`, sorted by
      `totalOutputTokens` descending, built from that stage's attributed
      `dispatch_tokens` events; a `dispatch_tokens` event with no `agent`
      field groups under `agent: null` rather than being dropped.
- [ ] `stages.<name>.agents` is `[]` for a stage with time/status data but no
      `dispatch_tokens` events attributed to it.
- [ ] Every pre-existing assertion in `test/stats.test.js` on `tasks` and on
      `stages.<name>.{taskCount, avgMs, maxMs, topByTime, avgTokens,
      maxTokens, topByTokens}` still passes unmodified — `agents` is a purely
      additive field; `stages.<name>.taskCount` remains present in the API
      response.
- [ ] `GET /api/stats` (both `?project=<path>` and the workspace-wide form)
      includes `stages.<name>.agents` in its JSON response, reflecting real
      `dispatch_tokens` events seeded through the actual API.
- [ ] The per-stage Stats table's header row reads `Agent` where it
      previously read `Tasks` — verifiable via `GET /` on the served
      `index.html`, which contains `<th>Agent</th>` and no `<th>Tasks</th>`
      in the stage table's header row.
- [ ] For a stage whose attributed dispatches came from exactly one agent,
      the table cell renders that agent's name with any `meridian:` prefix
      stripped (e.g. `meridian:developer` displays as `developer`).
- [ ] For a stage whose attributed dispatches came from more than one agent,
      the table cell renders the dominant (highest-token) agent's name plus
      a compact count of the others (e.g. `developer (+1)`), with a `title`
      attribute listing every contributing agent and its token total.
- [ ] For a stage with zero dispatch tokens attributed to it, the table cell
      renders the neutral placeholder `—`.
- [ ] The Agent column renders identically (same `renderStatsPanel`
      function, same markup) in both the per-project Stats tab and the All
      Tickets (workspace) Stats tab.
- [ ] `GET /app.js` (served statically) contains `formatStageAgentCell` and
      `stats-agent-placeholder`, and `GET /` contains `<th>Agent</th>` in the
      stage table — mechanical, file-content proof the change shipped in both
      layers, consistent with this codebase's existing precedent for
      testing frontend rendering without a DOM runner.
- [ ] `npm test` (`node --test test/*.test.js`) passes, including the
      extended `test/stats.test.js` and `test/api-stats.test.js`.

## Out of Scope

- Any change to `POST /api/projects/events` or to what MERID-3's
  `running-flag.sh` posts — the `agent` field already exists on
  `dispatch_tokens` events; this task only consumes it.
- Removing `stages.<name>.taskCount` from the API response — it stays,
  unused by the stage table but still present for any other consumer.
- Attributing `topByTime` / `topByTokens` per-task entries to an agent, or
  adding an Agent column to the per-task table — only the per-stage summary
  table changes.
- Per-project breakdown of which agent worked which project's stage in the
  workspace-wide view (the merge sums same-named agents across projects into
  one row, same as every other per-stage aggregate already does).
- Any visual treatment beyond a plain text cell, a `+N` suffix, and a
  `title` attribute — no avatars, colors, or charts.
- Automated browser/DOM testing of `public/app.js`'s rendering — this
  codebase has no DOM test runner; frontend correctness is verified via
  served-file content checks and code review, consistent with MERID-4/
  MERID-7's own precedent.
