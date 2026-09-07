const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { aggregateStats, readEventLines, TOP_N } = require('../lib/stats');

test('a single task entering backlog then in_progress produces correct stage durations, last one ongoing', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z');
    const t2 = new Date('2026-01-01T03:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() }
    ];
    const { tasks } = aggregateStats(events, t2);
    assert.deepEqual(tasks['X'].stages.backlog, { totalMs: t1 - t0, visits: 1, ongoing: false });
    assert.deepEqual(tasks['X'].stages.in_progress, { totalMs: t2 - t1, visits: 1, ongoing: true });
});

test('two separate visits to the same stage sum into one totalMs with visits:2', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z'); // backlog -> in_progress (backlog visit 1: 1h)
    const t2 = new Date('2026-01-01T02:00:00.000Z'); // in_progress -> backlog (in_progress visit: 1h)
    const t3 = new Date('2026-01-01T02:30:00.000Z'); // backlog -> done (backlog visit 2: 30m)
    const now = new Date('2026-01-01T03:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() },
        { task: 'X', field: 'status', from: 'in_progress', to: 'backlog', at: t2.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'done', at: t3.toISOString() }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.equal(tasks['X'].stages.backlog.visits, 2);
    assert.equal(tasks['X'].stages.backlog.totalMs, (t1 - t0) + (t3 - t2));
    assert.equal(tasks['X'].stages.backlog.ongoing, false);
    assert.equal(tasks['X'].stages.done.ongoing, true);
});

test('dispatch_tokens events sum into count/totalOutputTokens, maxContextTokens is max not sum', () => {
    const events = [
        { task: 'X', type: 'dispatch_tokens', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:00:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', output_tokens: 200, context_tokens: 5000, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', output_tokens: 50, context_tokens: 2000, at: '2026-01-01T00:20:00.000Z' }
    ];
    const { tasks } = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z'));
    assert.deepEqual(tasks['X'].dispatches, { count: 3, totalOutputTokens: 350, maxContextTokens: 5000 });
});

test('dispatch_tokens events are attributed to the correct status interval / stage', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() },
        // inside backlog interval
        { task: 'X', type: 'dispatch_tokens', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:30:00.000Z' },
        // inside in_progress interval
        { task: 'X', type: 'dispatch_tokens', output_tokens: 300, context_tokens: 4000, at: '2026-01-01T01:30:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.equal(stages.backlog.avgTokens, 100);
    assert.equal(stages.backlog.maxTokens, 100);
    assert.equal(stages.in_progress.avgTokens, 300);
    assert.equal(stages.in_progress.maxTokens, 300);
});

test('dispatch_tokens for a task with no status events still appears in tasks with empty stages and feeds stages.unknown', () => {
    const events = [
        { task: 'Y', type: 'dispatch_tokens', output_tokens: 42, context_tokens: 999, at: '2026-01-01T00:00:00.000Z' }
    ];
    const { tasks, stages } = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z'));
    assert.deepEqual(tasks['Y'].stages, {});
    assert.deepEqual(tasks['Y'].dispatches, { count: 1, totalOutputTokens: 42, maxContextTokens: 999 });
    assert.ok(stages.unknown);
    assert.equal(stages.unknown.taskCount, 0); // no time entries for unknown, only token entries
    assert.equal(stages.unknown.topByTokens.length, 1);
    assert.equal(stages.unknown.topByTokens[0].task, 'Y');
});

test('board-wide stage avgMs/maxMs/topByTime computed correctly across multiple tasks; topByTime capped at TOP_N', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const events = [];
    // 7 tasks all entering backlog at t0 with increasing durations
    const durationsHours = [1, 2, 3, 4, 5, 6, 7];
    durationsHours.forEach((h, i) => {
        const taskId = `T${i}`;
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date(t0.getTime() + h * 3600 * 1000);
        events.push({ task: taskId, field: 'status', from: null, to: 'backlog', at: t0.toISOString() });
        events.push({ task: taskId, field: 'status', from: 'backlog', to: 'done', at: t1.toISOString() });
    });
    const { stages } = aggregateStats(events, now);
    assert.equal(stages.backlog.taskCount, 7);
    const expectedAvgMs = durationsHours.reduce((s, h) => s + h * 3600 * 1000, 0) / 7;
    assert.equal(stages.backlog.avgMs, expectedAvgMs);
    assert.equal(stages.backlog.maxMs, 7 * 3600 * 1000);
    assert.equal(stages.backlog.topByTime.length, TOP_N);
    assert.equal(stages.backlog.topByTime[0].task, 'T6');
    assert.equal(stages.backlog.topByTime[0].ms, 7 * 3600 * 1000);
});

test('malformed events (missing task, unparseable at, status with no to, non-numeric output_tokens) are skipped silently without throwing or corrupting surrounding events', () => {
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' },
        { field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' }, // missing task
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: 'not-a-date' }, // unparseable at
        { task: 'X', field: 'status', from: 'backlog', at: '2026-01-01T01:00:00.000Z' }, // no `to`
        { task: 'X', type: 'dispatch_tokens', output_tokens: 'ten', context_tokens: 20, at: '2026-01-01T00:30:00.000Z' }, // non-numeric
        { task: 'X', field: 'status', from: 'backlog', to: 'done', at: '2026-01-01T02:00:00.000Z' }
    ];
    let result;
    assert.doesNotThrow(() => { result = aggregateStats(events, new Date('2026-01-01T03:00:00.000Z')); });
    assert.ok(result.tasks['X']);
    assert.equal(result.tasks['X'].stages.backlog.visits, 1);
    assert.equal(result.tasks['X'].stages.done.visits, 1);
    assert.equal(result.tasks['X'].dispatches.count, 0);
});

test('field:"running" and events with neither field nor type are accepted without throwing and contribute nothing', () => {
    const events = [
        { task: 'X', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'X', at: '2026-01-01T00:00:00.000Z' }
    ];
    let result;
    assert.doesNotThrow(() => { result = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z')); });
    assert.deepEqual(result.tasks, {});
    assert.deepEqual(result.stages, {});
});

test('aggregateStats([]) returns {tasks: {}, stages: {}}', () => {
    assert.deepEqual(aggregateStats([]), { tasks: {}, stages: {} });
});

test('readEventLines returns [] for a missing events.jsonl', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-stats-'));
    assert.deepEqual(readEventLines(dir), []);
});

test('readEventLines skips a malformed line among well-formed ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-stats-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    const file = path.join(dir, '.meridian', 'events.jsonl');
    fs.writeFileSync(file, '{"task":"A","field":"status","to":"backlog","at":"2026-01-01T00:00:00.000Z"}\nnot json\n{"task":"B","field":"status","to":"done","at":"2026-01-01T01:00:00.000Z"}\n');
    const lines = readEventLines(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].task, 'A');
    assert.equal(lines[1].task, 'B');
});

test('readEventLines returns both lines of a two-line file in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-stats-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    const file = path.join(dir, '.meridian', 'events.jsonl');
    fs.writeFileSync(file, '{"task":"A","at":"2026-01-01T00:00:00.000Z"}\n{"task":"B","at":"2026-01-01T01:00:00.000Z"}\n');
    const lines = readEventLines(dir);
    assert.deepEqual(lines.map(l => l.task), ['A', 'B']);
});
