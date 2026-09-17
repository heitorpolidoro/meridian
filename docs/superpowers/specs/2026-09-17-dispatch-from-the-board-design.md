# Dispatching agents from the Meridian board

**Date:** 2026-09-17
**Status:** approved, ready to become an implementation plan

## Problem

Approving a spec on the board is one click, but continuing the work is not: the
operator has to leave the board, find a session, and type `meridian:work <ID>`.
Starting a task has the same friction. The board knows exactly which task should
run next and cannot start it.

## What already exists

Measured, not assumed — the investigation that preceded this design:

- **The server already spawns agents.** `/api/fix-with-ai` runs
  `claude -p "$PROMPT" --tools "…" --permission-mode acceptEdits` or
  `agy -p "$PROMPT" --mode accept-edits --sandbox`, streams stdout/stderr over
  SSE and handles the exit code (`server.js:993-1040`).
- **Lifecycle is a solved problem.** `claude --bg` starts a background session;
  `claude agents --json [--cwd <path>]` lists live sessions with `pid`, `cwd`,
  `kind` (`interactive`/`background`), `sessionId` and `status`
  (`busy`/`idle`), does not require a TTY, and survives a server restart.
- **Print mode expands slash commands and skills.** `agy` carries a
  `--disable-slash-commands` flag ("Disable slash command and skill expansion
  in print mode"), and a probe of `agy -p "/meridian:status"` reached the
  permission layer, which only happens after the skill expanded.
- **A missing permission in headless mode is auto-denied, not queued.** The
  probe returned: *"a tool required the 'command' permission that headless mode
  cannot prompt for, so it was auto-denied"*. A dispatched run therefore dies at
  the first command outside the allowlist instead of hanging forever.
- **The plugin serves both CLIs.** `~/.gemini/config/plugins/meridian` is a
  symlink to `plugin/plugins/meridian`, the same directory Claude Code loads.
- **Interruption is already handled.** `hooks.json` registers
  `running-flag.sh` on `Stop` and `SessionEnd`; it clears `running` on every
  task the session left dangling and writes a `resume_context` carrying the
  timestamp, the git state (branch, staged and modified counts) and the latest
  report file.
- **The server already knows which task is next.** `workableTasks()`
  (`server.js:178`) filters to workable statuses and sorts by pipeline
  progress, then priority, then creation date.
- **`work` owns its own loop.** The skill "drives one task through the pipeline
  until it reaches `done` or `blocked`", stopping at human gates
  (`skills/work/SKILL.md:8,139`). The server cannot step it stage by stage.

Two findings constrain the design rather than enable it:

- **Neither CLI sandboxes usefully.** `claude` has no sandbox flag. `agy
  --sandbox` was probed directly: a relative write landed in
  `~/.gemini/antigravity-cli/scratch/` instead of the working directory, while
  an absolute write to `/tmp` succeeded. It breaks legitimate in-repo work and
  does not prevent escape, so dispatch does not use it. **The Bash allowlist is
  the only real boundary.**
- **The Claude CLI is not authenticated** (`claude auth status` →
  `loggedIn: false`). Auth expiry is a first-class failure mode for a server
  that dispatches agents.

## Architecture

### State: in memory, per project

Two pieces of state live in the server next to the existing `clients` and
`watchers`, both keyed by project path:

- **`queue`** — an ordered list of task ids the operator asked to run.
- **`autoDispatch`** — a boolean, default `false`.

Neither is persisted. A server that is down dispatches nothing, so there is
nothing for persistence to protect; and a flag that outlives the thing it
describes is the orphaned-`running` bug this codebase already had to write a
hook to clean up. A restart clears both, and the board shows that truthfully.

**No `queued` field is written to the task.** The queue is already authoritative
in memory; a field would be a second source of truth that drifts on restart, and
writing it would touch `tasks.jsonl`, fire `fs.watch` and rebuild the board once
per enqueue for no change anyone asked for.

### The queue and the auto mode are different things

- **The manual queue** is explicit, ordered by the operator's clicks, finite,
  and has priority.
- **The auto mode** is continuous: when the repo frees and the manual queue is
  empty, the server pulls the next task from `workableTasks()` *at that moment*.

The distinction matters because a snapshot of "everything workable" is a
photograph — a task created a minute later would never be in it. Pulling at
dispatch time is what lets new work join.

### Concurrency

One background session per repository, derived — not stored — from
`claude agents --json --cwd <project>` filtered to `kind: "background"`. A
process that died is gone from the list on its own, so the lock cannot stick.

There is no global cap: the global screen dispatching six projects means six
concurrent sessions. At the measured median of 164k output tokens per task,
that is a real cost, accepted deliberately for now.

### Eligibility, checked when pulling

Never when enqueuing — a task can sit in the queue for minutes. Before each
dispatch:

1. the CLI is authenticated (`claude auth status --json`);
2. no background session is live for that repo;
3. the task is still workable — not `done`, not `nope`, and every `blockedBy`
   id is `done`.

A task that fails a check is **discarded from the queue with a visible reason**
("AEQUI-7 still blocked by AEQUI-3"), not re-queued at the back: a task whose
blocker never lands would spin forever, and re-enqueueing is one click.

A `blocked` task may be enqueued behind its blocker. That is safe precisely
because eligibility is re-checked at pull time — being earlier in the queue is
not a guarantee the blocker reached `done`, since `work` stops at human gates
and can be sent back by a failed QA.

## The controls

| Control | Where | Effect |
|---|---|---|
| `Dispatch` (claude \| agy) | card | Enqueue this task; runs at once if the repo is free |
| `Stop` | card, while running | SIGTERM the pid, SIGKILL if it has not exited after 10s |
| `Remove from queue` | card, while queued | Drop it from the queue |
| `Dispatch all` | board header | Turn `autoDispatch` on for this project |
| `Stop queue` | board header | Turn `autoDispatch` off **and clear the queue** |

The card control is one tri-state button: its label states which of the three
situations the task is in. Enqueue is idempotent anyway, so an accidental
double click cannot queue a task twice.

`Dispatch all` follows the screen it is on: the project view arms that project,
the global view arms every project, one control per project row.

`Stop queue` is named for what it does. It discards the queue rather than
suspending it, and a button labelled "Pause" that throws away queued work would
be a trap.

### Stopping sends SIGTERM

SIGTERM lets the CLI end the session, which fires `SessionEnd`, which runs
`running-flag.sh stop`, which clears `running` and writes the `resume_context`
note. The observable result is identical to interrupting a session by hand —
the behaviour the operator already knows. SIGKILL is the fallback after a grace
period, and it is strictly worse: no hook, so `running` stays stuck and no
resume note is left.

Work already done stays on disk. The server reverts nothing; `git status` is
the record.

### Run logs are written, not only streamed

Output streams over the existing SSE channel (`sendProgress`, with a `type` of
its own so it does not mix with the Fix log) **and** is appended to
`.meridian/runs/<task-id>-<timestamp>.log`, alongside the `.meridian/reports/`
precedent. Streaming alone answers "what is it doing"; only a file answers
"what did it do at 3am", and the operator opening the modal mid-run has already
missed the beginning.

The log is read back in a third tab of the task modal, beside `Specification`
and `Interactive Mockup`. Not on the card: there are 73 cards on the largest
board, and the running badge the card already draws is the right amount of
information there.

## Failures are shown, never swallowed

A dispatch that fails must say so on the board. Three properties, each learned
from a probe rather than assumed:

**The exit code is not enough.** `agy -p` printed *"no output produced — a tool
required the 'command' permission that headless mode cannot prompt for, so it
was auto-denied"* and **exited 0**. A run is judged by its output as well as
its status, and a run that produced nothing is a failure whatever the code says.

**Two failure shapes are recognised and translated**, because both are silent
and both have a specific remedy:

| Detected in the output | Shown to the operator |
|---|---|
| `Failed to authenticate` / `OAuth session expired` | CLI not authenticated — run `claude auth login` |
| `permission that headless mode cannot prompt for` | Run stopped: a command is outside the allowlist |

Anything else is surfaced verbatim, trimmed to the last lines. A translation
table that swallows what it does not recognise is worse than no table.

**What is recorded.** Per project, in memory: the last run's task id, tool,
start and end time, exit code and, on failure, a one-line reason. It rides in
`GET /api/status` so the board can render it. The full output is already in
`.meridian/runs/<task-id>-<timestamp>.log`, which is what the operator opens
when the one-liner is not enough.

**Where it shows.** The card carries a failure marker when the last run for
that task failed, and the task modal's run tab leads with the reason above the
log. A failure never silently leaves the task looking untouched: the queue
moves on, but the reason stays visible until the next run of that task.

## Task field: `skip_auto_dispatch`

A boolean on the task, absent meaning included. It excludes the task from
`Dispatch all` / the auto mode, and does **not** block the card's own
`Dispatch`, where the operator's act is explicit — the same principle as the
`spec_approval` gate, which a machine never crosses on its own.

Deliberately not named `auto_dispatch`: the project-level flag says whether the
loop runs and this says whether a task is eligible. Two different things with
one name is a trap for whoever reads `schema.md` later.

It is operator-owned like `priority`, set from the task modal, and `schema.md`
must say so, so agents leave it alone.

## API surface

- `GET /api/status` gains, per project: `queue` (array of task ids, in order),
  `autoDispatch` (boolean), and `dispatchBlockedReason` (string or null — not
  authenticated, session already live) so the board can explain a disabled
  button instead of swallowing the click.
- `POST /api/projects/dispatch` — `{ projectPath, taskId, tool }` enqueues;
  `tool` is `claude` or `agy`, matching the existing `/api/fix-with-ai` contract.
- `DELETE /api/projects/dispatch/:taskId` — removes from the queue.
- `POST /api/projects/dispatch/stop` — `{ projectPath, taskId }` signals the
  running session.
- `POST /api/projects/dispatch/auto` — `{ projectPath, enabled }`; disabling
  also clears the queue.
- `schema.md` documents `skip_auto_dispatch`.

## Testing

Pure and testable in `lib/`: the eligibility decision (given a task, a board
and a live-session list, may it be dispatched and if not why), the queue
operations (enqueue idempotent, remove, pull-next, clear), and the choice of the
next task under the auto mode. These carry the real logic and get unit tests.

Not unit-testable here: the spawn, the signal handling and the UI. Verified in
the browser against a real board, and the spawn verified against a task in a
scratch project rather than a live one.

## Out of scope

- A global concurrency cap across projects. Worth revisiting once the real
  cost of six parallel sessions is observed.
- Pausing between stages of one task: `work` owns that loop, and taking it away
  from the skill would cost the thing that makes it good — knowing where to
  stop.
- Persisting the queue across restarts.

## Risks

- **CLI authentication.** Dispatch is dead until `claude auth login` is run,
  and auth can expire later. This is why authentication is an eligibility
  check with a visible reason rather than a silent failure.
- **The allowlist is the whole boundary.** A dispatched agent runs with the
  operator's shell privileges for anything the allowlist admits, and file tools
  reach any absolute path. Curating that allowlist is the actual prerequisite
  for this feature, not the buttons.

  The implementation plan must produce that list as its own task, not leave it
  implicit. It lives in each project's `.claude/settings.json` under
  `permissions.allow` (the mechanism the headless denial message itself points
  at), and the starting set is whatever `work` cannot run without: the
  project's test runner, `git status`, `git diff`, `git add`, `git commit`.
  Everything absent is denied, which ends the run — noisy, and far better than
  a run that quietly does more than it was asked to.
- **The installed plugin lags the repository.** It is registered at a commit
  (`b2a7729` while `HEAD` was further ahead), so a dispatched agent reads the
  plugin as installed, not as committed. `npm run plugin:reload` after changing
  plugin files.
- **Unverified:** whether the Fix button's `agy --sandbox` path has been
  silently writing to the scratch directory instead of the project. No
  `AGENTS.md` or `project-info.json` was found there, so it is a suspicion, not
  a finding.
