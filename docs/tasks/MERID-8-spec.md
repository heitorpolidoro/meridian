# MERID-8 — Fix broken scroll in project/global views: board-panel and stats-panel outside the flex scroll chain

## Scope

CSS-only fix in `public/styles.css` restoring the one-viewport scroll chain
(introduced by the Project View revamp) that MERID-4's Stats-tab markup broke
by inserting two new, unstyled `<div>`s (`#board-panel`, `#stats-panel`)
between `#project-view` and the elements that were designed to scroll.

Root cause (already diagnosed in the live DOM, not re-diagnosed here):
`body[data-view="project"|"global"]` is `overflow:hidden; height:100vh`, and
`.container` / `#project-view` are `display:flex; flex-direction:column`
chains where every band is either fixed-height (`flex: 0 0 auto`) or the
designated scroller (`flex: 1 1 auto; min-height: 0`). `.kanban-board`
(`public/styles.css` ~line 816) is that designated scroller — horizontal
scroll for columns, with each `.kanban-tasks` column body handling its own
vertical scroll (~line 911, already correct, not touched by this task).
MERID-4 wrapped the running-tickets-section + kanban-board pair in
`#board-panel` and added a sibling `#stats-panel`
(`public/index.html` ~lines 78–97), and never gave either element any CSS. As
plain flex children with no `flex`/`min-height` declared, both default to
`flex: 0 1 auto` and `min-height: auto`, so each grows to its full content
height (observed ~7600px for `#board-panel` in the global view) instead of
being capped to the remaining viewport space. Because the body has
`overflow:hidden`, that overflow is simply clipped — nothing scrolls,
vertically or horizontally, in either the All Tickets or per-project view.

In scope:
- Add the missing flex-chain CSS for `#board-panel` and `#stats-panel` in
  `public/styles.css` so each becomes a bounded flex child of `#project-view`
  again, letting `.kanban-board`'s existing horizontal-scroll design and each
  column's existing vertical-scroll design work as originally built, and
  giving `#stats-panel` its own internal vertical scroll for tall stats
  tables.
- Bump the `styles.css?v=` cache-busting query string in `public/index.html`
  (currently `26`), per the existing convention every styling change in this
  file already follows.
- A test that asserts the new CSS rules are present in the CSS actually
  served by the running app (see Testing) — the closest thing to a
  mechanical check this project has for layout, given there is no browser/DOM
  test runner (same rationale MERID-4 used for its markup-presence test).

Out of scope (see `## Out of Scope`):
- Any change to `.kanban-board`, `.kanban-column`, `.kanban-tasks`, or any
  other rule already correctly part of the scroll chain — they are not
  touched, only re-connected to a bounded parent.
- Any change to `#project-view`, `.container`, or the `body[data-view=...]`
  rules — these are already correct per the diagnosis and are not part of the
  bug.
- Any JS/behavioral change to how `#board-panel`/`#stats-panel` are shown or
  hidden (`app.js`'s `showBoardTab`/`showStatsTab`, which toggle the
  `.hidden` class) — this task only supplies the missing CSS those toggles
  already assume exists.
- Any redesign of the Stats tables' own content or columns (MERID-4's scope).

## Approach

### 1. `public/styles.css` — close the flex chain

Add a new rule block immediately after the existing `#project-view` rule
(~line 727), so the two new elements sit right next to the layout rule they
extend:

```css
/* #board-panel / #stats-panel were added by MERID-4 with no layout CSS at
   all, so each defaulted to flex:0 1 auto / min-height:auto inside
   #project-view's column flex — growing to full content height instead of
   being capped to the viewport, with the overflow silently clipped by
   body[data-view="project"|"global"]'s overflow:hidden. These rules make
   both proper links in the scroll chain again: bounded flex children that
   hand scrolling off to the elements actually designed for it. */
#board-panel {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
}

#stats-panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
}
```

Notes on each declaration, so review doesn't second-guess them:

