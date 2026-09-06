# MERID-5 — Sub-tasks: parent field with one-level validation, board badge and progress chip

## Scope

Adds the data model and board rendering for one-level sub-tasks:

- An optional `parent` field on the task schema, accepted on create and update,
  with server-side one-level validation.
- No stored children list — the parent/child relationship is always derived
  by filtering the tasks array on `parent` at read/render time.
- Board rendering: a badge on child cards naming their parent, and a
  progress chip (`done/total`) on parent cards.
- `schema.md` documents the new field and its validation rule.

Does **not** cover: the pipeline/stage semantics of sub-tasks, `pm`/`work`/`next`
skill behavior, or any changes to `agents/`, `pipeline.md`, or `stages.md` —
all of that is MERID-6, blocked on this task.

## Approach

### 1. Server: `parent` field, create and update

File: `server.js`.

Add a validator, next to `validateTaskFields` (around line 161), that needs the
project's task list rather than just the request body, so it cannot be folded
into `validateTaskFields` itself:

```js
// Enforces one level of nesting. `taskId` is the id of the task being
// written (null on create, since the id doesn't exist yet — a brand-new
// task can neither be its own parent nor already have children).
// Returns an error message, or null when the value is acceptable.
function validateParentField(parentId, tasks, taskId) {
    if (taskId && parentId === taskId) {
        return 'A task cannot be its own parent';
    }
    const parentTask = tasks.find(t => t.id === parentId);
    if (!parentTask) {
        return `Parent task '${parentId}' does not exist on this board`;
    }
    if (parentTask.parent) {
        return `Parent task '${parentId}' already has a parent; only one level of nesting is allowed`;
    }
    if (taskId && tasks.some(t => t.parent === taskId)) {
        return `Task '${taskId}' already has sub-tasks and cannot be given a parent`;
    }
    return null;
}
```

Call sites:

