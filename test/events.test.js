const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendEvent } = require('../lib/events');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-events-'));
}

test('appendEvent creates .meridian/ and events.jsonl when missing', () => {
    const projectPath = tmpProject();
    const eventsPath = path.join(projectPath, '.meridian', 'events.jsonl');
    assert.equal(fs.existsSync(path.join(projectPath, '.meridian')), false);

    const result = appendEvent(projectPath, { task: 'T-1', field: 'status', from: null, to: 'backlog', at: 'now' });

    assert.equal(result, true);
    assert.ok(fs.existsSync(path.join(projectPath, '.meridian')));
    assert.ok(fs.existsSync(eventsPath));
});

test('two calls append two well-formed JSON lines in call order', () => {
    const projectPath = tmpProject();
    const eventsPath = path.join(projectPath, '.meridian', 'events.jsonl');

    appendEvent(projectPath, { task: 'T-1', field: 'status', from: null, to: 'backlog', at: '1' });
    appendEvent(projectPath, { task: 'T-1', field: 'status', from: 'backlog', to: 'in_progress', at: '2' });

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.to, 'backlog');
    assert.equal(second.to, 'in_progress');
});

test('appendEvent returns false without throwing when .meridian cannot be created', () => {
    const projectPath = tmpProject();
    // Occupy the .meridian path with a plain file, so mkdirSync must fail.
    fs.writeFileSync(path.join(projectPath, '.meridian'), 'not a directory');

    let threw = false;
    let result;
    try {
        result = appendEvent(projectPath, { task: 'T-1', field: 'status', from: null, to: 'backlog', at: 'now' });
    } catch (err) {
        threw = true;
    }

    assert.equal(threw, false);
    assert.equal(result, false);
});

test('events.jsonl is append-only across repeated writes', () => {
    const projectPath = tmpProject();
    const eventsPath = path.join(projectPath, '.meridian', 'events.jsonl');

    let prevCount = 0;
    for (let i = 0; i < 5; i++) {
        appendEvent(projectPath, { task: 'T-1', field: 'status', from: null, to: `status-${i}`, at: String(i) });
        const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
        assert.ok(lines.length > prevCount, 'line count only grows');
        for (let j = 0; j < prevCount; j++) {
            assert.equal(JSON.parse(lines[j]).to, `status-${j}`, 'earlier lines are unchanged');
        }
        prevCount = lines.length;
    }
});
