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
