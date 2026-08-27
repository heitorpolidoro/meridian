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
