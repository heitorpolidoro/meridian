const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveKey, nextTaskId, getTasks, saveTasks, getTask, deleteTaskDetail, MalformedTasksError, LegacyTasksFileError } = require('../lib/tasks');

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

function tmpProject(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    if (lines !== undefined) {
        fs.writeFileSync(
            path.join(dir, '.meridian', 'tasks.jsonl'),
            lines.map(t => JSON.stringify(t)).join('\n') + '\n'
        );
    }
    return dir;
}

test('getTasks: reads one task per line', () => {
    const dir = tmpProject([{ id: 'A-1' }, { id: 'A-2' }]);
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1', 'A-2']);
});

test('getTasks: applies the read-path defaults', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.equal(getTasks(dir).tasks[0].priority, 'medium');
});

test('getTasks: blank lines are skipped, not parsed', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.jsonl'),
        '{"id":"A-1"}\n\n{"id":"A-2"}\n'
    );
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1', 'A-2']);
});

test('getTasks: missing file yields an empty list', () => {
    const dir = tmpProject(undefined);
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('getTasks: an unparseable line names its line number and aborts the read', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.jsonl'),
        '{"id":"A-1"}\n{not json\n{"id":"A-3"}\n'
    );
    assert.throws(() => getTasks(dir), (err) => {
        assert.ok(err instanceof MalformedTasksError);
        assert.match(err.message, /line 2/);
        return true;
    });
});

test('getTasks: a legacy tasks.json without tasks.jsonl demands the migration', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.json'),
        JSON.stringify([{ id: 'A-1' }])
    );
    assert.throws(() => getTasks(dir), (err) => {
        assert.ok(err instanceof LegacyTasksFileError);
        assert.match(err.message, /migrate-tasks-jsonl/);
        return true;
    });
});

test('getTasks: an empty tasks.jsonl throws rather than reading as no tasks', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '');
    assert.throws(() => getTasks(dir), MalformedTasksError);
});

test('saveTasks: writes one compact line per task with a trailing newline', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um' }, { id: 'A-2', title: 'dois' }] });
    const raw = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    assert.equal(raw, '{"id":"A-1","title":"um"}\n{"id":"A-2","title":"dois"}\n');
});

test('saveTasks: leaves no temp file behind', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1' }] });
    const entries = fs.readdirSync(path.join(dir, '.meridian'));
    assert.deepEqual(entries, ['tasks.jsonl']);
});

const detail = (dir, id) => path.join(dir, '.meridian', 'tasks', `${id}.json`);

test('saveTasks: expected_results goes to the detail file, not the line', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um', expected_results: ['r1', 'r2'] }] });
    const line = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    assert.ok(!line.includes('expected_results'), 'a linha não carrega o campo pesado');
    assert.deepEqual(
        JSON.parse(fs.readFileSync(detail(dir, 'A-1'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
});

test('saveTasks: an empty expected_results writes no detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: [] }] });
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
});

test('saveTasks: emptying expected_results deletes the detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: [] }] });
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
});

test('saveTasks: an absent expected_results leaves the detail file untouched', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    // É exatamente o round-trip que toda rota de escrita faz: getTasks devolve
    // a task sem o campo, e o save seguinte não pode apagar os resultados.
    const light = getTasks(dir);
    light.tasks[0].status = 'done';
    saveTasks(dir, light);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(detail(dir, 'A-1'), 'utf8')),
        { expected_results: ['r1'] }
    );
});

test('getTasks: does not hydrate expected_results', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    assert.equal(getTasks(dir).tasks[0].expected_results, undefined);
});

test('getTask: merges the line with its detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um', expected_results: ['r1'] }] });
    const task = getTask(dir, 'A-1');
    assert.equal(task.title, 'um');
    assert.deepEqual(task.expected_results, ['r1']);
});

test('getTask: a task with no detail file reads expected_results as empty', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.deepEqual(getTask(dir, 'A-1').expected_results, []);
});

test('getTask: an unknown id is null', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.equal(getTask(dir, 'A-9'), null);
});

test('getTasks: an orphan detail file is inert', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    fs.mkdirSync(path.join(dir, '.meridian', 'tasks'), { recursive: true });
    fs.writeFileSync(detail(dir, 'A-ORPHAN'), JSON.stringify({ expected_results: ['x'] }));
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1']);
});

test('deleteTaskDetail: removes the file and tolerates its absence', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    deleteTaskDetail(dir, 'A-1');
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
    deleteTaskDetail(dir, 'A-1');
});

test('saveTasks: the detail file lands before the line', () => {
    const dir = tmpProject(undefined);
    const order = [];
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => { order.push(path.basename(to)); return realRename(from, to); };
    try {
        saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    } finally {
        fs.renameSync = realRename;
    }
    assert.deepEqual(order, ['A-1.json', 'tasks.jsonl']);
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

test('getTasks: backfills a missing priority to medium', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'backlog' }]);
    assert.equal(getTasks(dir).tasks[0].priority, 'medium');
});

test('getTasks: backfill never overwrites an existing priority', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'backlog', priority: 'critical' }]);
    assert.equal(getTasks(dir).tasks[0].priority, 'critical');
});

test('getTasks: backfills moved_at from updated_at when it is missing', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'backlog', updated_at: '2026-08-13T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].moved_at, '2026-08-13T00:00:00.000Z');
});

test('getTasks: moved_at stays absent when there is no updated_at to borrow', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'backlog' }]);
    assert.equal('moved_at' in getTasks(dir).tasks[0], false);
});

test('getTasks: backfill never overwrites an existing moved_at', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'backlog', updated_at: '2026-08-20T00:00:00.000Z', moved_at: '2026-08-01T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].moved_at, '2026-08-01T00:00:00.000Z');
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
    const t = stampTaskUpdate({ id: 'A-1', status: 'in_progress', moved_at: 'earlier' }, 'ready_todo');
    assert.match(t.moved_at, ISO);
    assert.notEqual(t.moved_at, 'earlier');
});

test('stampTaskUpdate: entering done sets completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done' }, 'qa_review');
    assert.match(t.completed_at, ISO);
    assert.equal(t.completed_at, t.moved_at);
});

test('stampTaskUpdate: leaving done clears completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'in_progress', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, null);
});

test('stampTaskUpdate: done to done does not restamp completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, '2026-08-01T00:00:00.000Z');
});
