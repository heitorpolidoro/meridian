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

// --- the recorded session: the evidence that does not need a guess ---

test('a recorded session still in the live list is not stale, even when idle', () => {
    // The whole point. An operator's session between turns reads `idle`, and
    // the heuristic below would call this stale; the recorded id knows better.
    const task = { id: 'T-1', running: true, running_session: 'sess-abc', running_agent: 'claude' };
    const sessions = [{ pid: 1, kind: 'interactive', cwd: PROJECT, status: 'idle', sessionId: 'sess-abc' }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: PROJECT }), false);
});

test('a recorded session gone from the live list is stale', () => {
    // The owner is part of what makes this answerable: see the harness tests
    // at the end of this file.
    const task = { id: 'T-1', running: true, running_session: 'sess-abc', running_agent: 'claude' };
    const sessions = [{ pid: 2, kind: 'interactive', cwd: PROJECT, status: 'busy', sessionId: 'sess-other' }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: PROJECT }), true,
        'nothing left that could ever clear the flag');
});

test('a recorded session is matched by id alone, not by directory', () => {
    // A session id is unique; where it is running is irrelevant to whether it
    // exists. A worktree or a subdirectory must not read as a dead session.
    const task = { id: 'T-1', running: true, running_session: 'sess-abc', running_agent: 'claude' };
    const sessions = [{ pid: 1, cwd: '/tmp/some-other-project', status: 'busy', sessionId: 'sess-abc' }];
    assert.equal(isRunningStale(task, { lock: null, sessions, projectPath: PROJECT }), false);
});

test('a recorded session with a failed probe (null) is never stale', () => {
    // A probe that cannot see a session is not evidence the session ended.
    const task = { id: 'T-1', running: true, running_session: 'sess-abc', running_agent: 'claude' };
    assert.equal(isRunningStale(task, { lock: null, sessions: null, projectPath: PROJECT }), false);
    assert.equal(isRunningStale(task, { lock: null, sessions: undefined, projectPath: PROJECT }), false);
});

test('an empty live list is a real answer: the recorded session is gone', () => {
    const task = { id: 'T-1', running: true, running_session: 'sess-abc', running_agent: 'claude' };
    assert.equal(isRunningStale(task, { lock: null, sessions: [], projectPath: PROJECT }), true);
});

test('the dispatch lock still outranks the recorded session', () => {
    const task = { id: 'T-1', running: true, running_session: 'sess-gone', running_agent: 'claude' };
    const lock = { pid: 1234, taskId: 'T-1' };
    assert.equal(isRunningStale(task, { lock, sessions: [], projectPath: PROJECT }), false);
});

test('an empty or non-string running_session falls back to the heuristic', () => {
    const busy = [{ pid: 1, kind: 'interactive', cwd: PROJECT, status: 'busy' }];
    assert.equal(isRunningStale({ id: 'T-1', running: true, running_session: '' },
        { lock: null, sessions: busy, projectPath: PROJECT }), false, 'heuristic: busy session blocks');
    assert.equal(isRunningStale({ id: 'T-1', running: true, running_session: 42 },
        { lock: null, sessions: [], projectPath: PROJECT }), true, 'heuristic: nothing live');
});

// --- other AI tools: a flag this cannot see is never called stale ---

test('a flag owned by a harness with no session list is never stale', () => {
    // `sessions` is `claude agents --json` and only ever that. An
    // Antigravity conversation id cannot appear in it, and `agy` offers no
    // list of its own, so checking one against the other answers "gone" for
    // work that is running. A real task Antigravity was working carried the
    // stale badge and its Clear button because of exactly this.
    const task = { id: 'A-75', running: true, running_session: 'fe6cd5de', running_agent: 'agy' };
    assert.equal(isRunningStale(task, { lock: null, sessions: [], projectPath: PROJECT }), false);
    assert.equal(isRunningStale(task, {
        lock: null, projectPath: PROJECT,
        sessions: [{ pid: 1, cwd: PROJECT, status: 'busy', sessionId: 'something-else' }]
    }), false, 'not even a busy Claude session in the same directory makes it judgeable');
});

test('an unknown harness name is treated the same as agy', () => {
    // Whatever arrives here that is not `claude` is something this cannot
    // enumerate. The safe answer is the same one.
    const task = { id: 'A-1', running: true, running_session: 's', running_agent: 'some-future-cli' };
    assert.equal(isRunningStale(task, { lock: null, sessions: [], projectPath: PROJECT }), false);
});

