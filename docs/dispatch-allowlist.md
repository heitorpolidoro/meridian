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

`git add` is allowed only with an explicit pathspec. All flag-shaped invocations
of `git add` (anything beginning with a dash) are denied as a class by a single
rule. This is why `git add` is safe to allow at all: a pathspec does not start
with a dash, so legitimate invocations like `git add src/foo.js` pass through
while all dangerous forms are blocked. These repositories carry unrelated open
work in committed branches, and the class-level deny ensures no combination of
flags can stage everything.

## Extending it per project

Each project needs its own, because the test runner differs — `pytest`,
`mix test`, `npm test`. Copy this repository's file and replace the runner
entries.

## When a run dies for a missing permission

The run tab shows *"Run stopped: a command is outside the allowlist"* and the
log names the tool call. Add the specific verb, not a wildcard.

## What this list does not protect against

Claude Code splits compound commands on `&&`, `||`, `;`, `|`, `|&`, `&`, and
newlines, then matches each subcommand independently against the rules. Deny rules
fire when any subcommand matches, including inside a subshell or command
substitution. This means an agent cannot escape the list by wrapping a dangerous
command in `echo ... | sh` or similar.

The real limitation is that enumeration is what covers `git commit`. For `git add`,
a single pattern denies all flag-shaped forms. But `git commit` needs the `-m` flag
to work, so its dangerous forms must be enumerated: `-a`, `-am`, `--amend`, etc.
Enumeration is only as good as the forms named. A pattern like `git commit -a:*`
does not match `git commit -am msg` because `-am` is a different token. The list
therefore requires maintenance as new dangerous flag combinations are discovered.
