# MERID-1 — Revamp Project View UX (SPA transition & Kanban layout)

> Split note: this title bundles two deliverables that could ship as separate
> PRs — (A) the dashboard ⇄ project-view transition and routing, and (B) the
> Kanban board layout. They are specced here as **one PR** because both live in
> the same three files (`public/index.html`, `public/app.js`,
> `public/styles.css`), both touch the same view, and neither is large on its
> own. If the developer prefers two PRs, cut at the A/B boundary below; every
> expected result is tagged with the part it belongs to.

## Scope

The project view is the screen shown at `/<relativePath>` (one project's
Kanban) and at `/tickets` (the global board across all projects). Today it is
reached by toggling `.hidden` on two sibling `<div>`s and rebuilding the whole
board's `innerHTML` on every SSE message. This task fixes the observable UX
problems that fall out of that, in two parts.

**Part A — SPA transition and routing** (`app.js`, `index.html`, `styles.css`,
new `lib/routes.js`, new `test/routes.test.js`, one server test):

1. No flash of the wrong view on a cold load of a deep URL.
2. Unknown routes are handled explicitly instead of silently showing the
   dashboard under a stale URL.
3. The header adapts to the view: a breadcrumb replaces the "Back to
   Dashboard" button, dashboard-only actions hide in project view, and
   `document.title` follows the view.
4. A short enter animation on view switch, disabled under
   `prefers-reduced-motion`.
5. The duplicated-render bug (`window.renderProjects` wrapper) is removed.
6. Board interaction state (scroll positions, expanded details, revealed
   hidden-done chips) survives live SSE re-renders.

**Part B — Kanban layout** (`app.js`, `index.html`, `styles.css`,
`lib/board.js`, `test/board.test.js`):

7. The board fills the remaining viewport instead of guessing its height with
   `calc(100vh - 260px)`; the page no longer has a second, outer scrollbar.
8. Empty columns collapse into narrow rails automatically, replacing the
   "Hide Empty Columns" checkbox.
9. Non-empty columns flex to fill the available width within bounds.
10. Each column carries a status-coloured accent so the nine columns can be
    told apart at a glance.
11. Inline `style=""` attributes in the project-view markup move into
    `styles.css`.

**Not covered** (see Out of Scope): task-card content changes (priority badge,
`blockedBy` chips), drag-and-drop, responsive/mobile breakpoints, the dashboard
grid itself, the modals, the Fix-with-AI flow, and any server-side change other
than one regression test.

## Approach

### Existing facts the implementation must respect

- The frontend is dependency-free vanilla JS with no build step. Pure rules that
  the frontend needs are kept in `lib/` as the source of truth and **mirrored
  inline** in `app.js` with a comment pointing at the source (`lib/board.js`
  already does this for `isRecentlyCompleted`, `manualTransition`,
  `byRecencyDesc`). Follow that pattern for anything new that is testable.
- The server sends the whole board (`getStatusData()` with no options) on every
  SSE `init`/`update` message. The browser holds it in `currentProjectsData`.
- `server.js` already serves `public/index.html` for every non-`/api/` GET
  (SPA fallback at the bottom of the file). No routing change is needed on the
  server.
- Statuses are the nine canonical ids in `KANBAN_STATUSES`. Per-status colour
  classes `.status-<id>` already exist in `styles.css` (lines ~831–839).
- The done/nope window selector (`#done-window`, `meridian_done_window`) and the
  running-tickets strip stay exactly as they are.
- `index.html` cache-busts with `styles.css?v=N` / `app.js?v=N`. Bump both.

### Part A — SPA transition

**A1. Route resolution as a pure function.** Add `lib/routes.js` exporting
`resolveRoute(pathname, projects)`:

```
resolveRoute('/', ...)                 -> { view: 'dashboard' }
resolveRoute('/tickets' | '/all-tickets' | '/global', ...)  -> { view: 'global' }
resolveRoute('/<slug>', projects)      -> { view: 'project', path: <proj.path> }
                                          when slug matches proj.relativePath or
                                          proj.name, case-insensitively, after
                                          trimming leading/trailing slashes
resolveRoute('/<slug>', projects)      -> { view: 'unknown', slug }  otherwise
```

Mirror it inline in `app.js` (same body, comment referencing `lib/routes.js`)
and make `handleUrlRouting()` a thin switch over its result. Tests in
`test/routes.test.js` cover each branch above plus: trailing slash, mixed case,
empty project list with a non-root path (→ `unknown`).

