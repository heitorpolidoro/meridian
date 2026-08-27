const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveKey, nextTaskId, getTasks, saveTasks } = require('../lib/tasks');

test('deriveKey: single word takes the first five letters', () => {
    assert.equal(deriveKey('Meridian'), 'MERID');
});

test('deriveKey: multi-word takes the initials', () => {
    assert.equal(deriveKey('Audio Transcriber'), 'AT');
    assert.equal(deriveKey('Repertoire Hero'), 'RH');
});

test('deriveKey: underscores and hyphens split like spaces', () => {
    assert.equal(deriveKey('project_d'), 'CL');
    assert.equal(deriveKey('audit-processor'), 'AP');
});

test('nextTaskId: first task of a project', () => {
    assert.equal(nextTaskId([], 'MERID'), 'MERID-1');
});

test('nextTaskId: continues from the highest existing number', () => {
    const tasks = [{ id: 'MERID-1' }, { id: 'MERID-7' }, { id: 'MERID-3' }];
    assert.equal(nextTaskId(tasks, 'MERID'), 'MERID-8');
});

test('nextTaskId: ignores ids from other keys and malformed ids', () => {
    const tasks = [{ id: 'AEQUI-99' }, { id: 'MERID-2' }, { id: 'MERID-x' }, {}];
    assert.equal(nextTaskId(tasks, 'MERID'), 'MERID-3');
});

function tmpProject(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    if (contents !== undefined) {
        fs.writeFileSync(
            path.join(dir, '.meridian', 'tasks.json'),
            JSON.stringify(contents, null, 2)
        );
    }
    return dir;
}

test('getTasks: reads the wrapped object shape', () => {
    const dir = tmpProject({ lastUpdated: '2026-01-01T00:00:00.000Z', tasks: [{ id: 'A-1' }] });
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1' }]);
});

test('getTasks: reads the bare array shape', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1' }]);
});

test('getTasks: missing file yields an empty list', () => {
    const dir = tmpProject(undefined);
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('getTasks: malformed JSON yields an empty list instead of throwing', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), '{not json');
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('saveTasks: creates .meridian when absent and round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'x' }] });
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1', title: 'x' }]);
});

test('saveTasks: writes a bare array with no lastUpdated wrapper', () => {
    const dir = tmpProject({ lastUpdated: 'old', tasks: [{ id: 'A-1' }] });
    saveTasks(dir, { tasks: [{ id: 'A-1' }] });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8'));
    assert.ok(Array.isArray(raw), 'file should be a bare array');
    assert.deepEqual(raw, [{ id: 'A-1' }]);
});

test('getTasks: backfills completed_at from updated_at for done tasks', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'done', updated_at: '2026-08-13T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].completed_at, '2026-08-13T00:00:00.000Z');
});

test('getTasks: backfill leaves completed_at null when updated_at is absent', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'done' }]);
    assert.equal(getTasks(dir).tasks[0].completed_at, null);
});

test('getTasks: backfill never overwrites an existing completed_at', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'done', updated_at: '2026-08-20T00:00:00.000Z', completed_at: '2026-08-01T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].completed_at, '2026-08-01T00:00:00.000Z');
});

test('getTasks: backfill does not touch tasks that are not done', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'backlog', updated_at: '2026-08-13T00:00:00.000Z' }]);
    assert.equal('completed_at' in getTasks(dir).tasks[0], false);
});

const { stampNewTask, stampTaskUpdate } = require('../lib/tasks');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('stampNewTask: sets created_at, moved_at and updated_at', () => {
    const t = stampNewTask({ id: 'A-1', status: 'backlog' });
    assert.match(t.created_at, ISO);
    assert.equal(t.moved_at, t.created_at);
    assert.equal(t.updated_at, t.created_at);
});

test('stampTaskUpdate: a write without a status change touches only updated_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'backlog', moved_at: 'earlier' }, 'backlog');
    assert.match(t.updated_at, ISO);
    assert.equal(t.moved_at, 'earlier');
    assert.equal('completed_at' in t, false);
});

test('stampTaskUpdate: a status change sets moved_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'inprogress', moved_at: 'earlier' }, 'readytodo');
    assert.match(t.moved_at, ISO);
    assert.notEqual(t.moved_at, 'earlier');
});

test('stampTaskUpdate: entering done sets completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done' }, 'qareview');
    assert.match(t.completed_at, ISO);
    assert.equal(t.completed_at, t.moved_at);
});

test('stampTaskUpdate: leaving done clears completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'inprogress', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, null);
});

test('stampTaskUpdate: done to done does not restamp completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, '2026-08-01T00:00:00.000Z');
});
