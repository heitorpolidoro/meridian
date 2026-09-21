const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRecentlyCompleted } = require('../lib/board');

const NOW = new Date('2026-08-27T12:00:00.000Z');

test('a task completed today is recent', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-27T09:00:00.000Z' }, 7, NOW), true);
});

test('a task completed inside the window is recent', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-22T12:00:00.000Z' }, 7, NOW), true);
});

test('a task completed outside the window is not', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-01T12:00:00.000Z' }, 7, NOW), false);
});

test('a null completed_at counts as old', () => {
    assert.equal(isRecentlyCompleted({ completed_at: null }, 7, NOW), false);
});

test('a missing completed_at counts as old', () => {
    assert.equal(isRecentlyCompleted({}, 7, NOW), false);
});

test('an unparseable completed_at counts as old rather than throwing', () => {
    assert.equal(isRecentlyCompleted({ completed_at: 'not a date' }, 7, NOW), false);
});

test('a null window means show everything', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2020-01-01T00:00:00.000Z' }, null, NOW), true);
});

// --- manual transitions offered by the board ---

const { manualTransition } = require('../lib/board');

test('a task in any working status may be noped', () => {
    for (const s of ['backlog','spec_review','spec_approval','ready_todo','in_progress','code_review','qa_review','blocked']) {
        assert.deepEqual(manualTransition(s), { to: 'nope', label: 'Nope' }, `failed for ${s}`);
    }
});

test('a noped task may be reopened into backlog', () => {
    assert.deepEqual(manualTransition('nope'), { to: 'backlog', label: 'Reopen' });
});

test('a done task offers no manual transition', () => {
    assert.equal(manualTransition('done'), null);
});

test('an unknown status offers no manual transition', () => {
    assert.equal(manualTransition('in progress'), null);
    assert.equal(manualTransition(undefined), null);
});

// --- the nope column shares the done column's window, keyed on moved_at ---

const { isRecentlyDismissed } = require('../lib/board');

test('a task noped today is recent', () => {
    assert.equal(isRecentlyDismissed({ moved_at: '2026-08-27T09:00:00.000Z' }, 7, NOW), true);
});

test('a task noped outside the window is not', () => {
    assert.equal(isRecentlyDismissed({ moved_at: '2026-08-01T12:00:00.000Z' }, 7, NOW), false);
});

test('a missing moved_at counts as old', () => {
    assert.equal(isRecentlyDismissed({}, 7, NOW), false);
});

test('an unparseable moved_at counts as old rather than throwing', () => {
    assert.equal(isRecentlyDismissed({ moved_at: 'not a date' }, 7, NOW), false);
});

test('a null window shows every noped task', () => {
    assert.equal(isRecentlyDismissed({ moved_at: '2020-01-01T00:00:00.000Z' }, null, NOW), true);
});

// --- terminal columns sort by recency, not by id ---

const { byRecencyDesc } = require('../lib/board');

test('done sorts by completed_at descending, not by id', () => {
    const tasks = [
        { id: 'T-9', completed_at: '2026-08-01T00:00:00.000Z' },
        { id: 'T-2', completed_at: '2026-08-30T00:00:00.000Z' },
        { id: 'T-5', completed_at: '2026-08-15T00:00:00.000Z' }
    ];
    assert.deepEqual(tasks.sort(byRecencyDesc('completed_at')).map(t => t.id),
        ['T-2', 'T-5', 'T-9'], 'the old task finished most recently comes first');
});

test('tasks without the timestamp sink to the bottom', () => {
    const tasks = [
        { id: 'T-1' },
        { id: 'T-2', completed_at: '2026-08-30T00:00:00.000Z' },
        { id: 'T-3', completed_at: null }
    ];
    const ids = tasks.sort(byRecencyDesc('completed_at')).map(t => t.id);
    assert.equal(ids[0], 'T-2');
    assert.deepEqual(new Set(ids.slice(1)), new Set(['T-1', 'T-3']));
});