**A2. No flash on cold load.** Both `#dashboard-view` and `#project-view` start
with the `hidden` class in `index.html`. Nothing is shown until the first SSE
`init` message has been processed and `handleUrlRouting()` has chosen a view.
While waiting, the `<main>` area shows a single `#view-loading` element (text
"Loading workspace…", styled with `.view-loading`); it is removed on first
route resolution and never shown again. `isInitialRouteHandled` keeps its
current role.

**A3. Unknown routes.** When the resolved route is `unknown`, show the
dashboard, call `showFlashMessage('No project at /<slug>', 'error')`, and
`history.replaceState(null, '', '/')` so the address bar reads `/`.

**A4. Header adapts to the view.** In `index.html`:

- Remove `#back-to-dashboard-btn`.
- Add `<nav id="breadcrumb" class="breadcrumb" aria-label="Breadcrumb">` inside
  `<header>`. On the dashboard it is hidden. In project view it renders two
  segments: a `<a href="/" data-nav="dashboard">Meridian</a>` and a
  `<span class="breadcrumb-current">` with the project name (or "All Tickets"
  for the global view). Clicking the first segment calls `showDashboard(true)`
  (pushState) and `preventDefault`s the anchor.
- `body` carries `data-view="dashboard" | "project" | "global"`, set by
  `showDashboard` / `showProjectView` / `showGlobalTicketsView`. CSS uses it to
  hide `#open-add-modal-btn` and `#fix-all-btn` whenever `data-view` is not
  `dashboard` (the existing `hasAnyIssues` toggle on `#fix-all-btn` still
  applies on the dashboard). `#global-tickets-btn` stays visible in every view.
- `document.title` is set to `Meridian Dashboard` on the dashboard,
  `<Project name> · Meridian` in project view, `All Tickets · Meridian` in the
  global view.
- The `<h1>` click-to-home behaviour is kept.

**A5. Enter animation.** Give both views the class `view`. Showing a view adds
`view--active`; the animation is `@keyframes view-enter` (opacity 0→1,
translateY(6px)→0, 180ms ease-out) applied by `.view.view--active`. Under
`@media (prefers-reduced-motion: reduce)` the animation is `none`. The leaving
view is hidden immediately (no exit animation — keeps the DOM simple and avoids
two views being laid out at once).

**A6. Single render per SSE message.** Delete the
`const originalRenderProjects = renderProjects; window.renderProjects = ...`
block. `renderProjects()` already calls `refreshProjectView()` when
`currentProjectViewPath` is set; that is the only call path.

**A7. Interaction state survives live re-renders.** In `renderKanbanBoard`,
before `board.innerHTML = ''`, capture:

```
{
  boardScrollLeft: board.scrollLeft,
  columnScrollTop: { [statusId]: .kanban-column[data-status-id] .kanban-tasks .scrollTop },
  openDetails:     Set of ids of .task-justification.visible elements,
  revealedHidden:  Set of statusIds whose .done-hidden-tasks is not .hidden,
  expandedRails:   Set of statusIds the operator expanded this session (Part B)
}
```

and after the rebuild restore each: set `scrollLeft`/`scrollTop`, re-add
`visible` + `open` on matching `#<uid>` and its toggle, re-reveal hidden-done
groups (and drop their chip), keep expanded rails expanded. Note that a
`done`/`nope` column whose only tasks are outside the done/nope window is a
full-width column with a chip, never a rail (see B2), so re-revealing is always
possible. Implement as two
functions `captureBoardState(board)` / `restoreBoardState(board, state)` in
`app.js`. Restoration must not throw when an element no longer exists (task
moved column, column now collapsed).

### Part B — Kanban layout

**B1. Viewport-filling layout.** When `body[data-view]` is `project` or
`global`:

- `body` gets `overflow: hidden` so the page itself never scrolls.
- `.container` and `#project-view` become flex columns with
  `height: 100vh` / `flex: 1 1 auto; min-height: 0` respectively.
- The page `<header>` compacts to a single row (`body:not([data-view="dashboard"]) header`):
  `h1` shrinks to ~1.2rem, `.subtitle` is hidden, `.header-actions` sits on the
  same row (`flex-direction: row; justify-content: space-between`).
- `.project-view-header`, `.status-summary-bar`, `.kanban-header` (renamed
  `.kanban-toolbar`), and `.running-tickets-section` are `flex: 0 0 auto`.
- `.kanban-board` becomes `flex: 1 1 auto; min-height: 0; height: auto`
  (remove the `calc(100vh - 260px)` and `min-height: 400px`). Columns keep
  `height: 100%` so `.kanban-tasks` scrolls internally under a fixed column
  header, as today.

