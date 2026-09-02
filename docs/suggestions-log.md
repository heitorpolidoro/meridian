
## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- **A2 placement of `#view-loading`.** The spec says the `<main>` area shows the placeholder, but `<main>` *is* `#dashboard-view`, which starts `hidden`; placed inside it the placeholder would never show. State explicitly that `#view-loading` is a sibling of the two views inside `.container` (or make `<main>` a neutral wrapper around both views).
- **B1 selector vs. prose.** The prose scopes the compact header and `overflow: hidden` to `data-view` = `project` or `global`, but the given selector is `body:not([data-view="dashboard"])`, which also matches the pre-route state when `body` has no `data-view` yet (compact header and hidden buttons during "Loading workspace…"). Either set an initial `data-view` on `<body>` in `index.html` or use `body[data-view="project"], body[data-view="global"]` so the two descriptions agree.
- **A1 drops the `relativePath || path.split('/').pop()` fallback** present in today's `handleUrlRouting` (line 673). `server.js` line 379 always sets `relativePath`, so this is safe, but the spec could say so in one sentence so the developer does not reintroduce the fallback "for safety" and diverge from the tested `resolveRoute`.
- **A7 `openDetails` keying in the global view.** `uid` is `j-<task.id>`; ids are per-project keys so collisions across projects are unlikely, but the capture could key on `#<uid>` plus `data-project` if the card exposes it. Non-blocking; worth a comment in `captureBoardState`.
- **B2 rail keyboard handling.** The spec says Enter/Space; B4 tests only Enter. Fine as is, but if Space is intended, add it to B4 so QA checks both.
- **Split note.** Keep it — it is useful for the developer — but if the work is cut into two PRs, the task's expected results should be re-tagged per PR at that time so QA does not check B-results against the A PR.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- **A2 placement of `#view-loading` (carried over from round 1, still open).** The spec says "the `<main>` area shows a single `#view-loading` element", but in `index.html` line 35 `<main>` *is* `#dashboard-view`, which starts `hidden`; a placeholder inside it would never render. The observable result (A2) forces the developer to put it elsewhere, so this is not ambiguous in outcome, but one sentence — "`#view-loading` is a sibling of the two views inside `.container`" — would prevent a wasted iteration.
- **B1 selector vs. prose (carried over).** Prose scopes the compact header and `overflow: hidden` to `data-view` = `project`/`global`; the given selector `body:not([data-view="dashboard"])` also matches the pre-route state when `body` has no `data-view` yet, so the "Loading workspace…" screen would show the compact header with `#open-add-modal-btn` hidden. This is consistent with A6 as written, so it is not blocking; if the full header is wanted during loading, set an initial `data-view` in `index.html` or use `body[data-view="project"], body[data-view="global"]`.
- **A7 `expandedRails` in the captured state.** B2 defines `expandedRails` as a module-level Set, so capturing it in `captureBoardState` is redundant (it survives the rebuild on its own). Either drop it from the capture shape or say the capture snapshots it for symmetry — either is fine, but the developer should not be left wondering whether the rendering reads the Set or the snapshot.
- **A1 drops the `relativePath || path.split('/').pop()` fallback (carried over).** `server.js` always sets `relativePath`, so this is safe; a one-line note would stop a "for safety" reintroduction that diverges from the tested `resolveRoute`.
- **B2 rail keyboard handling (carried over).** Spec says Enter/Space; B4 tests only Enter. If Space is intended, add it to B4.
- **B1 `.kanban-header` → `.kanban-toolbar` rename** is mentioned in passing inside the flex list; since B5 and the files table also rely on the new class name, a dedicated bullet ("rename `.kanban-header` to `.kanban-toolbar` in `index.html` and `styles.css`") would make it harder to miss.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- `public/styles.css` (board-view rules, roughly lines 640–710) and `public/index.html:11`:
  the compact-header / flex-container / hide-dashboard-actions rules are all keyed on
  `body:not([data-view="dashboard"])`. `<body>` carries no `data-view` until the first SSE
  message resolves a route, so a cold load of `/` briefly renders the compact header,
  hides the subtitle and `#open-add-modal-btn`, and sizes `.container` to `100vh`, then
  snaps to the full dashboard header. Not a view flash (A2 is satisfied), but it is a
  header flash on the most common entry URL. Either scope those rules to
  `body[data-view="project"], body[data-view="global"]`, or give `<body>` an initial
  `data-view` and key the rules on the two board values. QA may notice this under B2.
- `public/app.js:1001`: `captureBoardState` copies `expandedRails` into the state object,
  but `restoreBoardState` never reads it — `collapsedColumns` consumes the module-level
  Set directly. The field is dead; drop it (and the matching line in the doc comment).
- `public/styles.css:372` (`#error-container:empty { display: none; }`): not in the spec.
  Harmless in the flex column, but it is unrelated to this task and could be mentioned in
  the commit message or dropped.
- `public/app.js:159-204`: the `renderProjects` re-indent is correct but doubles the
  visual size of the diff. If a second round is needed anyway, a reviewer-friendlier
  shape is to keep the early-return structure and hoist the `fixAllBtn` / `refreshProjectView`
  tail into a tiny helper called from both paths. Purely cosmetic; fine to leave.
- Commit message: note the `--border-color` → `--card-border` correction on the toolbar
  control, since it changes the rendered border colour of the done-window control.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02
- `/project_b` at 1440×900 renders four full columns at their 260 px minimum plus five rails and overflows the board by 12 px (scrollWidth 1388 vs clientWidth 1376), which yields a barely-there horizontal scrollbar. Letting columns shrink a little below 260 px before overflowing, or trimming the 1 rem gap when rails are present, would avoid the sliver scroll on common laptop widths.
- `index.html` loads the Google Fonts stylesheet before the end-of-body `<script>`, so when `fonts.googleapis.com` is slow or unreachable the script (and therefore the first route/`#view-loading` removal) waits for that request to fail. Loading the font non-render-blocking (`media="print" onload="this.media='all'"`, or a `<link rel="preload">` with `font-display: swap`) would keep the SPA boot independent of third-party latency.
- The breadcrumb's `textContent` is `Meridian›Project D` (spacing comes from CSS `gap`), so text copied or read by assistive tech runs the words together; adding whitespace around the separator span, or an `aria-label` on the nav items, would read more naturally.
