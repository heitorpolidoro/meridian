const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchEligibility } = require('../lib/dispatch-eligibility');

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
});

test('a live session in the repo refuses, naming the lock', () => {
    const out = dispatchEligibility(ok({ liveSession: { pid: 123, kind: 'background' } }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /already running/i);
});

test('authentication outranks the repo lock', () => {
    const out = dispatchEligibility(ok({ authenticated: false, liveSession: { pid: 1 } }));
    assert.match(out.reason, /not authenticated/i);
});

test('a task that left the board is refused by id', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-404' }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /T-404/);
});

test('done and nope are not dispatchable', () => {
    assert.match(dispatchEligibility(ok({ taskId: 'T-3' })).reason, /already done/i);
    assert.match(dispatchEligibility(ok({ taskId: 'T-4' })).reason, /dropped/i);
});

// The spec allows queueing a blocked task behind its blocker; this is the
// check that makes that safe, because it runs at pull time, not enqueue time.
test('an unmet blocker is refused, naming which one', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-2' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'T-2 still blocked by T-1');
});

test('a blocked task whose blocker reached done is eligible', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-5' })), { ok: true });
});

test('several unmet blockers are all named', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['A', 'B'] },
                   { id: 'A', status: 'backlog' }, { id: 'B', status: 'done' }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by A');
});

// A blocker id that is not on the board cannot be shown to be done, so it
// blocks. Treating an unknown id as satisfied would silently dispatch work
// whose dependency nobody can see.
test('a blocker that is not on the board still blocks', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['GHOST'] }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by GHOST');
});

test('spec_approval is dispatchable — the operator asked for it explicitly', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-6' })), { ok: true });
});

test('a missing or malformed board refuses rather than throwing', () => {
    assert.equal(dispatchEligibility(ok({ tasks: null })).ok, false);
    assert.equal(dispatchEligibility(ok({ tasks: 'nope' })).ok, false);
});