Dashboard view is untouched: `body[data-view="dashboard"]` keeps the current
scrolling page and full header.

**B2. Empty columns collapse into rails.** Add to `lib/board.js`:

```js
// Which columns render collapsed. A column is "empty" when it holds zero
// tasks in that status in total — the done/nope window plays no part.
// Empty columns collapse unless the operator expanded them this session;
// a column with any task never collapses.
function collapsedColumns(columns, expanded) // columns: [{ id, count }], expanded: Set<string>
  -> Set of ids to collapse
```

**Definition of `count` (this is the whole rule, so it is spelled out):**
`count` is the **total** number of tasks in that status — in `app.js` that is
`colTasks.length`, the same number the summary card shows and the number the
old `hideEmptyColumns` check at line 982 tests. It is **not** the windowed
`visibleTasks.length` that the column header shows for `done`/`nope`.
Consequences, stated so they can be checked:

- A `done` (or `nope`) column whose tasks are all older than the done/nope
  window is **not** empty. It renders as a full-width column, its header count
  reads `0` (the windowed count, exactly as today), its `.kanban-tasks` holds
  no visible cards, and the `+N concluídas` / `+N descartadas` chip is present
  and clickable. This is the normal state of a real board (Meridian's own
  included) and matches today's behaviour with the checkbox off.
- A column is a rail **only** when the status has zero tasks in total. A rail
  therefore never has a chip to hide, and an expanded rail never shows a chip.
- The "Empty" placeholder appears only inside an expanded rail (total count
  `0`). It is never rendered next to a chip.
- Changing `#done-window` never collapses or expands a column, because it does
  not change any `count`.

Mirror inline in `app.js`. Tests in `test/board.test.js` (each fixture's
`count` is the total-in-status number per the definition above):

1. `{ id: 'backlog', count: 0 }`, expanded `∅` → `backlog` collapsed.
2. `{ id: 'backlog', count: 0 }`, expanded `{ 'backlog' }` → not collapsed.
3. `{ id: 'in_progress', count: 2 }`, expanded `{ 'in_progress' }` → not
   collapsed (a column with tasks never collapses).
4. `{ id: 'done', count: 3 }`, expanded `∅` → not collapsed, with a comment
   that these three tasks may all be outside the done window; the window does
   not matter because `count` is the total.
5. `columns = []` → empty set.
6. Mixed list `[{backlog,0},{ready_todo,1},{done,0},{nope,4}]`, expanded `∅` →
   exactly `{ 'backlog', 'done' }`.

Rendering: a collapsed column is `<div class="kanban-column kanban-column--collapsed" data-status-id="…" role="button" tabindex="0" title="Expand <Label>">` containing only the rotated label and a `0` count. Width `44px`. Clicking (or Enter/Space) adds the id to a module-level `expandedRails` Set and re-renders; the column then shows at full width with its (empty) `.kanban-tasks` area and an "Empty" placeholder (and no chip — see the definition above). The Set is session-only (not persisted). When a collapsed column gains a task via SSE it expands automatically (by rule, since `count > 0`).

The column header count for `done`/`nope` keeps showing the windowed
`visibleTasks.length`; for every other status it equals the total. The summary
card keeps showing the total. Neither changes in this task.

Remove the `#toggle-empty-cols` checkbox and its `<label>` from `index.html`,
the `hideEmptyColumns` variable, and every read/write of
`localStorage['meridian_hide_empty_columns']`.

`scrollToKanbanColumn(statusId)` must still work when the target is a rail: it
scrolls the rail into view and highlights it (no auto-expand).

**B3. Column sizing.** Expanded columns: `flex: 1 1 260px; min-width: 260px;
max-width: 360px`. Rails: `flex: 0 0 44px`. `.kanban-board` keeps
`overflow-x: auto` for when the sum exceeds the viewport. Summary-card click
still scrolls the column into view.

**B4. Status accent.** Every `.kanban-column` gets `border-top: 3px solid` in a
per-status colour. Add nine rules
`.kanban-column[data-status-id="<id>"] { border-top-color: … }` reusing the
colours already used by the `.status-<id>` badge rules (backlog grey,
spec_review pink, ready_todo blue, in_progress yellow, code_review cyan,
qa_review purple, blocked red, done green, nope grey). Rails use the same
accent so a collapsed column is still identifiable.

**B5. No inline styles in the project view.** Move every `style="…"` inside
`#project-view` (toolbar labels, the done-window `<select>`, the add-task form
and its input, `#pv-stack`) into named classes: `.kanban-toolbar`,
`.toolbar-controls`, `.toolbar-control`, `.toolbar-select`, `.add-task-form`,
`.add-task-input`. The `#flash-message-container` inline style may stay (it is
outside the view) but moving it is welcome.

