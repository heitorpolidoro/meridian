# The dispatch allowlist

A dispatched agent runs headless. A tool call needing a permission that is not
granted is **auto-denied, not queued** — the run ends there. So this list is
the boundary that matters, and it is also the thing that breaks a dispatch
when it is too narrow.

It lives in each project's `.claude/settings.json` under `permissions.allow`,
which is the mechanism the headless denial message itself points at.

## What belongs in it

Whatever `meridian:work` cannot complete without: the project's test runner,
and the git verbs the pipeline uses to stage and commit its own work.

## What does not

`git push`, anything that deletes outside the working tree, and anything that
reaches a network service that can act on the operator's behalf. Publishing is
a human act; the pipeline stops at the commit.

`git add` is allowed only with an explicit pathspec. These repositories carry
unrelated open work in committed branches, and a run that stages everything
with `git add -A`, `git add .`, or `git add --all` would commit someone else's
WIP to the repo.

## Extending it per project

Each project needs its own, because the test runner differs — `pytest`,
`mix test`, `npm test`. Copy this repository's file and replace the runner
entries.

## When a run dies for a missing permission

The run tab shows *"Run stopped: a command is outside the allowlist"* and the
log names the tool call. Add the specific verb, not a wildcard.

## What this list does not protect against

The entries are matched as **prefixes** by the Claude Code CLI, not by Meridian.
Whether compound commands (`a && b`) are decomposed and checked per part has
not been verified here. The allowlist is therefore a strong default that blocks
the most dangerous operations, but it is not a sandbox. Do not claim it is
bypassable, and do not claim it is airtight — it is a sound practical boundary
for the stated purpose.
