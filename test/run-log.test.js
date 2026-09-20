const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLogPath, appendRunLog, listRunLogs } = require('../lib/run-log');

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-runlog-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    return dir;
}

test('the log lands in .meridian/runs named by task and timestamp', () => {
    const dir = project();
    const file = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T14:05:09Z'));
    assert.equal(path.dirname(file), path.join(dir, '.meridian', 'runs'));
    assert.match(path.basename(file), /^DEMO-1-2026-09-20T14-05-09\.log$/);
});

// Two runs of one task must not overwrite each other: "what did it do at 3am"
// is the question the file exists to answer.
test('two runs of one task get two files', () => {
    const dir = project();
    const a = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T14:05:09Z'));
    const b = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T15:30:00Z'));
    assert.notEqual(a, b);
});

test('appending creates the directory and accumulates', () => {
    const dir = project();
    const file = runLogPath(dir, 'DEMO-1', new Date());
    appendRunLog(file, 'first\n');
    appendRunLog(file, 'second\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
});

test('logs for a task are listed newest first', () => {
    const dir = project();
    const older = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T10:00:00Z'));
    const newer = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T12:00:00Z'));
    appendRunLog(older, 'a');
    appendRunLog(newer, 'b');
    appendRunLog(runLogPath(dir, 'DEMO-2', new Date()), 'c');
    assert.deepEqual(listRunLogs(dir, 'DEMO-1').map(p => path.basename(p)),
        [path.basename(newer), path.basename(older)]);
});

test('a project with no runs lists nothing rather than throwing', () => {
    assert.deepEqual(listRunLogs(project(), 'DEMO-1'), []);
});

// The id reaches a file path. It is validated everywhere else too; this is
// the layer that stops a traversal from landing outside .meridian/runs.
// '..' is in the list because the rule is lib/tasks.js's isSafeTaskId, which
// rejects the two directory names the character class alone would let by.
test('an id that is not a plain task id is refused', () => {
    const dir = project();
    for (const bad of ['../../etc/passwd', 'a/b', '..', '', null]) {
        assert.throws(() => runLogPath(dir, bad, new Date()));
    }
});

test('an unsafe id lists nothing rather than throwing', () => {
    assert.deepEqual(listRunLogs(project(), '../../etc'), []);
});
