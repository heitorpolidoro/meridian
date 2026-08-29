---
name: meridian:new
description: Use when the operator wants to record a task in the current project's Meridian board - captures an idea from a title alone, or logs work already underway or finished. Invoked as `/meridian:new` or `meridian:new`.
---

# Meridian New

Creates one task on the current project's board. Invoked as
`meridian:new "<title>"`. Field rules, statuses and priorities below follow
`schema.md`; if anything here disagrees with it, that file wins.

## 0. Resolve the shared references

`preamble.md`, `pipeline.md`, `stages.md` and `schema.md` are shared by all four
Meridian skills and live in the plugin's own `references/` directory — **not** inside
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
gate sits on the `spec_review → ready_todo` transition, which is where a task
stops being an idea. `meridian:qa` receives **only** a task's
`expected_results`, so nothing reaches QA without passing that gate first.

## 4. Resolve `priority`

Optional; default `medium` when not supplied. If a priority is supplied,
validate it yourself before calling the API — it must be exactly one of
`critical`, `high`, `medium`, `low` (lowercase). If it is anything else, tell
the operator the four valid values and ask them to pick one; do not send an
invalid value and rely on the server's 400.

## 5. Resolve `status` — and report the gap, do not close it

Optional; default `backlog`. A task normally starts as an idea, and `backlog` is
where an idea belongs.

But work does not always arrive in that order. If the operator says the work is
already underway or already finished — "I built this, it should have been a
task" — take the status they name. It must be one of the nine; if it is not, list
them and ask. Creating where reality is beats creating a lie and fixing it later.

**Report what that status is missing; never go and produce it.** A task created
at `code_review` has no spec and no `expected_results`, and satisfying a stage's
prerequisites is `meridian:work`'s job — it owns the stage checks, the reroute
rule and the iteration cap. Duplicating that walk here would give the two skills
different answers to the same question. So say, plainly, something like:

> Created `PROJ-42` at `code_review`. It has no spec and no expected results, so
> `meridian:work` will send it back to be specced before reviewing anything.

Two cases worth naming when they come up:

- **`done`** — the honest target for work that is genuinely finished. It is a
  record, not a pipeline run, and the server stamps `completed_at` on create.
- **`code_review` or later, for work in progress** — `meridian:work` will route it
  back to be specced, writing a spec for code that already exists. That is
  reasonable, but tell the operator to expect it rather than letting it surprise
  them.

## 6. Create the task

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -X POST "$BASE/api/projects/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "projectPath": "<absolute path of the current directory>",
    "title": "<title>",
    "expected_results": ["<expected result>", "..."],
    "priority": "<priority>",
    "status": "<status>"
  }'
```

Omit `status` entirely for the ordinary case; send it only when the operator
placed the task somewhere other than `backlog`.

The response is `{ "success": true, "task": { ... } }`. Take the
server-assigned `id` from there — never compute it, and never send an `id`,
`created_at`, `moved_at`, `updated_at` or `completed_at`. Those five are the
server's, and it overwrites whatever you send.

If the request fails, show the operator the server's error body rather than
guessing at the cause.

## 7. Report

Tell the operator the created task's `id`, `title` and `status` (always
`backlog`), and the `expected_results` and `priority` it was created with.