test('the same comparator serves nope via moved_at', () => {
    const tasks = [
        { id: 'T-4', moved_at: '2026-08-10T00:00:00.000Z' },
        { id: 'T-8', moved_at: '2026-08-29T00:00:00.000Z' }
    ];
    assert.deepEqual(tasks.sort(byRecencyDesc('moved_at')).map(t => t.id), ['T-8', 'T-4']);
});

// --- empty columns collapse into rails ---
// `count` is the total number of tasks in the status, never the done/nope
// windowed count. A rail is a status with nothing in it at all.

const { collapsedColumns } = require('../lib/board');

test('an empty column collapses', () => {
    assert.deepEqual(collapsedColumns([{ id: 'backlog', count: 0 }], new Set()), new Set(['backlog']));
});

test('an empty column the operator expanded this session stays open', () => {
    assert.deepEqual(collapsedColumns([{ id: 'backlog', count: 0 }], new Set(['backlog'])), new Set());
});

test('a column with tasks never collapses, expanded or not', () => {
    assert.deepEqual(collapsedColumns([{ id: 'in_progress', count: 2 }], new Set(['in_progress'])), new Set());
    assert.deepEqual(collapsedColumns([{ id: 'in_progress', count: 2 }], new Set()), new Set());
});

test('a done column with tasks is not a rail even if the window hides them all', () => {
    // These three tasks may all be older than the done window, so the column
    // header would read 0 and a "+3 concluídas" chip would show. The window is
    // irrelevant here: count is the total in the status, and 3 > 0.
    assert.deepEqual(collapsedColumns([{ id: 'done', count: 3 }], new Set()), new Set());
});

test('no columns means nothing to collapse', () => {
    assert.deepEqual(collapsedColumns([], new Set()), new Set());
});

test('a mixed board collapses exactly its empty statuses', () => {
    const columns = [
        { id: 'backlog', count: 0 },
        { id: 'ready_todo', count: 1 },
        { id: 'done', count: 0 },
        { id: 'nope', count: 4 }
    ];
    assert.deepEqual(collapsedColumns(columns, new Set()), new Set(['backlog', 'done']));
});

test('a missing expanded set is treated as empty', () => {
    assert.deepEqual(collapsedColumns([{ id: 'qa_review', count: 0 }]), new Set(['qa_review']));
});

// --- sub-task derivation: children, progress, badge ---

const { childrenOf, subtaskProgress, parentBadge } = require('../lib/board');

test('childrenOf returns every task whose parent matches the given task\'s id', () => {
    const parentTask = { id: 'T-1' };
    const tasks = [
        parentTask,
        { id: 'T-2', parent: 'T-1' },
        { id: 'T-3', parent: 'T-1' },
        { id: 'T-4', parent: 'T-9' }
    ];
    assert.deepEqual(childrenOf(tasks, parentTask).map(t => t.id), ['T-2', 'T-3']);
});

test('childrenOf excludes a same-id task from a different projectPath', () => {
    const parentTask = { id: 'T-1', projectPath: '/proj/a' };
    const tasks = [
        parentTask,
        { id: 'T-2', parent: 'T-1', projectPath: '/proj/a' },
        { id: 'T-2', parent: 'T-1', projectPath: '/proj/b' }
    ];
    const children = childrenOf(tasks, parentTask);
    assert.equal(children.length, 1);
    assert.equal(children[0].projectPath, '/proj/a');
});

test('subtaskProgress returns null for a task with no children', () => {
    const parentTask = { id: 'T-1' };
    assert.equal(subtaskProgress([parentTask], parentTask), null);
});

test('subtaskProgress returns { done, total } counting children whose status is done', () => {
    const parentTask = { id: 'T-1' };
    const tasks = [
        parentTask,
        { id: 'T-2', parent: 'T-1', status: 'done' },
        { id: 'T-3', parent: 'T-1', status: 'in_progress' },
        { id: 'T-4', parent: 'T-1', status: 'done' }
    ];
    assert.deepEqual(subtaskProgress(tasks, parentTask), { done: 2, total: 3 });
});

test('parentBadge returns null for a task without a parent', () => {
    assert.equal(parentBadge({ id: 'T-1' }), null);
});