test('claude keeps the precise verdict', () => {
    const live = [{ pid: 1, cwd: PROJECT, status: 'idle', sessionId: 'sess-abc' }];
    assert.equal(isRunningStale(
        { id: 'A-1', running: true, running_session: 'sess-abc', running_agent: 'claude' },
        { lock: null, sessions: live, projectPath: PROJECT }), false);
    assert.equal(isRunningStale(
        { id: 'A-2', running: true, running_session: 'sess-gone', running_agent: 'claude' },
        { lock: null, sessions: live, projectPath: PROJECT }), true);
});

test('a session id with no owner recorded is unverifiable, so not stale', () => {
    // Written before running_agent existed: which list to look in is
    // unknown, and unverifiable reads the same as unenumerable.
    const task = { id: 'A-1', running: true, running_session: 'sess-gone' };
    assert.equal(isRunningStale(task, { lock: null, sessions: [], projectPath: PROJECT }), false);
});

test('no session id at all still falls back to the heuristic', () => {
    // An owner alone changes nothing: without an id there is nothing to look
    // up, and the directory heuristic is all that is left.
    const busy = [{ pid: 1, cwd: PROJECT, status: 'busy' }];
    assert.equal(isRunningStale({ id: 'A-1', running: true, running_agent: 'claude' },
        { lock: null, sessions: busy, projectPath: PROJECT }), false);
    assert.equal(isRunningStale({ id: 'A-1', running: true, running_agent: 'claude' },
        { lock: null, sessions: [], projectPath: PROJECT }), true);
});

test('the dispatch lock still outranks an unenumerable owner', () => {
    const task = { id: 'A-1', running: true, running_session: 'x', running_agent: 'agy' };
    assert.equal(isRunningStale(task, { lock: { pid: 1, taskId: 'A-1' }, sessions: [], projectPath: PROJECT }), false);
});

// --- unverifiable: the honest middle ground for another AI tool ---

const { unverifiableRunning, QUIET_MS } = require('../lib/stale-running');
const AGO = ms => new Date(Date.now() - ms).toISOString();

test('an agy flag quiet for over two hours is reported as unverifiable', () => {
    const task = { id: 'A-75', running: true, running_agent: 'agy', updated_at: AGO(3 * 60 * 60 * 1000) };
    const res = unverifiableRunning(task);
    assert.equal(res.agent, 'agy');
    assert.ok(res.quietFor >= QUIET_MS);
});

test('a fresh agy flag is left alone', () => {
    // Silence is right for the first hours: the work is probably in flight.
    const task = { id: 'A-75', running: true, running_agent: 'agy', updated_at: AGO(90 * 60 * 1000) };
    assert.equal(unverifiableRunning(task), null);
});

test('any write resets the quiet clock', () => {
    const task = { id: 'A-75', running: true, running_agent: 'agy', updated_at: AGO(30 * 1000) };
    assert.equal(unverifiableRunning(task), null);
});

test('claude is never unverifiable — it gets a real verdict instead', () => {
    const task = { id: 'A-1', running: true, running_agent: 'claude', updated_at: AGO(10 * 60 * 60 * 1000) };
    assert.equal(unverifiableRunning(task), null);
});

test('a flag with no owner recorded is not reported either', () => {
    // Which harness it belongs to is unknown, so naming one would be a guess.
    assert.equal(unverifiableRunning({ id: 'A-1', running: true, updated_at: AGO(10 * 60 * 60 * 1000) }), null);
});

test('a task that is not running is never unverifiable', () => {
    assert.equal(unverifiableRunning({ id: 'A-1', running: false, running_agent: 'agy', updated_at: AGO(99e6) }), null);
});

test('an unreadable timestamp yields nothing, not a made-up age', () => {
    // A fabricated age would put a Clear button under live work.
    for (const updated_at of [undefined, null, '', 'not a date']) {
        assert.equal(unverifiableRunning({ id: 'A-1', running: true, running_agent: 'agy', updated_at }), null,
            `updated_at ${JSON.stringify(updated_at)}`);
    }
});

test('the threshold is exactly two hours', () => {
    assert.equal(QUIET_MS, 2 * 60 * 60 * 1000);
    const at = ms => unverifiableRunning(
        { id: 'A-1', running: true, running_agent: 'agy', updated_at: AGO(ms) });
    assert.equal(at(QUIET_MS - 1000), null);
    assert.ok(at(QUIET_MS + 1000));
});