- **`POST /api/projects/tasks`**: after `tasksData = getTasks(projectPath)` (the
  parent must be checked against that project's own tasks) and before building
  `newTask`, if `req.body.parent !== undefined && req.body.parent !== null`,
  call `validateParentField(req.body.parent, tasksData.tasks, null)` and
  `return res.status(400).json({ error: invalid })` on a non-null result. When
  the check passes, set `parent` on the new task object; when `parent` is
  absent or `null`, do not add the field at all (creation never needs to clear
  anything).

- **`PUT /api/projects/tasks/:taskId`**: after `tasksData` is loaded and the
  task is found (so `taskIndex !== -1`), before the field-copy loop:
  - if `req.body.parent === null`, mark the field for clearing (`delete
    task.parent` in the same place the scalar fields are applied) — this is
    the documented way to detach a sub-task from its parent, and needs no
    validation.
  - if `req.body.parent !== undefined` (and not null), call
    `validateParentField(req.body.parent, tasksData.tasks, taskId)` and return
    400 on a non-null result; on success set `task.parent = req.body.parent` in
    the same field-copy section as the other scalar fields (do not add
    `'parent'` to the generic `scalarFields` array, since it needs the
    null-clears and validation special-casing above; handle it as its own
    `if` block next to the existing `blockedBy`/`expected_results`/
    `last_review_findings` special cases).
  - Validate and reject *before* mutating `task` — a 400 must never leave a
    partial write, consistent with how `validateTaskFields` already gates the
    whole request up front.

No change to `stampNewTask`/`stampTaskUpdate` — `parent` is not a timestamp
field and needs no stamping.

Note on scoping: this validation runs against one project's `tasks.json` only
(the file `getTasks(projectPath)` reads), so "the referenced parent must exist
on the same project board" is automatically satisfied — there is no
cross-project id space to police here.

### 2. No stored children list

Nothing writes a `subtasks`/`children` array anywhere: not `stampNewTask`, not
the PUT handler, not `lib/tasks.js`'s `backfillTasks`. Every reader — board
render, future MERID-6 pipeline/skill code — derives children by filtering the
full tasks list on `parent === task.id` at the point of use. This spec adds two
such derivations (see §3); no other read path is touched.

### 3. Board rendering helpers — `lib/board.js` (source of truth)

Add three pure functions, following the existing module's pattern
(top-of-function comment explaining the rule, exported at the bottom):

```js
// A task is a "parent" when at least one other task on the board names it as
// `parent`. Scoped by projectPath when tasks carry one — the global view
// tags every task with its owning project before flattening every project's
// list into a single array, and two different projects can reuse the same
// task id. public/app.js mirrors this; this file is the source of truth.
function childrenOf(tasks, task) {
    return (tasks || []).filter(t =>
        t && task && t.parent === task.id &&
        (t.projectPath || null) === (task.projectPath || null)
    );
}

// null when the task has no children (nothing to show); otherwise the counts
// the board's progress chip renders. "done" mirrors the status a completed
// task carries, not the completed_at window done/nope columns apply — a
// child counts the moment its status is done, regardless of age.
function subtaskProgress(tasks, task) {
    const children = childrenOf(tasks, task);
    if (children.length === 0) return null;
    return { done: children.filter(t => t.status === 'done').length, total: children.length };
}

// null when the task has no parent; otherwise the label the child card's
// badge renders.
function parentBadge(task) {
    return task && task.parent ? `↳ ${task.parent}` : null;
}
```

Export all three alongside the existing exports:
`module.exports = { isRecentlyCompleted, isRecentlyDismissed, manualTransition, byRecencyDesc, collapsedColumns, childrenOf, subtaskProgress, parentBadge };`

### 4. Board rendering — `public/app.js` (mirror, no module system)

Mirror the three functions verbatim (same comment convention already used for
`withinWindow`/`manualTransition`/etc — "Mirrors lib/board.js#X — that file is
the source of truth"), placed near the existing mirrored block (after
`collapsedColumns`, ~line 93).

`renderTaskCardHtml(task)` (line ~949) does not currently have access to the
full task list — it only takes the one task being rendered. Change its
signature to `renderTaskCardHtml(task, allTasks)` and update both call sites
inside `renderKanbanBoard` (the `visibleTasks.map(...)` at ~line 1151 and the
`hiddenTasks.map(...)` at ~line 1136) to pass the `tasks` array already in
scope in that function (the same array `renderKanbanBoard(tasks)` receives —
either `proj.tasks` for a single project or the flattened, `projectPath`-tagged
`allTasks` for the global view, so `childrenOf`'s scoping in §3 applies
correctly in both).

Inside `renderTaskCardHtml`, compute:

```js
const parentBadgeLabel = parentBadge(task);
const progress = subtaskProgress(allTasks, task);
```

Render, conditionally, inside the card's header row (alongside the existing
`runningBadge`/`projectBadge`):

- when `parentBadgeLabel` is not null: `<span class="task-parent-badge" title="Parent task ${task.parent}">${parentBadgeLabel}</span>`
- when `progress` is not null: `<span class="task-progress-chip" title="Sub-tasks done">${progress.done}/${progress.total}</span>`

A task can show at most one of the two (a task with a parent cannot have
children, per the one-level rule), but the markup does not need to assume
that invariant — both are independently conditional.

Add matching CSS rules to `public/styles.css` (near `.project-tag-badge` /
`.running-inline-dot`, ~line 1088/1240) for `.task-parent-badge` and
`.task-progress-chip` — small inline chip styling consistent with the
existing badges; exact colors are an implementation choice, not specified
here.

### 5. `schema.md` — field table

File: `plugin/plugins/meridian/references/schema.md`.

Add a row to the field table, after `blockedBy`:

```
| `parent` | string, id of another task on the same board, optional | agent |
```

Add a paragraph documenting the one-level rule, placed after the existing
`blockedBy` paragraph and before the `blockedBy` "gates implementation, not
specification" paragraph:

```markdown
`parent` links a task to another task on the same board as its sub-task.
Nesting is capped at **one level**: the server rejects a write with `HTTP 400`
when the referenced parent does not exist on the same board, when the
referenced parent itself already has a `parent`, when the task being written
already has children (other tasks naming it as `parent`), or when a task
names itself as its own parent. Sending `"parent": null` on update clears the
field. No `subtasks`/`children` array is ever stored on the parent — anything
that needs a task's children derives them by filtering the task list on
`parent` at read time.
```

