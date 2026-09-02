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
    for (const s of ['backlog','spec_review','ready_todo','in_progress','code_review','qa_review','blocked']) {
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