test('parentBadge returns ↳ <id> for a task with a parent', () => {
    assert.equal(parentBadge({ id: 'T-2', parent: 'T-1' }), '↳ T-1');
});

// --- the card's tri-state dispatch button ---

const { dispatchButton } = require('../lib/board');

test('a task that is neither queued nor running offers dispatch', () => {
    const out = dispatchButton({ id: 'T-1', status: 'ready_todo' }, { queue: [], runningTaskId: null });
    assert.equal(out.action, 'dispatch');
    assert.match(out.label, /dispatch/i);
});

test('the running task offers stop', () => {
    const out = dispatchButton({ id: 'T-1', status: 'in_progress' }, { queue: [], runningTaskId: 'T-1' });
    assert.equal(out.action, 'stop');
    assert.match(out.label, /stop/i);
});

test('a queued task offers removal from the queue', () => {
    const out = dispatchButton({ id: 'T-2', status: 'backlog' }, { queue: ['T-2'], runningTaskId: 'T-1' });
    assert.equal(out.action, 'unqueue');
    assert.match(out.label, /queue/i);
});

// Running outranks queued: a task cannot be both, and if the state is ever
// inconsistent the honest button is the one that can stop the process.
test('running wins over queued', () => {
    const out = dispatchButton({ id: 'T-1' }, { queue: ['T-1'], runningTaskId: 'T-1' });
    assert.equal(out.action, 'stop');
});

// Terminal tasks have nothing to dispatch, and a button there is noise on a
// board with dozens of finished cards.
test('done and nope carry no button', () => {
    assert.equal(dispatchButton({ id: 'T-3', status: 'done' }, { queue: [], runningTaskId: null }), null);
    assert.equal(dispatchButton({ id: 'T-4', status: 'nope' }, { queue: [], runningTaskId: null }), null);
});

// The header's `Dispatch all` has always been disabled on a repository with
// no allowlist. The card button ignored the same gate: it rendered enabled,
// the confirmation promised a real run, the POST succeeded and the task then
// sat queued forever showing "waiting". Both controls now read one field.
test('a closed gate disables dispatch and puts the reason in the title', () => {
    const out = dispatchButton({ id: 'T-1', status: 'ready_todo' }, {
        queue: [], runningTaskId: null,
        dispatchGateBlocked: true,
        dispatchBlockedReason: 'this repository has no dispatch allowlist'
    });
    assert.equal(out.action, 'dispatch');
    assert.equal(out.disabled, true);
    assert.equal(out.title, 'this repository has no dispatch allowlist');
});

// The gate is a boolean of its own precisely so an in-flight run — which
// dispatchBlockedReason also reports — cannot disable the button. Queueing
// work behind a running task is what the queue is for.
test('a run in flight does not disable dispatch', () => {
    const out = dispatchButton({ id: 'T-2', status: 'ready_todo' }, {
        queue: [], runningTaskId: 'T-1',
        dispatchGateBlocked: false,
        dispatchBlockedReason: 'a run is in flight (T-1)'
    });
    assert.equal(out.action, 'dispatch');
    assert.equal(out.disabled, undefined);
});

// Both of these reduce activity, so a closed gate must not take them away:
// an operator who cannot start a run must still be able to stop one and to
// empty the queue.
test('stop and unqueue stay enabled through a closed gate', () => {
    const ctx = { dispatchGateBlocked: true, dispatchBlockedReason: 'no allowlist' };
    const stop = dispatchButton({ id: 'T-1' }, { ...ctx, queue: [], runningTaskId: 'T-1' });
    const unqueue = dispatchButton({ id: 'T-2' }, { ...ctx, queue: ['T-2'], runningTaskId: 'T-1' });
    assert.equal(stop.action, 'stop');
    assert.equal(stop.disabled, undefined);
    assert.equal(unqueue.action, 'unqueue');
    assert.equal(unqueue.disabled, undefined);
});