- **`#board-panel` needs `display: flex; flex-direction: column`, not just
  `flex`/`min-height`.** Its own children — `#running-tickets-section`
  (`flex: 0 0 auto`, ~line 1267) and `.kanban-board`
  (`flex: 1 1 auto; min-height: 0`, ~line 816) — already carry the correct
  flex-item declarations, but those only take effect if their parent is
  itself a flex container. Before this fix `#board-panel` was a plain block
  box, so `.kanban-board`'s `flex: 1 1 auto` was dead CSS; that is the second
  half of the same bug, not a separate one.
- **`#stats-panel` does not need `display: flex`.** Its children
  (`.stats-toolbar`, `#stats-loading`, `#stats-error`, `#stats-content`) rely
  on normal block stacking, not flex-item sizing from their parent — `
  .stats-toolbar` is already its own `display:flex` row. `#stats-panel` only
  needs to (a) be capped to the remaining viewport height as a flex child of
  `#project-view`, exactly like `#board-panel`, and (b) scroll its own
  overflow internally rather than pushing it into the clipped body — hence
  `flex: 1 1 auto; min-height: 0; overflow-y: auto` with no `display`
  override (a flex item's own `display` is blockified per spec regardless of
  the value declared, so plain block content stacks correctly either way).
- **No selector needs to be scoped to `body[data-view="project"|"global"]`.**
  `#board-panel` and `#stats-panel` only ever render inside `#project-view`,
  which is itself only shown (not `.hidden`) in the project and global
  views — in `body[data-view="dashboard"]`, `#project-view` carries the
  `.hidden` class (`display:none !important`), so its entire subtree,
  including these two panels, is out of layout. The dashboard's own scrolling
  page is therefore untouched by this change; no dashboard-specific rule is
  needed or should be added.
- **`.hidden` still wins.** `app.js` toggles `#board-panel`/`#stats-panel`
  between shown and hidden with `classList.add/remove('hidden')`
  (`showBoardTab`/`showStatsTab`), and `.hidden { display: none !important; }`
  (styles.css line 1) already beats any non-`!important` `display` value by
  the `!important` rule alone, regardless of selector specificity — neither
  new rule declares `!important` or a competing `display: none`, so this
  needs no additional override. Confirm this by inspection (see Testing)
  rather than adding a redundant `!important` to the new rules.

### 2. `public/index.html` — cache-busting bump

Bump the stylesheet version query string so browsers don't serve a stale
cached copy, matching the existing convention (MERID-4 did the same for its
own CSS additions):

```html
<link rel="stylesheet" href="styles.css?v=27">
```

(`app.js` is untouched by this task, so its `?v=` stays at `38`.)

### 3. No markup or class changes

The task description allows for "a tiny markup/class tweak if genuinely
needed" — it is not needed here. `#board-panel` and `#stats-panel` already
exist as exactly the elements the new CSS targets; nothing in
`public/index.html`'s structure needs to change beyond the version bump
above.

## Testing

This project has no browser/DOM test runner, so — consistent with how
MERID-4 verified its markup landed (fetching `/` and asserting the served
HTML contains specific ids) — verify the served CSS contains the specific
rules this fix depends on, by fetching the CSS the app actually serves
(`express.static` on `public/`, confirmed in `server.js`) rather than reading
the file on disk, so the test fails if the rule is ever accidentally removed
or the file fails to ship.

`test/routes.test.js` only unit-tests the pure `resolveRoute()` function and
has no server fixture, so it is not the right home for this. Add a new test
next to the existing SPA-fallback test in `test/api-tasks.test.js`
(`GET /<slug> and GET /tickets serve index.html for the SPA to route`, ~line
581), reusing that file's own `withServer`/`workspaceWith` fixtures — never
touch the real board or the checkout's own `.meridian/`:

- `GET /styles.css` returns `200` with a `text/css` content type, and the
  body:
  - matches a `#board-panel` rule block containing `flex: 1 1 auto` and
    `min-height: 0` (regex over the block, not a brittle full-text match, so
    incidental formatting changes don't break the test).
  - matches a `#stats-panel` rule block containing `flex: 1 1 auto`,
    `min-height: 0`, and `overflow-y: auto`.
  - still contains the pre-existing `.hidden { display: none !important; }`
    rule (regression guard: proves this fix did not touch or reorder that
    rule in a way that would change its cascade behavior).
- The existing SPA-fallback test's body already includes the full served
  HTML — extend its assertions (or add one alongside it) to also check for
  `id="board-panel"` and `id="stats-panel"`, a cheap regression guard that
  this task didn't accidentally rename either id while adding the CSS (would
  silently break both the new CSS selectors and `app.js`'s existing
  `getElementById` calls).

