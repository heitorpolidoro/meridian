const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchEligibility, NO_ALLOWLIST_REASON, selectAutoCandidate } = require('../lib/dispatch-eligibility');

const board = [
    { id: 'T-1', status: 'ready_todo' },
    { id: 'T-2', status: 'backlog', blockedBy: ['T-1'] },
    { id: 'T-3', status: 'done' },
    { id: 'T-4', status: 'nope' },
    { id: 'T-5', status: 'blocked', blockedBy: ['T-3'] },
    { id: 'T-6', status: 'spec_approval' }
];

const ok = (over = {}) => Object.assign(
    { taskId: 'T-1', tasks: board, authenticated: true, liveSession: null }, over);

test('a workable task on an authenticated CLI with a free repo is eligible', () => {
    assert.deepEqual(dispatchEligibility(ok()), { ok: true });
});

// Authentication is checked first because it is the one failure that applies
// to every task at once, and its remedy is a single command.
test('an unauthenticated CLI is refused with the command that fixes it', () => {
    const out = dispatchEligibility(ok({ authenticated: false }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /not authenticated/i);
    assert.match(out.reason, /claude auth login/);
    assert.equal(out.scope, 'environment');
});

test('a live session in the repo refuses, naming the lock', () => {
    const out = dispatchEligibility(ok({ liveSession: { pid: 123, kind: 'background' } }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /already running/i);
    assert.equal(out.scope, 'environment');
});

test('authentication outranks the repo lock', () => {
    const out = dispatchEligibility(ok({ authenticated: false, liveSession: { pid: 1 } }));
    assert.match(out.reason, /not authenticated/i);
});

// A missing allowlist means the worst possible shape: the run edits files
// under acceptEdits and is then denied at the test and commit steps,
// leaving unverified changes and no commit. Refusing before that starts.
test('a repository with no allowlist is refused', () => {
    const out = dispatchEligibility(ok({ allowlist: false }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, NO_ALLOWLIST_REASON);
    assert.equal(out.scope, 'environment');
});

test('a missing allowlist outranks the session lock', () => {
    const out = dispatchEligibility(ok({ allowlist: false, liveSession: { pid: 1 } }));
    assert.equal(out.reason, NO_ALLOWLIST_REASON);
});

test('authentication outranks a missing allowlist', () => {
    const out = dispatchEligibility(ok({ authenticated: false, allowlist: false }));
    assert.match(out.reason, /not authenticated/i);
});

test('an allowlist of true or absent changes nothing about existing behaviour', () => {
    assert.deepEqual(dispatchEligibility(ok({ allowlist: true })), { ok: true });
    assert.deepEqual(dispatchEligibility(ok()), { ok: true });
});

test('a task that left the board is refused by id', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-404' }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /T-404/);
    assert.equal(out.scope, 'task');
});

test('done and nope are not dispatchable', () => {
    assert.match(dispatchEligibility(ok({ taskId: 'T-3' })).reason, /already done/i);
    assert.match(dispatchEligibility(ok({ taskId: 'T-4' })).reason, /dropped/i);
    assert.equal(dispatchEligibility(ok({ taskId: 'T-3' })).scope, 'task');
    assert.equal(dispatchEligibility(ok({ taskId: 'T-4' })).scope, 'task');
});

// The spec allows queueing a blocked task behind its blocker; this is the
// check that makes that safe, because it runs at pull time, not enqueue time.
test('an unmet blocker is refused, naming which one', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-2' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'T-2 still blocked by T-1');
    assert.equal(out.scope, 'task');
});

test('a blocked task whose blocker reached done is eligible', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-5' })), { ok: true });
});

test('several unmet blockers are all named', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['A', 'B'] },
                   { id: 'A', status: 'backlog' }, { id: 'B', status: 'done' }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by A');
    assert.equal(out.scope, 'task');
});

// A blocker id that is not on the board cannot be shown to be done, so it
// blocks. Treating an unknown id as satisfied would silently dispatch work
// whose dependency nobody can see.
test('a blocker that is not on the board still blocks', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['GHOST'] }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by GHOST');
    assert.equal(out.scope, 'task');
});

test('spec_approval is dispatchable — the operator asked for it explicitly', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-6' })), { ok: true });
});

test('a missing or malformed board refuses rather than throwing', () => {
    assert.equal(dispatchEligibility(ok({ tasks: null })).ok, false);
    assert.equal(dispatchEligibility(ok({ tasks: 'nope' })).ok, false);
    assert.equal(dispatchEligibility(ok({ tasks: null })).scope, 'task');
});

// The whole point of the scope: an environment refusal is about the machine
// and lifts for the entire queue at once, so the runner keeps the queue. A
// task refusal is about that one task and may never lift, so it is
// discarded. Anything new must land on one side of this line deliberately.
test('authentication and the repo lock are environment; everything else is task', () => {
    const environment = [
        dispatchEligibility(ok({ authenticated: false })),
        dispatchEligibility(ok({ liveSession: { pid: 1 } })),
        dispatchEligibility(ok({ allowlist: false }))
    ];
    const task = [
        dispatchEligibility(ok({ tasks: null })),
        dispatchEligibility(ok({ taskId: 'T-404' })),
        dispatchEligibility(ok({ taskId: 'T-3' })),
        dispatchEligibility(ok({ taskId: 'T-4' })),
        dispatchEligibility(ok({ taskId: 'T-2' }))
    ];
    assert.deepEqual(environment.map(r => r.scope), ['environment', 'environment', 'environment']);
    assert.deepEqual(task.map(r => r.scope), ['task', 'task', 'task', 'task', 'task']);
});

