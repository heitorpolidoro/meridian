const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createDispatchState, enqueue, dequeue, pullNext, requeueFront,
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

// The runner cannot know whether a task may run until it has pulled it. When
// the refusal turns out to be about the machine rather than the task, the
// pull must be undone exactly, not approximated by enqueueing again — that
// would move the operator's first task to the back.
test('requeueFront undoes a pull, restoring the position', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(pullNext(s, A), 'T-1');
    assert.equal(requeueFront(s, A, 'T-1'), true);
    assert.deepEqual(queueFor(s, A), ['T-1', 'T-2']);
});

test('requeueFront on an empty queue leaves just that task', () => {
    const s = createDispatchState();
    assert.equal(requeueFront(s, A, 'T-1'), true);
    assert.deepEqual(queueFor(s, A), ['T-1']);
});

// Two passes racing to restore the same task must not queue it twice, the
// same guarantee enqueue gives a double click.
test('requeueFront is idempotent when the id is already queued', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(requeueFront(s, A, 'T-2'), false);
    assert.deepEqual(queueFor(s, A), ['T-1', 'T-2'], 'it did not move or duplicate');
});

test('requeueFront is per project like everything else here', () => {
    const s = createDispatchState();
    enqueue(s, B, 'T-9');
    requeueFront(s, A, 'T-1');
    assert.deepEqual(queueFor(s, A), ['T-1']);
    assert.deepEqual(queueFor(s, B), ['T-9']);
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