**What automated tests cannot check, and QA must verify in a real browser**
(state this plainly in the PR description / QA handoff, since UI layout is
not mechanically testable here):
- Open the global "All Tickets" view with enough tasks/columns to overflow
  both axes: the kanban board scrolls horizontally when columns exceed the
  window width, each column scrolls its own tasks vertically, and the page
  body itself does not scroll (no browser scrollbar on `<html>`/`<body>`).
- Repeat inside a single project's Board tab: same three checks.
- Switch to the Stats tab (per-project view only — the tab is hidden in the
  global view per MERID-4) with enough stage/task rows to overflow the
  vertical space: the Stats panel itself scrolls vertically inside the
  viewport, the page body still does not scroll, and the fixed bands above it
  (header, project header, kanban toolbar, tab bar) stay pinned in place
  while the panel content scrolls.
- Switch between Board and Stats tabs repeatedly and confirm exactly one of
  `#board-panel`/`#stats-panel` is visible at a time (the `.hidden` toggle
  still works with the new `flex`/`overflow-y` declarations in place) and no
  layout jump/flash occurs.
- Load the dashboard home (`body[data-view="dashboard"]`): the page scrolls
  normally (not clipped to one viewport), unaffected by this change.
- Resize the browser window narrower/shorter while in the project view to
  confirm the board/stats panel reflow rather than breaking out of the
  viewport at smaller sizes.

## Expected Results

- [ ] `GET /styles.css` returns HTTP 200 with a `text/css` content type.
- [ ] The served `styles.css` contains a `#board-panel` rule with `flex: 1 1 auto`, `min-height: 0`, and `display: flex; flex-direction: column`.
- [ ] The served `styles.css` contains a `#stats-panel` rule with `flex: 1 1 auto`, `min-height: 0`, and `overflow-y: auto`.
- [ ] The served `styles.css` still contains the `.hidden { display: none !important; }` rule, unchanged, confirming the `.hidden` toggle continues to override the new `display`/`flex` declarations on both panels.
- [ ] The served `/` (or `/<slug>`) HTML still contains `id="board-panel"` and `id="stats-panel"` — the ids the new CSS selectors and `app.js` both depend on are unchanged.
- [ ] `public/index.html`'s `styles.css?v=` query string is incremented from the pre-fix value, so browsers fetch the updated stylesheet rather than a cached copy.
- [ ] QA, in a real browser: in the global (All Tickets) view, with enough columns/tasks to overflow, the kanban board scrolls horizontally, each column scrolls vertically, and the page body does not scroll.
- [ ] QA, in a real browser: in a per-project view's Board tab, the same three behaviors hold.
- [ ] QA, in a real browser: in a per-project view's Stats tab, with enough rows to overflow, the Stats panel scrolls vertically inside the viewport while the page body and the fixed bands above the panel (header, project header, toolbar, tabs) stay in place.
- [ ] QA, in a real browser: the dashboard home continues to scroll as a normal page (not clipped to one viewport).
- [ ] `npm test` (`node --test test/*.test.js`) passes, including the new CSS-content assertions added to `test/api-tasks.test.js`.

## Out of Scope

- Any change to `.kanban-board`, `.kanban-column`, or `.kanban-tasks` — their
  scroll behavior is already correct and is not modified by this task.
- Any change to `#project-view`, `.container`, or the
  `body[data-view="project"|"global"]` rules — already correct per the
  diagnosis.
- Any JS change to `app.js`'s tab-switching logic (`showBoardTab`,
  `showStatsTab`) — this task supplies only the CSS those functions already
  assume is in place.
- Any redesign of the Stats tab's own tables/content (MERID-4's scope, not
  reopened here).
- Automated browser/DOM/visual-regression testing — this codebase has no
  such runner; the CSS-content test above plus the QA browser checklist are
  the only verification available, consistent with how MERID-4 verified its
  own markup.
