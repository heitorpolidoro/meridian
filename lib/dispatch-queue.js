'use strict';

// The dispatch queue and the auto flag, per project, in memory.
//
// Nothing here is persisted, deliberately. A server that is down dispatches
// nothing, so there is nothing for persistence to protect — and a flag that
// outlives the thing it describes is exactly the orphaned `running` bug this
// codebase already had to write a hook to clean up. A restart clears both and
// the board shows that truthfully.
//
// No `queued` field is written to the task either: the queue is already
// authoritative here, and writing one would touch tasks.jsonl, fire fs.watch
// and rebuild the board once per enqueue for a change nobody asked for.

function createDispatchState() {
    return { queues: new Map(), auto: new Map() };
}

function listFor(state, projectPath) {
    if (!state.queues.has(projectPath)) state.queues.set(projectPath, []);
    return state.queues.get(projectPath);
}

// Returns whether it added. Idempotent: a double click cannot queue twice.
function enqueue(state, projectPath, taskId) {
    const list = listFor(state, projectPath);
    if (list.includes(taskId)) return false;
    list.push(taskId);
    return true;
}

function dequeue(state, projectPath, taskId) {
    const list = listFor(state, projectPath);
    const at = list.indexOf(taskId);
    if (at === -1) return false;
    list.splice(at, 1);
    return true;
}

function pullNext(state, projectPath) {
    const list = listFor(state, projectPath);
    return list.length === 0 ? null : list.shift();
}

// Puts a pulled task back where it was. The runner has to pull before it can
// know whether the task may run, and an environment-level refusal — a logged
// out CLI, a session already holding the repo — is no reason to lose the
// task or to send it to the back of a queue the operator ordered on purpose.
// Idempotent, like enqueue: a task already in the queue stays where it is,
// so a double restore cannot duplicate it.
function requeueFront(state, projectPath, taskId) {
    const list = listFor(state, projectPath);
    if (list.includes(taskId)) return false;
    list.unshift(taskId);
    return true;
}

// A copy: callers render this, and a caller that mutates it would be editing
// the queue by accident.
function queueFor(state, projectPath) {
    return listFor(state, projectPath).slice();
}

function clearQueue(state, projectPath) {
    state.queues.set(projectPath, []);
}

// Disabling clears the queue. `Stop queue` discards rather than suspends —
// see the comment on the matching test.
function setAuto(state, projectPath, enabled) {
    state.auto.set(projectPath, Boolean(enabled));
    if (!enabled) clearQueue(state, projectPath);
}

function isAuto(state, projectPath) {
    return state.auto.get(projectPath) === true;
}

module.exports = {
    createDispatchState, enqueue, dequeue, pullNext, requeueFront,
    queueFor, clearQueue, setAuto, isAuto
};
