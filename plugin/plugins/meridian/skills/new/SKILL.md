---
name: new
description: Use when the operator wants to add a task to the current project's Meridian backlog - creates it through the API with expected results.
---

# Meridian New

Creates one task in the current project's backlog. Invoked as
`meridian:new "<title>"`. Field rules, statuses and priorities below follow
`schema.md`; if anything here disagrees with it, that file wins.

## 0. Resolve the shared references

`preamble.md`, `pipeline.md` and `schema.md` are shared by all four Meridian
skills and live in the plugin's own `references/` directory — **not** inside
this skill's own folder. Wherever this file names one of them, resolve it by
trying these two paths in order and using the first that exists:

1. `${CLAUDE_PLUGIN_ROOT}/references/<file>.md`
2. `../../references/<file>.md`, relative to the `Base directory for this
   skill: <absolute path>` line the harness states at invocation — use this
   when the first path does not exist, or when `${CLAUDE_PLUGIN_ROOT}` arrives
   unexpanded, as that literal text.

Both are given because only one of them is directly observed: the base
directory line appears on every invocation, while the expansion of
`${CLAUDE_PLUGIN_ROOT}` inside skill prose is unverified either way. Test which
one exists — `test -f <candidate>` — before reading it, and use that resolved
absolute path everywhere this file asks for one.

Never read a bare `references/<file>.md`. Relative to this skill's own folder
that path does not exist, and the read fails.

## 1. Perform the shared preamble

Follow `preamble.md` in order, and stop where it says stop. It
resolves `$BASE`, resolves the project to the current working directory (never
a parent), and gets the server running. Do not repeat or shortcut any of its
steps here.

`$BASE` does not survive between bash calls: shell state is not shared across
Bash tool invocations, only the working directory is. Every block below sets
`BASE` again on its own first line, and so must every block you write. A block
that inherits nothing runs with `BASE` empty and requests a relative URL.

If the preamble stops — the operator declined registration, or the server
could not be reached — stop too. There is no fallback path for creating a task:
a create is a write, and hand-editing `tasks.json` cannot assign an id.

## 2. Get the title

Take the title from the invocation argument. If it is missing, ask the
operator for one. Keep it short and imperative, per `schema.md`.

## 3. Accept `expected_results` if offered — never require them

Capturing an idea is this skill's whole job, and demanding acceptance criteria
at capture time is friction at the worst possible moment. A title is enough.

If the operator volunteers concrete outcomes, pass them through. If they do
not, create the task with an empty `expected_results` and say nothing about it.
Do **not** prompt for them, and never refuse to create a task for lack of them.

They are not optional forever, only later: `meridian:spec-generator` writes
them while producing the spec, and `meridian:spec-reviewer` refuses to approve
a spec whose `expected_results` are empty or not mechanically verifiable. That
gate sits on the `specreview → readytodo` transition, which is where a task
stops being an idea. `meridian:qa` receives **only** a task's
`expected_results`, so nothing reaches QA without passing that gate first.

## 4. Resolve `priority`

Optional; default `medium` when not supplied. If a priority is supplied,
validate it yourself before calling the API — it must be exactly one of
`critical`, `high`, `medium`, `low` (lowercase). If it is anything else, tell
the operator the four valid values and ask them to pick one; do not send an
invalid value and rely on the server's 400.

## 5. Create the task

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -X POST "$BASE/api/projects/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "projectPath": "<absolute path of the current directory>",
    "title": "<title>",
    "expected_results": ["<expected result>", "..."],
    "priority": "<priority>"
  }'
```

The response is `{ "success": true, "task": { ... } }`. Take the
server-assigned `id` from there — never compute it, and never send an `id`,
`status`, `created_at`, `moved_at` or `updated_at` in the request. Every new
task lands in `backlog` regardless of what is sent; do not send `status`.

If the request fails, show the operator the server's error body rather than
guessing at the cause.

## 6. Report

Tell the operator the created task's `id`, `title` and `status` (always
`backlog`), and the `expected_results` and `priority` it was created with.
