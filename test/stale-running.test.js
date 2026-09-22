const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRunningStale } = require('../lib/stale-running');

const PROJECT = '/tmp/fixture-project';

test('a task that is not running is never stale', () => {
    assert.equal(isRunningStale({ id: 'T-1', running: false }, { projectPath: PROJECT }), false);
    assert.equal(isRunningStale({ id: 'T-1' }, { projectPath: PROJECT }), false);
});

test('running true, no lock, no sessions: stale', () => {
    const task = { id: 'T-1', running: true };
    assert.equal(isRunningStale(task, { lock: null, sessions: [], projectPath: PROJECT }), true);
});

test('running true, no lock, sessions probe failed (null/undefined): stale', () => {
    const task = { id: 'T-1', running: true };
    assert.equal(isRunningStale(task, { lock: null, sessions: null, projectPath: PROJECT }), true);
    assert.equal(isRunningStale(task, { lock: null, sessions: undefined, projectPath: PROJECT }), true);
});

test('the dispatch lock naming this task claims it: not stale', () => {
    const task = { id: 'T-1', running: true };
    const lock = { pid: 1234, taskId: 'T-1' };
    assert.equal(isRunningStale(task, { lock, sessions: [], projectPath: PROJECT }), false);
});

test('a lock naming a different task in the same project does not claim this one', () => {
    const task = { id: 'T-1', running: true };
    const lock = { pid: 1234, taskId: 'T-2' };
    // No session either, so it still reads as stale.
    assert.equal(isRunningStale(task, { lock, sessions: [], projectPath: PROJECT }), true);
});

test('a busy session in the project blocks the stale verdict, regardless of kind', () => {
    const task = { id: 'T-1', running: true };
    const interactive = [{ pid: 1, kind: 'interactive', cwd: PROJECT, status: 'busy' }];
    const background = [{ pid: 2, kind: 'background', cwd: PROJECT, status: 'busy' }];
    assert.equal(isRunningStale(task, { lock: null, sessions: interactive, projectPath: PROJECT }), false,
        'a busy interactive session may be a human working the task by hand');
    assert.equal(isRunningStale(task, { lock: null, sessions: background, projectPath: PROJECT }), false);
});

test('an idle session in the project does not block the stale verdict', () => {
    // The operator keeps a Claude Desktop session parked in each project all
    // day. If merely existing counted, nothing would ever read as stale here.
    const task = { id: 'T-1', running: true };
    const idle = [{ pid: 1, kind: 'interactive', cwd: PROJECT, status: 'idle' }];
    assert.equal(isRunningStale(task, { lock: null, sessions: idle, projectPath: PROJECT }), true);
});

test('a session with no status reported counts as working', () => {
    // An older CLI that does not report `status` should lose the feature
    // rather than clear flags out from under a live run.
    const task = { id: 'T-1', running: true };
    const unknown = [{ pid: 1, kind: 'interactive', cwd: PROJECT }];
    assert.equal(isRunningStale(task, { lock: null, sessions: unknown, projectPath: PROJECT }), false);
});

test("the lock's own busy session does not block a different task's stale verdict", () => {
    // A dispatch this server started is a busy `interactive` session in the
    // list, already accounted for by the lock. Counting it again would let
    // one running dispatch suppress the verdict for every other task here.
    const task = { id: 'T-1', running: true };
    const lock = { pid: 32877, taskId: 'T-2' };
    const sessions = [{ pid: 32877, kind: 'interactive', cwd: PROJECT, status: 'busy' }];
    assert.equal(isRunningStale(task, { lock, sessions, projectPath: PROJECT }), true);

    // Another busy session beside it still blocks.
    const withHuman = sessions.concat([{ pid: 999, kind: 'interactive', cwd: PROJECT, status: 'busy' }]);
    assert.equal(isRunningStale(task, { lock, sessions: withHuman, projectPath: PROJECT }), false);
});

test('a live session in a different project does not block the stale verdict', () => {
    const task = { id: 'T-1', running: true };
    const elsewhere = [{ pid: 1, kind: 'interactive', cwd: '/tmp/some-other-project', status: 'busy' }];
    assert.equal(isRunningStale(task, { lock: null, sessions: elsewhere, projectPath: PROJECT }), true);
});

test('a trailing slash on either side of the cwd comparison still matches', () => {
    const task = { id: 'T-1', running: true };
    const sessions = [{ pid: 1, kind: 'interactive', cwd: PROJECT + '/', status: 'busy' }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: PROJECT }), false);
});

test('malformed session entries in the list are ignored, not thrown on', () => {
    const task = { id: 'T-1', running: true };
    const sessions = [null, 42, { pid: 1 }, { cwd: null }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: PROJECT }), true);
});

test('no projectPath given: never matches a session, so only the lock can save it from stale', () => {
    const task = { id: 'T-1', running: true };
    const sessions = [{ pid: 1, kind: 'interactive', cwd: PROJECT, status: 'busy' }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: undefined }), true);
});