// An absent field is an open gate: every existing caller passes no such key,
// and a missing one must not silently disable every card on the board.
test('an absent gate field leaves dispatch enabled', () => {
    const out = dispatchButton({ id: 'T-1', status: 'ready_todo' }, { queue: [], runningTaskId: null });
    assert.equal(out.disabled, undefined);
});

// --- why a queued task is not moving ---
// A refusal scoped to the environment (no allowlist, CLI logged out, a
// session already holding the repo) requeues the task rather than dropping
// it, so the card must say why it is stuck rather than just sitting there.

const { queueStallReason } = require('../lib/board');

test('no lastRun and no project reason: nothing is known to be stuck', () => {
    assert.equal(queueStallReason({ id: 'T-1' }, {}), null);
});

test('the project-wide dispatchBlockedReason explains a stalled queue', () => {
    const reason = queueStallReason({ id: 'T-1' }, {
        dispatchBlockedReason: 'this repository has no dispatch allowlist'
    });
    assert.equal(reason, 'this repository has no dispatch allowlist');
});

// lastRun pins a reason to the exact task it happened to, which is more
// specific than the project-wide reason, so it wins when both exist.
test('a failed lastRun for this task wins over the project-wide reason', () => {
    const reason = queueStallReason({ id: 'T-1' }, {
        dispatchBlockedReason: 'this repository has no dispatch allowlist',
        lastRun: { taskId: 'T-1', ok: false, reason: 'CLI not authenticated — run `claude auth login`' }
    });
    assert.equal(reason, 'CLI not authenticated — run `claude auth login`');
});

// lastRun for a different task says nothing about this one.
test('a lastRun for a different task is ignored', () => {
    const reason = queueStallReason({ id: 'T-2' }, {
        dispatchBlockedReason: 'this repository has no dispatch allowlist',
        lastRun: { taskId: 'T-1', ok: false, reason: 'something else entirely' }
    });
    assert.equal(reason, 'this repository has no dispatch allowlist');
});

// A successful lastRun is not a stall — it says nothing about why a later
// queued task might be waiting.
test('a successful lastRun for this task is not treated as a stall reason', () => {
    const reason = queueStallReason({ id: 'T-1' }, {
        lastRun: { taskId: 'T-1', ok: true, reason: null }
    });
    assert.equal(reason, null);
});

// A single auto-dispatch pass can refuse several candidates before finding
// one it can run, or before giving up (see selectAutoCandidate in
// lib/dispatch-eligibility.js and dispatchOnePass in server.js). lastRun's
// own taskId/reason hold only the last of them; `refusals` is where the rest
// survive so an earlier-refused task's card can still find its own reason.
test('a task named only in lastRun.refusals still finds its reason', () => {
    const reason = queueStallReason({ id: 'T-1' }, {
        lastRun: {
            taskId: 'T-3', ok: false, reason: 'T-3 still blocked by T-9',
            refusals: [
                { taskId: 'T-1', reason: 'T-1 is already done' },
                { taskId: 'T-3', reason: 'T-3 still blocked by T-9' }
            ]
        }
    });
    assert.equal(reason, 'T-1 is already done');
});

// The direct lastRun match still wins over the refusals list when both name
// the same task — there is nothing to fall back to for.
test('the direct lastRun match is tried before the refusals list', () => {
    const reason = queueStallReason({ id: 'T-3' }, {
        lastRun: {
            taskId: 'T-3', ok: false, reason: 'T-3 still blocked by T-9',
            refusals: [{ taskId: 'T-3', reason: 'a different, stale reason' }]
        }
    });
    assert.equal(reason, 'T-3 still blocked by T-9');
});

// A task named in neither lastRun nor its refusals falls back to the
// project-wide reason, same as when there is no refusals list at all.
test('a task absent from both lastRun and refusals falls back to the project reason', () => {
    const reason = queueStallReason({ id: 'T-7' }, {
        dispatchBlockedReason: 'this repository has no dispatch allowlist',
        lastRun: { taskId: 'T-3', ok: false, reason: 'x', refusals: [{ taskId: 'T-1', reason: 'y' }] }
    });
    assert.equal(reason, 'this repository has no dispatch allowlist');
});
