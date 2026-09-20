const { test } = require('node:test');
const assert = require('node:assert/strict');
const { backgroundSessionFor } = require('../lib/dispatch-sessions');

const LIST = JSON.stringify([
    { pid: 1, cwd: '/ws/alpha', kind: 'interactive', sessionId: 'a', status: 'idle' },
    { pid: 2, cwd: '/ws/beta', kind: 'background', sessionId: 'b', status: 'busy' },
    { pid: 3, cwd: '/ws/beta/sub', kind: 'background', sessionId: 'c', status: 'busy' }
]);

test('a background session in the project is the lock', () => {
    assert.deepEqual(backgroundSessionFor(LIST, '/ws/beta'), { pid: 2, sessionId: 'b' });
});

// The operator's own terminal must not lock the board out of dispatching.
test('an interactive session is not a lock', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws/alpha'), null);
});

test('a project with no session at all is free', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws/gamma'), null);
});

// A session in a subdirectory is a different working tree as far as the lock
// is concerned; matching by prefix would lock a parent out of dispatching
// because something runs in one of its folders.
test('the cwd must match exactly, not by prefix', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws'), null);
});

test('a trailing slash on either side still matches', () => {
    assert.deepEqual(backgroundSessionFor(LIST, '/ws/beta/'), { pid: 2, sessionId: 'b' });
});

// The CLI being absent, erroring or printing a banner must read as "no
// session", never as a lock: an unreadable list would otherwise freeze
// dispatch permanently with no way to tell why.
test('unreadable output reads as no session rather than throwing', () => {
    for (const junk of ['', 'command not found', '{}', '[', null, undefined]) {
        assert.equal(backgroundSessionFor(junk, '/ws/beta'), null);
    }
});