**B6. Global view parity.** `/tickets` renders through the same
`renderKanbanBoard`, so rails, flex sizing, accents, and state preservation
apply there unchanged. It shows the breadcrumb "Meridian › All Tickets", hides
`#pv-edit-btn` and the add-task form (as today), and keeps
`interleavedByProject`.

### Tests

- `test/routes.test.js` (new): `resolveRoute` branches listed in A1.
- `test/board.test.js`: `collapsedColumns` cases listed in B2.
- `test/api-tasks.test.js` (or a new `test/spa.test.js` reusing the same
  `withServer` pattern): `GET /<slug>` and `GET /tickets` on a running server
  return `200` with `Content-Type` starting `text/html`, and the body contains
  `id="project-view"`. This guards the SPA fallback the deep links depend on.
- Manual verification steps for the DOM behaviours are listed under Expected
  Results; there is no DOM test harness in this repo and adding one is out of
  scope.

### Files touched

| File | Change |
|---|---|
| `public/index.html` | breadcrumb, `hidden` on both views, `#view-loading`, remove back button and hide-empty checkbox, class-based toolbar markup, bump `?v=` on both assets |
| `public/app.js` | `resolveRoute` mirror + routing switch, `data-view` + title + breadcrumb, remove `window.renderProjects` wrapper, `captureBoardState`/`restoreBoardState`, rails + `expandedRails`, remove `hideEmptyColumns` |
| `public/styles.css` | view layout per `data-view`, compact header, `.view`/`view-enter`, `.breadcrumb`, `.view-loading`, board flex sizing, rails, nine accent rules, toolbar classes, reduced-motion rule |
| `lib/routes.js` | new — `resolveRoute` |
| `lib/board.js` | add `collapsedColumns` |
| `test/routes.test.js` | new |
| `test/board.test.js` | `collapsedColumns` cases |
| `test/api-tasks.test.js` or `test/spa.test.js` | SPA fallback regression test |

No changes to `server.js`, `cli.js`, the plugin, the agents, or the data files.

## Expected Results

Manual checks assume the server is running on `http://localhost:3333` with the
Meridian project registered (`relativePath` `meridian`) and at least one
project whose board has cards in ≥ 3 statuses and ≥ 30 tasks total (seed via
`POST /api/projects/tasks` if needed). "Live update" means changing another
task through the API, e.g.
`curl -X PUT localhost:3333/api/projects/tasks/<id> -H 'Content-Type: application/json' -d '{"projectPath":"<abs path>","title":"…"}'`.

Part A — SPA transition

- [ ] A1. `node --test test/*.test.js` passes and includes `test/routes.test.js` covering `resolveRoute` for: `/` → dashboard; `/tickets`, `/all-tickets`, `/global` → global; slug matching `relativePath` or `name` case-insensitively (with and without trailing slash) → project with that `path`; no match → `unknown` with the slug.
- [ ] A2. Cold-loading `http://localhost:3333/meridian` (hard refresh) shows a `#view-loading` placeholder and then the Meridian board; `#dashboard-view` is never visible before `#project-view` (both carry `class="… hidden"` in the served `index.html` source).
- [ ] A3. Cold-loading `http://localhost:3333/does-not-exist` shows the dashboard, a red flash message reading `No project at /does-not-exist`, and the address bar reads `http://localhost:3333/` (not `/does-not-exist`).
- [ ] A4. Clicking a project card changes the URL to `/<relativePath>` without a page reload, `document.title` becomes `<Project name> · Meridian`; browser Back returns to the dashboard with title `Meridian Dashboard`; `/tickets` sets title `All Tickets · Meridian`.
- [ ] A5. In project view, `<nav id="breadcrumb">` shows `Meridian` followed by the project name; clicking `Meridian` returns to the dashboard and the URL becomes `/`. `index.html` contains no element with id `back-to-dashboard-btn`.
- [ ] A6. `document.body.dataset.view` is `dashboard` on `/`, `project` on `/<relativePath>`, `global` on `/tickets`; `#open-add-modal-btn` is visible only when it is `dashboard`, and `#fix-all-btn` is hidden whenever it is not `dashboard`.
- [ ] A7. `styles.css` defines `@keyframes view-enter` applied by `.view.view--active`, and a `@media (prefers-reduced-motion: reduce)` block that sets that animation to `none`.
- [ ] A8. `grep -c "window.renderProjects" public/app.js` prints `0`.
- [ ] A9. With a card's `details` expanded, a column scrolled to the middle, and the board scrolled horizontally, a live update (another task's title changed via `PUT`) re-renders the board and afterwards the same details are still expanded, the column's `scrollTop` and the board's `scrollLeft` are unchanged (±1px).
- [ ] A10. After clicking a `+N concluídas` (or `descartadas`) chip to reveal hidden cards, a live update keeps them revealed and does not bring the chip back.