Do not touch `pipeline.md`, `stages.md`, or anything under `agents/` — that is
MERID-6's job.

## Testing

Follow the fixture patterns already in `test/api-tasks.test.js`
(`workspaceWith`/`withServer`/`seed`/`put` helpers — reuse them, do not
duplicate). Add new `test(...)` blocks to that file (not a new file):

- POST accepts a `parent` referencing an existing task on the same board →
  `201`, response `task.parent` equals the given id.
- POST with a `parent` naming a task id that does not exist → `400`.
- POST with a `parent` naming a task that itself has a `parent` (seed A, seed
  B with `parent: A.id`, then POST a third task with `parent: B.id`) → `400`.
- PUT with `parent` equal to the task's own id → `400`.
- PUT with a `parent` naming a task that already has children (seed P, seed C
  with `parent: P.id`, then `PUT P` with `parent: <anything else>`) → `400`.
- PUT with `parent: null` on a task that has a parent clears the field —
  response `task.parent` is `undefined` (or absent from the JSON), and
  re-reading the task confirms it stays cleared.
- PUT accepts a valid `parent` and persists it — read `tasks.json` from the
  fixture project directory directly and confirm the child task object has a
  `parent` field with the given value and **no** `subtasks`/`children` key
  anywhere in the file (covers "the children list is never stored").
- A malformed-`parent` request (e.g. referencing a nonexistent id) does not
  write anything: re-read `tasks.json` afterwards and confirm the task is
  unchanged, mirroring the existing "refuses to write over a malformed
  tasks.json" pattern.

Add new `test(...)` blocks to `test/board.test.js` (style: plain objects, no
server, following the existing `isRecentlyCompleted`/`manualTransition`
tests), covering `childrenOf`, `subtaskProgress`, and `parentBadge`:

- `childrenOf` returns every task whose `parent` matches the given task's id.
- `childrenOf` excludes a same-id task from a different `projectPath` (global
  view cross-project id collision case).
- `subtaskProgress` returns `null` for a task with no children.
- `subtaskProgress` returns `{ done, total }` counting children whose
  `status === 'done'` against all children.
- `parentBadge` returns `null` for a task without a `parent`.
- `parentBadge` returns `↳ <id>` for a task with a `parent`.

Run with `npm test` (`node --test test/*.test.js`) — never `node --test
test/`.

## Expected Results

- [ ] `POST /api/projects/tasks` accepts an optional `parent` field
      referencing an existing task on the same project board; the created
      task's `parent` is persisted.
- [ ] `POST /api/projects/tasks` rejects with `HTTP 400` a `parent` that does
      not exist on the same board, or that names a task which itself already
      has a `parent`.
- [ ] `PUT /api/projects/tasks/:taskId` rejects with `HTTP 400` a `parent`
      equal to the task's own id (self-parent).
- [ ] `PUT /api/projects/tasks/:taskId` rejects with `HTTP 400` a `parent`
      assignment to a task that already has children (other tasks naming it
      as `parent`).
- [ ] `PUT /api/projects/tasks/:taskId` with `"parent": null` clears a
      previously set `parent` field.
- [ ] No `subtasks`/`children` array is ever written to `tasks.json` — reading
      the file after creating a parent/child pair shows only the child's
      `parent` field, nothing on the parent.
- [ ] `lib/board.js` exports `childrenOf`, `subtaskProgress`, and
      `parentBadge`, each covered by passing unit tests in `test/board.test.js`.
- [ ] `public/app.js` renders a badge naming the parent id on a child card,
      and a `done/total` progress chip on a parent card, using logic mirrored
      from `lib/board.js`.
- [ ] `plugin/plugins/meridian/references/schema.md` documents the `parent`
      field in the field table and its one-level validation rule in prose.
- [ ] `npm test` passes.

## Out of Scope

- Pipeline/stage semantics for sub-tasks, `pm`/`work`/`next` skill changes,
  and any edits to `pipeline.md`, `stages.md`, or `agents/` — MERID-6.
- UI for creating a sub-task or picking a parent from a form (this task only
  specs the field, its validation, and read-time display; the existing
  add-task form and edit flows are unchanged).
- Cascading behavior when a parent or child task is deleted — the `DELETE`
  endpoint is untouched by this task.
