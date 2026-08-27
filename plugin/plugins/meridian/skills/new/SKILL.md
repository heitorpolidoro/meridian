---
name: new
description: Use when the operator wants to add a task to the current project's Meridian backlog - creates it through the API with expected results.
---

# Meridian New

Creates one task in the current project's backlog. Invoked as
`meridian:new "<title>"`. Field rules, statuses and priorities below follow
`references/schema.md`; if anything here disagrees with it, that file wins.

## 1. Perform the shared preamble

Follow `references/preamble.md` in order, and stop where it says stop. It
resolves `$BASE`, resolves the project to the current working directory (never
a parent), and gets the server running. Do not repeat or shortcut any of its
steps here.

If the preamble stops — the operator declined registration, or the server
could not be reached — stop too. There is no fallback path for creating a task:
a create is a write, and hand-editing `tasks.json` cannot assign an id.

## 2. Get the title

Take the title from the invocation argument. If it is missing, ask the
operator for one. Keep it short and imperative, per `references/schema.md`.

## 3. Require `expected_results`

`expected_results` is not optional for this skill, even though the API itself
would accept an empty array. If the operator did not supply any, ask for
concrete, mechanically verifiable outcomes — an HTTP status, a passing named
test, an observable UI interaction. State why when you ask: `meridian:qa`
receives **only** a task's `expected_results`, never the spec or the code — so
a task without them produces a weak spec and leaves QA with nothing to check
against.

Do not proceed to creation with an empty `expected_results` array. If the
operator has none to give right now, say that the task cannot be created
without at least one, and stop.

## 4. Resolve `priority`

Optional; default `medium` when not supplied. If a priority is supplied,
validate it yourself before calling the API — it must be exactly one of
`critical`, `high`, `medium`, `low` (lowercase). If it is anything else, tell
the operator the four valid values and ask them to pick one; do not send an
invalid value and rely on the server's 400.

## 5. Create the task

```bash
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