// Success carries no scope: there is nothing to classify, and a caller that
// switches on scope must not find one on a verdict that passed.
test('an eligible task carries ok alone', () => {
    assert.deepEqual(Object.keys(dispatchEligibility(ok())), ['ok']);
});

// A task the operator is already working on in their own terminal carries
// `running: true` (the plugin's running-flag hook sets it). The derived repo
// lock ignores interactive sessions on purpose, so this check is the only
// thing standing between auto-dispatch and a second agent on the same task.
test('a task already being worked on is refused, task-scoped', () => {
    const tasks = [{ id: 'T-9', status: 'in_progress', running: true }];
    const out = dispatchEligibility(ok({ taskId: 'T-9', tasks }));
    assert.equal(out.ok, false);
    assert.equal(out.scope, 'task');
    assert.match(out.reason, /T-9/);
    assert.match(out.reason, /session/i);
});

// Only an explicit true claims the task. A cleared flag and a task that never
// carried one are the normal case and must not be punished — the hook clears
// `running` on SessionEnd, and most tasks have never been run at all.
test('running false and an absent running both stay dispatchable', () => {
    const cleared = [{ id: 'T-9', status: 'in_progress', running: false }];
    const never = [{ id: 'T-9', status: 'in_progress' }];
    assert.equal(dispatchEligibility(ok({ taskId: 'T-9', tasks: cleared })).ok, true);
    assert.equal(dispatchEligibility(ok({ taskId: 'T-9', tasks: never })).ok, true);
});

// --- selectAutoCandidate: the auto-dispatch loop's pure selection core ---
//
// This is the fix for the bug reported against a real board: auto-dispatch
// pulled one ineligible backlog task, refused it, and gave up rather than
// trying the other candidates behind it. These tests exercise the walk in
// isolation, with a fixed `candidates` list standing in for whatever
// workableTasks() would have produced — the ordering and filtering that
// produces that list is server.js's job, not this function's.

const selCtx = (over = {}) => Object.assign({ tasks: [], authenticated: true, liveSession: null }, over);

test('the first eligible candidate is picked with no refusals', () => {
    const board = [{ id: 'T-1', status: 'backlog' }];
    const out = selectAutoCandidate(board, selCtx({ tasks: board }));
    assert.deepEqual(out, { taskId: 'T-1', refusals: [], blocked: null });
});

// The exact bug: T-1 is blocked, T-2 and T-3 are not. The old rule ended the
// pass on T-1's refusal; this must walk past it to T-2.
test('a task-scoped refusal is skipped in favour of the next candidate', () => {
    const board = [
        { id: 'T-1', status: 'backlog', blockedBy: ['GHOST'] },
        { id: 'T-2', status: 'backlog' },
        { id: 'T-3', status: 'backlog' }
    ];
    const out = selectAutoCandidate(board, selCtx({ tasks: board }));
    assert.equal(out.taskId, 'T-2');
    assert.deepEqual(out.refusals, [{ taskId: 'T-1', reason: 'T-1 still blocked by GHOST' }]);
    assert.equal(out.blocked, null);
});

test('every refusal along the way is recorded, in order, when none are eligible', () => {
    const board = [
        { id: 'T-1', status: 'backlog', blockedBy: ['GHOST'] },
        { id: 'T-2', status: 'done' },
        { id: 'T-3', status: 'nope' }
    ];
    const out = selectAutoCandidate(board, selCtx({ tasks: board }));
    assert.equal(out.taskId, null);
    assert.equal(out.blocked, null);
    assert.deepEqual(out.refusals, [
        { taskId: 'T-1', reason: 'T-1 still blocked by GHOST' },
        { taskId: 'T-2', reason: 'T-2 is already done' },
        { taskId: 'T-3', reason: 'T-3 was dropped' }
    ]);
});

// An environment-scoped refusal applies identically to every candidate, so
// the walk stops at the first one rather than working through the rest —
// trying T-2 and T-3 would just repeat the same unauthenticated refusal.
test('an environment-scoped refusal stops the walk immediately', () => {
    const board = [
        { id: 'T-1', status: 'backlog' },
        { id: 'T-2', status: 'backlog' }
    ];
    const out = selectAutoCandidate(board, selCtx({ tasks: board, authenticated: false }));
    assert.equal(out.taskId, null);
    assert.deepEqual(out.refusals, []);
    assert.equal(out.blocked.taskId, 'T-1');
    assert.match(out.blocked.reason, /not authenticated/i);
});

test('an empty candidate list refuses nothing and selects nothing', () => {
    assert.deepEqual(selectAutoCandidate([], selCtx()), { taskId: null, refusals: [], blocked: null });
    assert.deepEqual(selectAutoCandidate(undefined, selCtx()), { taskId: null, refusals: [], blocked: null });
});

// Termination argument, made concrete: candidates is a fixed list and the
// walk consumes exactly one entry per non-eligible step (refused or
// blocked), so it cannot loop — a large candidate list all task-refused
// still finishes and names every one of them.
test('a long run of task-scoped refusals still terminates and names them all', () => {
    const board = Array.from({ length: 50 }, (_, i) => ({ id: `T-${i}`, status: 'done' }));
    const out = selectAutoCandidate(board, selCtx({ tasks: board }));
    assert.equal(out.taskId, null);
    assert.equal(out.refusals.length, 50);
    assert.equal(out.refusals[49].taskId, 'T-49');
});
