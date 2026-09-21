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

module.exports = { dispatchEligibility, NO_ALLOWLIST_REASON };
