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
// A task that fails a check is discarded from the queue with this reason
// shown, not re-queued at the back: a task whose blocker never lands would
// spin forever, and re-enqueueing is one click.

const NOT_DISPATCHABLE = {
    done: id => `${id} is already done`,
    nope: id => `${id} was dropped`
};

function refuse(reason) {
    return { ok: false, reason };
}

function dispatchEligibility({ taskId, tasks, authenticated, liveSession }) {
    // First, because it applies to every task at once and has one remedy.
    if (!authenticated) {
        return refuse('CLI not authenticated — run `claude auth login`');
    }
    if (liveSession) {
        return refuse('a session is already running in this repository');
    }
    if (!Array.isArray(tasks)) {
        return refuse('the board could not be read');
    }

    const byId = new Map(tasks.map(t => [t && t.id, t]));
    const task = byId.get(taskId);
    if (!task) return refuse(`${taskId} is no longer on the board`);

    const gone = NOT_DISPATCHABLE[task.status];
    if (gone) return refuse(gone(taskId));

    // An id that is not on the board cannot be shown to be done, so it
    // blocks. Treating it as satisfied would dispatch work whose dependency
    // nobody can see.
    for (const blockerId of task.blockedBy || []) {
        const blocker = byId.get(blockerId);
        if (!blocker || blocker.status !== 'done') {
            return refuse(`${taskId} still blocked by ${blockerId}`);
        }
    }

    return { ok: true };
}

module.exports = { dispatchEligibility };
