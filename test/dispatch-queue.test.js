const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createDispatchState, enqueue, dequeue, pullNext,
    queueFor, clearQueue, setAuto, isAuto
} = require('../lib/dispatch-queue');

const A = '/ws/alpha';
const B = '/ws/beta';

test('a fresh state has an empty queue and auto off for any project', () => {
    const s = createDispatchState();
    assert.deepEqual(queueFor(s, A), []);
    assert.equal(isAuto(s, A), false);
});

test('enqueue appends in click order and reports that it added', () => {
    const s = createDispatchState();
    assert.equal(enqueue(s, A, 'T-1'), true);
    assert.equal(enqueue(s, A, 'T-2'), true);
    assert.deepEqual(queueFor(s, A), ['T-1', 'T-2']);
});

// A double click must not queue the same task twice, which is what lets the
// card button be a plain toggle with no guard of its own.
test('enqueue is idempotent and says it added nothing', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    assert.equal(enqueue(s, A, 'T-1'), false);
    assert.deepEqual(queueFor(s, A), ['T-1']);
});

test('queues are per project and do not leak into each other', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    assert.deepEqual(queueFor(s, A), ['T-1']);
    assert.deepEqual(queueFor(s, B), ['T-9']);
});

test('dequeue removes one id and reports whether it was there', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(dequeue(s, A, 'T-1'), true);
    assert.deepEqual(queueFor(s, A), ['T-2']);
    assert.equal(dequeue(s, A, 'T-404'), false);
});

test('pullNext takes from the front and empties down to null', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(pullNext(s, A), 'T-1');
    assert.equal(pullNext(s, A), 'T-2');
    assert.equal(pullNext(s, A), null);
});

// The returned array must be a copy: the caller renders it and must not be
// able to mutate the queue by accident.
test('queueFor hands back a copy, not the live array', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    queueFor(s, A).push('T-INJECTED');
    assert.deepEqual(queueFor(s, A), ['T-1']);
});

test('clearQueue empties one project and leaves the other alone', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    clearQueue(s, A);
    assert.deepEqual(queueFor(s, A), []);
    assert.deepEqual(queueFor(s, B), ['T-9']);
});

test('auto is per project and toggles', () => {
    const s = createDispatchState();
    setAuto(s, A, true);
    assert.equal(isAuto(s, A), true);
    assert.equal(isAuto(s, B), false);
});

// "Stop queue" is named for what it does: it discards queued work rather than
// suspending it. A button that quietly kept the queue would be a trap.
test('turning auto off clears that project queue', () => {
    const s = createDispatchState();
    setAuto(s, A, true);
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    setAuto(s, A, false);
    assert.deepEqual(queueFor(s, A), []);
    assert.deepEqual(queueFor(s, B), ['T-9'], 'other projects untouched');
});

test('turning auto on does not disturb an existing queue', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    setAuto(s, A, true);
    assert.deepEqual(queueFor(s, A), ['T-1']);
});
