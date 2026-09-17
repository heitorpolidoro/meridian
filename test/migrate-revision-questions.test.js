const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixRevisionEntries, sameTasks, migrateProject } = require('../scripts/migrate-revision-questions');

const LABEL = 'Operator Revision Request';

// --- the pure transform ------------------------------------------------------

test('a revision entry moves the operator text from answer into question', () => {
    const before = [{ id: 'rev-1', by: 'Operator', question: LABEL, answer: 'Troque X por Y' }];
    const { questions, changed } = fixRevisionEntries(before);
    assert.equal(changed, 1);
    assert.equal(questions[0].question, 'Troque X por Y');
    assert.equal(questions[0].answer, '');
});

test('every other field of a converted entry survives untouched', () => {
    const before = [{
        id: 'rev-1', by: 'Operator', question: LABEL, answer: 'texto',
        created_at: '2026-09-01T00:00:00.000Z', answered_at: '2026-09-02T00:00:00.000Z'
    }];
    const { questions } = fixRevisionEntries(before);
    assert.equal(questions[0].id, 'rev-1');
    assert.equal(questions[0].by, 'Operator');
    assert.equal(questions[0].created_at, '2026-09-01T00:00:00.000Z');
    assert.equal(questions[0].answered_at, '2026-09-02T00:00:00.000Z');
});

// The label is the only safe marker. A normal operator question must never be
// touched, or the migration would swap a real Q&A pair the wrong way round.
test('an ordinary operator question with a real answer is left alone', () => {
    const before = [{ id: 'q-1', by: 'Operator', question: 'Como funciona X?', answer: 'Assim.' }];
    const { questions, changed } = fixRevisionEntries(before);
    assert.equal(changed, 0);
    assert.deepEqual(questions[0], before[0]);
});

test('an agent entry is left alone, answered or not', () => {
    const before = [
        { id: 'q-agent-1', by: 'Agent', question: 'Confirma?', answer: 'sim' },
        { id: 'q-agent-2', by: 'Agent', question: 'E isto?', answer: '' }
    ];
    const { questions, changed } = fixRevisionEntries(before);
    assert.equal(changed, 0);
    assert.deepEqual(questions, before);
});

test('a revision entry already converted is not converted twice', () => {
    const before = [{ id: 'rev-1', by: 'Operator', question: 'Troque X por Y', answer: '' }];
    const { questions, changed } = fixRevisionEntries(before);
    assert.equal(changed, 0);
    assert.deepEqual(questions[0], before[0]);
});

// A label entry whose answer is empty carries no text at all: converting it
// would leave a question that is an empty string, which renders as a blank
// card. Leave it and report it instead.
test('a label entry with an empty answer is left alone', () => {
    const before = [{ id: 'rev-1', by: 'Operator', question: LABEL, answer: '   ' }];
    const { questions, changed } = fixRevisionEntries(before);
    assert.equal(changed, 0);
    assert.deepEqual(questions[0], before[0]);
});

test('a task with no questions array is handled without throwing', () => {
    assert.deepEqual(fixRevisionEntries(undefined), { questions: undefined, changed: 0 });
});

// --- the per-project migration -----------------------------------------------

function projectWith(tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-revq-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.jsonl'),
        tasks.map(t => JSON.stringify(t)).join('\n') + '\n'
    );
    return dir;
}

const TASKS = [
    { id: 'A-1', title: 'um', status: 'backlog', questions: [{ id: 'rev-1', by: 'Operator', question: LABEL, answer: 'arrume isto' }] },
    { id: 'A-2', title: 'dois', status: 'done' }
];

test('migrateProject rewrites only the affected task and reports the count', () => {
    const dir = projectWith(TASKS);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(result.changed, 1);

    const lines = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8').trim().split('\n');
    const a1 = JSON.parse(lines[0]);
    assert.equal(a1.questions[0].question, 'arrume isto');
    assert.equal(a1.questions[0].answer, '');
    assert.equal(JSON.parse(lines[1]).title, 'dois');
});

test('migrateProject leaves a timestamped backup of the original file', () => {
    const dir = projectWith(TASKS);
    const original = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    migrateProject(dir, { dryRun: false });
    const baks = fs.readdirSync(path.join(dir, '.meridian')).filter(f => f.startsWith('tasks.jsonl.bak.'));
    assert.equal(baks.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', baks[0]), 'utf8'), original);
});

test('a dry run reports what it would change and writes nothing at all', () => {
    const dir = projectWith(TASKS);
    const before = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.changed, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8'), before);
    assert.equal(fs.readdirSync(path.join(dir, '.meridian')).filter(f => f.includes('.bak.')).length, 0);
});

test('a project with nothing to fix is not rewritten and gets no backup', () => {
    const dir = projectWith([{ id: 'A-1', title: 'um', questions: [{ id: 'q-1', by: 'Operator', question: 'ok?', answer: 'sim' }] }]);
    const before = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.changed, 0);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8'), before);
    assert.equal(fs.readdirSync(path.join(dir, '.meridian')).filter(f => f.includes('.bak.')).length, 0);
});

// expected_results lives in its own detail file and getTasks never hydrates it.
// A read-modify-write that forgot that would delete every detail file it saw.
test('detail files survive the rewrite untouched', () => {
    const dir = projectWith(TASKS);
    const detailDir = path.join(dir, '.meridian', 'tasks');
    fs.mkdirSync(detailDir, { recursive: true });
    fs.writeFileSync(path.join(detailDir, 'A-1.json'), JSON.stringify({ expected_results: ['r1', 'r2'] }));
    migrateProject(dir, { dryRun: false });
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(detailDir, 'A-1.json'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
});

// The verification is a pure comparison, so it is tested directly rather than
// by planting a failure hook in the migration itself.
test('sameTasks accepts an exact round trip', () => {
    const expected = [{ id: 'A-1', questions: [{ id: 'rev-1', by: 'Operator', question: 'x', answer: '' }] }];
    assert.equal(sameTasks(expected, JSON.parse(JSON.stringify(expected))), true);
});

test('sameTasks rejects a lost task, a renamed id, a lost field and a changed question', () => {
    const expected = [
        { id: 'A-1', title: 'um', questions: [{ id: 'rev-1', by: 'Operator', question: 'x', answer: '' }] },
        { id: 'A-2', title: 'dois' }
    ];
    const drop = arr => arr.slice(0, 1);
    const rename = arr => [{ ...arr[0], id: 'OTHER' }, arr[1]];
    const loseField = arr => [{ id: arr[0].id, questions: arr[0].questions }, arr[1]];
    const changeText = arr => [
        { ...arr[0], questions: [{ ...arr[0].questions[0], question: 'y' }] },
        arr[1]
    ];
    for (const mutate of [drop, rename, loseField, changeText]) {
        assert.equal(sameTasks(expected, mutate(JSON.parse(JSON.stringify(expected)))), false);
    }
});
