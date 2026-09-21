'use strict';

// May this task be dispatched right now, and if not, what does the operator
// need to read?
//
// Checked when pulling from the queue, never when enqueuing: a task can sit
// in the queue for minutes, and its blocker can land or its status can move
// in that time. That re-check is also what makes it safe to queue a `blocked`
// task behind its blocker — being earlier in the queue is not a guarantee the
// blocker reached `done`, since `work` stops at human gates and QA can send a
// task back.
//
// A task that fails a TASK-scoped check is discarded from the queue with
// this reason shown, not re-queued at the back: a task whose blocker never
// lands would spin forever, and re-enqueueing is one click. That argument
// only holds for conditions belonging to the task, which is why every
// refusal now carries a scope — see the comment on refuse() below.

const NOT_DISPATCHABLE = {
    done: id => `${id} is already done`,
    nope: id => `${id} was dropped`
};

// Every refusal says which kind it is, because the caller must treat them
// differently. A 'task' refusal is a property of that one task and may never
// resolve, so the task is discarded with the reason shown. An 'environment'
// refusal is a property of the machine — it applies identically to every
// task in the queue, says nothing about any of them, and resolves globally
// the moment the operator logs in or the running session ends. The caller
// must not punish a queue the operator deliberately built for one of those:
// see the runner in server.js, which keeps the queue intact and simply ends
// the pass.
function refuse(reason, scope) {
    return { ok: false, reason, scope };
}

// Shared with the /api/status payload (server.js) so the board shows the
// exact same sentence this refusal carries, rather than a second copy that
// could drift from it.
const NO_ALLOWLIST_REASON = 'this repository has no dispatch allowlist — '
    + 'an agent would edit files and then be denied at the test and commit steps';

function dispatchEligibility({ taskId, tasks, authenticated, liveSession, allowlist }) {
    // First, because it applies to every task at once and has one remedy.
    // Environment, not task: `claude auth login` fixes it for the whole
    // queue at once.
    if (!authenticated) {
        return refuse('CLI not authenticated — run `claude auth login`', 'environment');
    }
    // Also environment, and checked before the session lock: an
    // unauthenticated CLI is the more fundamental problem, but a missing
    // allowlist is worth knowing before waiting on a lock that may take a
    // while to lift. `allowlist` is a fixed property of the repository —
    // true or absent (every existing caller) changes nothing here; only an
    // explicit false, meaning no `.claude/settings.json` with a non-empty
    // `permissions.allow`, refuses.
    if (allowlist === false) {
        return refuse(NO_ALLOWLIST_REASON, 'environment');
    }
    // Also environment: the lock belongs to the repository, and it lifts by
    // itself when that session ends. Nothing about this task is wrong.
    if (liveSession) {
        return refuse('a session is already running in this repository', 'environment');
    }
    // Task-scoped from here down: everything below is a statement about this
    // particular task, or about a board that cannot answer for it.
    if (!Array.isArray(tasks)) {
        return refuse('the board could not be read', 'task');
    }

    const byId = new Map(tasks.map(t => [t && t.id, t]));
    const task = byId.get(taskId);
    if (!task) return refuse(`${taskId} is no longer on the board`, 'task');

    const gone = NOT_DISPATCHABLE[task.status];
    if (gone) return refuse(gone(taskId), 'task');

    // Separate from the repository lock above, and deliberately so. That lock
    // is about processes: is anything holding this repo right now. This is
    // about the task's own claim: someone has already picked it up. The
    // plugin's running-flag hook sets `running` from the operator's own
    // interactive session — the very session the derived lock ignores on
    // purpose — so without this check `in_progress` (a workable status) plus
    // auto-dispatch is enough to spawn a second agent onto a task a human is
    // already editing files for. Task-scoped: it says something about this
    // one task, and the remedy is that session ending, not a machine-wide fix.
    if (task.running === true) {
        return refuse(`${taskId} is already being worked on by a live session`, 'task');
    }

    // An id that is not on the board cannot be shown to be done, so it
    // blocks. Treating it as satisfied would dispatch work whose dependency
    // nobody can see.
    for (const blockerId of task.blockedBy || []) {
        const blocker = byId.get(blockerId);
        if (!blocker || blocker.status !== 'done') {
            return refuse(`${taskId} still blocked by ${blockerId}`, 'task');
        }
    }

    return { ok: true };
}

// The auto-dispatch loop's selection core, pulled out so it can be tested
// without spawning anything: `candidates` is a list of tasks already ordered
// and filtered the way server.js's workableTasks() (minus skip_auto_dispatch)
// produces it — this function does not need to know about board columns or
// priority to make its decision.
//
// Walks the list in order, refusing each candidate through
// dispatchEligibility until one is accepted or the list runs out. This is
// what makes the old rule ("an auto-pulled refusal ends the pass") wrong:
// ending on the first task-scoped refusal meant auto mode gave up before
// ever looking at an eligible task sitting right behind it. Walking forward
// instead is safe precisely because `candidates` is a fixed, finite list —
// each step either accepts, hits an environment refusal (stop: see below),
// or consumes one candidate — so this terminates in at most
// candidates.length steps.
//
// An environment-scoped refusal (CLI not authenticated, repo busy, no
// allowlist) stops the walk immediately rather than being skipped like a
// task-scoped one: it is a property of the machine, so it would refuse
// every remaining candidate the same way, and trying them is pointless
// work. It is returned as `blocked` rather than folded into `refusals`,
// because the caller (dispatchOnePass in server.js) must requeue a
// queue-sourced task on this scope and must not on the other.
function selectAutoCandidate(candidates, { tasks, authenticated, liveSession, allowlist }) {
    const refusals = [];
    for (const candidate of candidates || []) {
        const verdict = dispatchEligibility({ taskId: candidate.id, tasks, authenticated, liveSession, allowlist });
        if (verdict.ok) return { taskId: candidate.id, refusals, blocked: null };
        if (verdict.scope === 'environment') {
            return { taskId: null, refusals, blocked: { taskId: candidate.id, reason: verdict.reason } };
        }
        refusals.push({ taskId: candidate.id, reason: verdict.reason });
    }
    return { taskId: null, refusals, blocked: null };
}

module.exports = { dispatchEligibility, NO_ALLOWLIST_REASON, selectAutoCandidate };