Part B — Kanban layout

- [ ] B1. In project view at a 1440×900 viewport with a ≥ 30-task board, `document.documentElement.scrollHeight <= window.innerHeight` (no page-level vertical scrollbar); scrolling a column with many cards keeps that column's header visible; `styles.css` no longer contains `calc(100vh - 260px)`.
- [ ] B2. On the dashboard (`/`) the page still scrolls normally and the full header (title, subtitle, action row) is shown; in project view the header is a single compact row with the subtitle hidden.
- [ ] B3. `node --test test/*.test.js` passes and `test/board.test.js` covers `collapsedColumns` with `count` meaning the total number of tasks in the status (not the done/nope-windowed count): `{count: 0}` collapses; `{count: 0}` in the expanded set does not; `{count > 0}` never collapses even when in the expanded set; a `done` column with `count: 3` is not collapsed (comment noting the window is irrelevant); `[]` yields an empty set; the mixed list `[{backlog,0},{ready_todo,1},{done,0},{nope,4}]` yields exactly `{backlog, done}`.
- [ ] B4. Every status with zero tasks in that status in total (regardless of the done/nope window) renders as `.kanban-column.kanban-column--collapsed` with a rendered width of 44px, showing the column label and `0`, no `.task-card`, and no `.done-hidden-chip`; every status with ≥ 1 task in total renders at full width. Clicking a rail (or focusing it and pressing Enter) expands it for the session, showing an "Empty" placeholder and no chip; a page reload collapses it again.
- [ ] B4a. With `#done-window` set so that every `done` task is older than the window (e.g. the smallest option on a board whose done tasks are all older than it), the `done` column is NOT a rail: it renders at full width, its header count reads `0`, and a `+N concluídas` chip is present; clicking the chip reveals the N cards. Changing `#done-window` never turns any column into a rail or expands one.
- [ ] B5. `index.html` contains no element with id `toggle-empty-cols`, and `grep -c meridian_hide_empty_columns public/app.js` prints `0`. `#done-window` still exists and still persists to `localStorage['meridian_done_window']`.
- [ ] B6. Expanded columns have computed `min-width: 260px` and `max-width: 360px` and grow to fill the board width when there is room; when they do not fit, the board scrolls horizontally and clicking a summary card scrolls its column into view with the highlight pulse.
- [ ] B7. `styles.css` contains nine `.kanban-column[data-status-id="<id>"]` rules (one per canonical status) setting `border-top-color`, and rendered columns show a 3px coloured top border matching the `.status-<id>` badge colour family.
- [ ] B8. In the served `index.html`, the `#project-view` subtree contains zero `style="` attributes (`sed -n '/id="project-view"/,/id="add-project-modal"/p' public/index.html | grep -c 'style="'` prints `0`).
- [ ] B9. `/tickets` renders with the same rails, sizing, and accents; shows breadcrumb `Meridian › All Tickets`; `#pv-edit-btn` and the add-task form are hidden; cards still carry the project badge and interleave by project.
- [ ] B10. A test exists and passes asserting that `GET /<some-slug>` and `GET /tickets` on a spawned server return HTTP 200 with a `Content-Type` starting `text/html` and a body containing `id="project-view"`.
- [ ] B11. `index.html` references `styles.css?v=` and `app.js?v=` with numbers strictly greater than the current `23` and `35`.

## Out of Scope

- Task-card content: showing `priority`, `blockedBy`, `created_at`; editing a
  task inline. (Candidate follow-up: "Show priority and blockedBy on Kanban
  cards" — `.task-priority` CSS already exists unused.)
- Drag-and-drop between columns. The board deliberately offers only the
  `manualTransition` moves (Nope / Reopen); nothing here changes that.
- Responsive / mobile breakpoints. The dashboard is a desktop tool and has no
  `@media` width rules today; this task adds none.
- The dashboard grid, the Add/Edit Project modal, and the Fix-with-AI modal and
  flow.
- Any server-side behaviour change. The only server-adjacent change is a
  regression test for the existing SPA fallback.
- A DOM test harness (jsdom, Playwright). DOM behaviours are verified manually
  per the Expected Results; pure rules are unit-tested in `lib/`.
- Persisting expanded rails across reloads.
