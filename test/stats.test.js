const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    aggregateStats, readEventLines, TOP_N,
    listRegisteredProjects, aggregateWorkspaceStats, computeWorkspaceStats
} = require('../lib/stats');

test('status events alone record visits but no duration - only a running interval is time', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z');
    const t2 = new Date('2026-01-01T03:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() }
    ];
    const { tasks } = aggregateStats(events, t2);
    assert.deepEqual(tasks['X'].stages.backlog, { visits: 1 });
    assert.deepEqual(tasks['X'].stages.in_progress, { visits: 1 });
});

test('a running interval is timed against the stage in effect when the flag went up', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z'); // -> in_progress, agent starts
    const t2 = new Date('2026-01-01T01:12:00.000Z'); // agent finishes
    const now = new Date('2026-01-01T09:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() },
        { task: 'X', field: 'running', from: false, to: true, at: t1.toISOString() },
        { task: 'X', field: 'running', from: true, to: false, at: t2.toISOString() }
    ];
    const { tasks } = aggregateStats(events, now);
    // The 8h the task then sat idle in in_progress is not the agent's time.
    assert.deepEqual(tasks['X'].stages.in_progress, { totalMs: t2 - t1, visits: 1, ongoing: false });
    assert.deepEqual(tasks['X'].stages.backlog, { visits: 1 });
});

test('a running interval left open counts to now and is flagged ongoing', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T00:30:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', field: 'running', from: false, to: true, at: t0.toISOString() }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.deepEqual(tasks['X'].stages.in_progress, { totalMs: now - t0, visits: 1, ongoing: true });
});

test('a running:false with no open interval before it is ignored', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T01:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T00:10:00.000Z' }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.deepEqual(tasks['X'].stages.in_progress, { visits: 1 });
});

test('a running interval on a task with no status event at all lands in the unknown stage', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T00:05:00.000Z');
    const now = new Date('2026-01-01T01:00:00.000Z');
    const events = [
        { task: 'X', field: 'running', from: false, to: true, at: t0.toISOString() },
        { task: 'X', field: 'running', from: true, to: false, at: t1.toISOString() }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.equal(tasks['X'].stages.unknown.totalMs, t1 - t0);
    assert.equal(tasks['X'].stages.unknown.visits, 0);
});

test('a running interval opened just before the first status event clamps to that stage', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T00:05:00.000Z');
    const now = new Date('2026-01-01T01:00:00.000Z');
    const events = [
        { task: 'X', field: 'running', from: false, to: true, at: t0.toISOString() },
        { task: 'X', field: 'running', from: true, to: false, at: t1.toISOString() },
        { task: 'X', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:06:00.000Z' }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.equal(tasks['X'].stages.backlog.totalMs, t1 - t0);
});

test('two running intervals in the same stage sum, and a reopened flag closes the previous one', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'code_review', at: t0.toISOString() },
        { task: 'X', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T00:05:00.000Z' },
        { task: 'X', field: 'running', from: false, to: true, at: '2026-01-01T00:20:00.000Z' },
        { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T00:27:00.000Z' }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.equal(tasks['X'].stages.code_review.totalMs, 12 * 60 * 1000);
    assert.equal(tasks['X'].stages.code_review.ongoing, false);
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
    assert.equal(tasks['X'].stages.backlog.totalMs, undefined);
    assert.equal(tasks['X'].stages.backlog.ongoing, undefined);
    assert.equal(tasks['X'].stages.done.totalMs, undefined);
    assert.equal(tasks['X'].stages.done.ongoing, undefined);
});

test('two running intervals across two visits to the same stage sum into one totalMs', () => {
    const now = new Date('2026-01-01T05:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'X', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', field: 'status', from: 'in_progress', to: 'code_review', at: '2026-01-01T01:00:00.000Z' },
        { task: 'X', field: 'status', from: 'code_review', to: 'in_progress', at: '2026-01-01T02:00:00.000Z' },
        { task: 'X', field: 'running', from: false, to: true, at: '2026-01-01T02:00:00.000Z' },
        { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T02:05:00.000Z' }
    ];
    const { tasks } = aggregateStats(events, now);
    assert.equal(tasks['X'].stages.in_progress.visits, 2);
    assert.equal(tasks['X'].stages.in_progress.totalMs, 15 * 60 * 1000);
});

// --- a stage with no agent run carries no duration, by data not by list ------

for (const waiting of ['ready_todo', 'spec_approval', 'blocked', 'done', 'nope']) {
    test(`stages.${waiting} has no avgMs/maxMs/topByTime but keeps taskCount and token attribution when no agent ran there`, () => {
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const now = new Date('2026-01-01T02:00:00.000Z');
        const events = [
            { task: 'X', field: 'status', from: null, to: waiting, at: t0.toISOString() },
            {
                task: 'X', type: 'dispatch_tokens', agent: 'meridian:spec-generator',
                output_tokens: 250, context_tokens: 3000, at: '2026-01-01T00:30:00.000Z'
            }
        ];
        const { tasks, stages } = aggregateStats(events, now);
        assert.equal(tasks['X'].stages[waiting].totalMs, undefined);
        assert.equal(tasks['X'].stages[waiting].ongoing, undefined);
        assert.equal(tasks['X'].stages[waiting].visits, 1);
        assert.ok(stages[waiting], `stages.${waiting} present`);
        assert.ok(!('avgMs' in stages[waiting]));
        assert.ok(!('maxMs' in stages[waiting]));
        assert.ok(!('topByTime' in stages[waiting]));
        assert.equal(stages[waiting].taskCount, 1);
        assert.equal(stages[waiting].avgTokens, 250);
        assert.deepEqual(stages[waiting].agents, [
            { agent: 'meridian:spec-generator', totalOutputTokens: 250, dispatches: 1 }
        ]);
    });
}

// Nothing excludes a stage by name any more: backlog and spec_review are where
// the spec-generator and spec-reviewer actually run, and they get real numbers.
for (const worked of ['backlog', 'spec_review']) {
    test(`stages.${worked} carries avgMs/maxMs when an agent ran there`, () => {
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const now = new Date('2026-01-01T02:00:00.000Z');
        const events = [
            { task: 'X', field: 'status', from: null, to: worked, at: t0.toISOString() },
            { task: 'X', field: 'running', from: false, to: true, at: t0.toISOString() },
            { task: 'X', field: 'running', from: true, to: false, at: '2026-01-01T00:04:00.000Z' }
        ];
        const { stages } = aggregateStats(events, now);
        assert.equal(stages[worked].avgMs, 4 * 60 * 1000);
        assert.equal(stages[worked].maxMs, 4 * 60 * 1000);
        assert.deepEqual(stages[worked].topByTime, [{ task: 'X', ms: 4 * 60 * 1000, ongoing: false }]);
    });
}

test('an open running interval produces totalMs/ongoing and avgMs/maxMs/topByTime', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', field: 'running', from: false, to: true, at: t0.toISOString() }
    ];
    const { tasks, stages } = aggregateStats(events, now);
    assert.deepEqual(tasks['X'].stages.in_progress, { totalMs: now - t0, visits: 1, ongoing: true });
    assert.equal(stages.in_progress.avgMs, now - t0);
    assert.equal(stages.in_progress.maxMs, now - t0);
    assert.equal(stages.in_progress.topByTime.length, 1);
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
    // 7 tasks all entering in_progress (a timed/work stage) at t0 with increasing durations
    const durationsHours = [1, 2, 3, 4, 5, 6, 7];
    durationsHours.forEach((h, i) => {
        const taskId = `T${i}`;
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date(t0.getTime() + h * 3600 * 1000);
        events.push({ task: taskId, field: 'status', from: null, to: 'in_progress', at: t0.toISOString() });
        events.push({ task: taskId, field: 'running', from: false, to: true, at: t0.toISOString() });
        events.push({ task: taskId, field: 'running', from: true, to: false, at: t1.toISOString() });
        events.push({ task: taskId, field: 'status', from: 'in_progress', to: 'done', at: t1.toISOString() });
    });
    const { stages } = aggregateStats(events, now);
    assert.equal(stages.in_progress.taskCount, 7);
    const expectedAvgMs = durationsHours.reduce((s, h) => s + h * 3600 * 1000, 0) / 7;
    assert.equal(stages.in_progress.avgMs, expectedAvgMs);
    assert.equal(stages.in_progress.maxMs, 7 * 3600 * 1000);
    assert.equal(stages.in_progress.topByTime.length, TOP_N);
    assert.equal(stages.in_progress.topByTime[0].task, 'T6');
    assert.equal(stages.in_progress.topByTime[0].ms, 7 * 3600 * 1000);
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

test('a running event with a non-boolean `to`, and events with neither field nor type, are ignored without throwing', () => {
    const events = [
        { task: 'X', field: 'running', from: false, to: 'yes', at: '2026-01-01T00:00:00.000Z' },
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

// --- listRegisteredProjects -------------------------------------------------

test('listRegisteredProjects resolves names from project-info.json, falls back to basename', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const alphaDir = path.join(ws, 'alpha-project');
    const namelessDir = path.join(ws, 'nameless-project');
    fs.mkdirSync(path.join(alphaDir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(alphaDir, '.meridian', 'project-info.json'), JSON.stringify({ name: 'Alpha' }));
    fs.mkdirSync(namelessDir, { recursive: true });
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: [{ path: alphaDir }, { path: namelessDir }] })
    );
    const result = listRegisteredProjects(ws);
    assert.deepEqual(result, [
        { path: alphaDir, name: 'Alpha' },
        { path: namelessDir, name: 'nameless-project' }
    ]);
});

test('listRegisteredProjects returns [] when projects.json is missing', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    assert.deepEqual(listRegisteredProjects(ws), []);
});

test('listRegisteredProjects returns [] without throwing when projects.json is malformed', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.meridian', 'projects.json'), 'not json');
    let result;
    assert.doesNotThrow(() => { result = listRegisteredProjects(ws); });
    assert.deepEqual(result, []);
});

// --- aggregateWorkspaceStats (pure) -----------------------------------------

test('aggregateWorkspaceStats keys colliding task ids per project and tags each with task/project', () => {
    const projA = { path: '/ws/projA', name: 'Project A' };
    const projB = { path: '/ws/projB', name: 'Project B' };
    const events = [
        { task: 'T1', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' }
    ];
    const now = new Date('2026-01-01T01:00:00.000Z');
    const { tasks } = aggregateWorkspaceStats([
        { path: projA.path, name: projA.name, events },
        { path: projB.path, name: projB.name, events }
    ], now);

    assert.ok(tasks[`${projA.path}::T1`]);
    assert.ok(tasks[`${projB.path}::T1`]);
    assert.equal(tasks[`${projA.path}::T1`].task, 'T1');
    assert.deepEqual(tasks[`${projA.path}::T1`].project, projA);
    assert.equal(tasks[`${projB.path}::T1`].task, 'T1');
    assert.deepEqual(tasks[`${projB.path}::T1`].project, projB);
});

test('aggregateWorkspaceStats merges a shared stage across two projects into one combined stages entry', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const eventsA = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: true, to: false, at: '2026-01-01T01:00:00.000Z' },
        { task: 'T1', field: 'status', from: 'in_progress', to: 'done', at: '2026-01-01T01:00:00.000Z' }
    ];
    const eventsB = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: true, to: false, at: '2026-01-01T03:00:00.000Z' },
        { task: 'T1', field: 'status', from: 'in_progress', to: 'done', at: '2026-01-01T03:00:00.000Z' }
    ];
    const { stages } = aggregateWorkspaceStats([
        { path: '/ws/projA', name: 'A', events: eventsA },
        { path: '/ws/projB', name: 'B', events: eventsB }
    ], now);

    assert.equal(stages.in_progress.taskCount, 2);
    const expectedAvgMs = (3600 * 1000 + 3 * 3600 * 1000) / 2;
    assert.equal(stages.in_progress.avgMs, expectedAvgMs);
});

test('aggregateWorkspaceStats topByTime/topByTokens carry a project field and rank the bigger entry first across projects', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const eventsSmall = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: true, to: false, at: '2026-01-01T01:00:00.000Z' },
        { task: 'T1', field: 'status', from: 'in_progress', to: 'done', at: '2026-01-01T01:00:00.000Z' }
    ];
    const eventsBig = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: false, to: true, at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', field: 'running', from: true, to: false, at: '2026-01-01T05:00:00.000Z' },
        { task: 'T1', field: 'status', from: 'in_progress', to: 'done', at: '2026-01-01T05:00:00.000Z' }
    ];
    const { stages } = aggregateWorkspaceStats([
        { path: '/ws/small', name: 'Small', events: eventsSmall },
        { path: '/ws/big', name: 'Big', events: eventsBig }
    ], now);

    assert.equal(stages.in_progress.topByTime[0].project.path, '/ws/big');
    assert.equal(stages.in_progress.topByTime[0].ms, 5 * 3600 * 1000);
});

test('aggregateWorkspaceStats: a project entry with events:[] (or missing) contributes nothing', () => {
    const events = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' }
    ];
    const now = new Date('2026-01-01T01:00:00.000Z');
    const withEmpty = aggregateWorkspaceStats([
        { path: '/ws/a', name: 'A', events },
        { path: '/ws/empty', name: 'Empty', events: [] }
    ], now);
    const withoutEntry = aggregateWorkspaceStats([
        { path: '/ws/a', name: 'A', events }
    ], now);

    assert.deepEqual(Object.keys(withEmpty.tasks), Object.keys(withoutEntry.tasks));
    assert.deepEqual(withEmpty.stages, withoutEntry.stages);
});

// --- stages.<name>.agents ----------------------------------------------------

test('a stage whose dispatch_tokens events all carry the same agent produces one agents entry', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 50, context_tokens: 500, at: '2026-01-01T00:20:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.deepEqual(stages.in_progress.agents, [
        { agent: 'meridian:developer', totalOutputTokens: 150, dispatches: 2 }
    ]);
});

test('a stage with dispatches from two agents produces both entries sorted with the larger total first', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:qa', output_tokens: 400, context_tokens: 1000, at: '2026-01-01T00:20:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.equal(stages.in_progress.agents.length, 2);
    assert.equal(stages.in_progress.agents[0].agent, 'meridian:qa');
    assert.equal(stages.in_progress.agents[0].totalOutputTokens, 400);
    assert.equal(stages.in_progress.agents[1].agent, 'meridian:developer');
    assert.equal(stages.in_progress.agents[1].totalOutputTokens, 100);
});

test('a dispatch_tokens event with no agent field groups under agent: null, mixed with an agent-carrying event both appear', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', type: 'dispatch_tokens', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 50, context_tokens: 500, at: '2026-01-01T00:20:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.equal(stages.in_progress.agents.length, 2);
    const nullEntry = stages.in_progress.agents.find(a => a.agent === null);
    const devEntry = stages.in_progress.agents.find(a => a.agent === 'meridian:developer');
    assert.ok(nullEntry);
    assert.equal(nullEntry.totalOutputTokens, 100);
    assert.equal(nullEntry.dispatches, 1);
    assert.ok(devEntry);
    assert.equal(devEntry.totalOutputTokens, 50);
    assert.equal(devEntry.dispatches, 1);
});

test('a stage with time/status data but zero dispatch_tokens events has agents: []', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T01:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', field: 'status', from: 'backlog', to: 'in_progress', at: t1.toISOString() },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T01:10:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.deepEqual(stages.backlog.agents, []);
});

test('a dispatch_tokens event for a task with no status events still produces stages.unknown.agents reflecting its agent', () => {
    const events = [
        { task: 'Y', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 42, context_tokens: 999, at: '2026-01-01T00:00:00.000Z' }
    ];
    const { stages } = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z'));
    assert.deepEqual(stages.unknown.agents, [
        { agent: 'meridian:developer', totalOutputTokens: 42, dispatches: 1 }
    ]);
});

test('a dispatch_tokens event for a task with no status events and no agent field produces stages.unknown.agents with agent: null', () => {
    const events = [
        { task: 'Y', type: 'dispatch_tokens', output_tokens: 42, context_tokens: 999, at: '2026-01-01T00:00:00.000Z' }
    ];
    const { stages } = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z'));
    assert.deepEqual(stages.unknown.agents, [
        { agent: null, totalOutputTokens: 42, dispatches: 1 }
    ]);
});

test('agents.dispatches counts events, not tokens — three same-agent events of 100 tokens each produce dispatches: 3', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T02:00:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'in_progress', at: t0.toISOString() },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:20:00.000Z' },
        { task: 'X', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:30:00.000Z' }
    ];
    const { stages } = aggregateStats(events, now);
    assert.deepEqual(stages.in_progress.agents, [
        { agent: 'meridian:developer', totalOutputTokens: 300, dispatches: 3 }
    ]);
});

test('aggregateWorkspaceStats merges same-named agents across two projects contributing to the same stage into one entry', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    const eventsA = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 100, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' }
    ];
    const eventsB = [
        { task: 'T1', field: 'status', from: null, to: 'in_progress', at: '2026-01-01T00:00:00.000Z' },
        { task: 'T1', type: 'dispatch_tokens', agent: 'meridian:developer', output_tokens: 50, context_tokens: 1000, at: '2026-01-01T00:10:00.000Z' }
    ];
    const { stages } = aggregateWorkspaceStats([
        { path: '/ws/projA', name: 'A', events: eventsA },
        { path: '/ws/projB', name: 'B', events: eventsB }
    ], now);

    assert.deepEqual(stages.in_progress.agents, [
        { agent: 'meridian:developer', totalOutputTokens: 150, dispatches: 2 }
    ]);
});

// --- computeWorkspaceStats (fs-backed) --------------------------------------

function writeRegistry(ws, dirs) {
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: dirs.map(d => ({ path: d })) })
    );
}

function writeEvents(dir, lines) {
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'events.jsonl'), lines.join('\n') + '\n');
}

test('computeWorkspaceStats reflects both projects real events.jsonl files', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dirA = path.join(ws, 'projA');
    const dirB = path.join(ws, 'projB');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    writeEvents(dirA, [JSON.stringify({ task: 'T1', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' })]);
    writeEvents(dirB, [JSON.stringify({ task: 'T1', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' })]);
    writeRegistry(ws, [dirA, dirB]);

    const now = new Date('2026-01-01T02:00:00.000Z');
    const { tasks, stages, errors } = computeWorkspaceStats(ws, now);
    assert.ok(tasks[`${dirA}::T1`]);
    assert.ok(tasks[`${dirB}::T1`]);
    assert.equal(stages.backlog.taskCount, 2);
    assert.deepEqual(errors, []);
});

test('computeWorkspaceStats: a registered project with no events.jsonl contributes nothing and no error', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dirA = path.join(ws, 'projA');
    const dirNoEvents = path.join(ws, 'projNoEvents');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirNoEvents, { recursive: true });
    writeEvents(dirA, [JSON.stringify({ task: 'T1', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' })]);
    writeRegistry(ws, [dirA, dirNoEvents]);

    const { errors } = computeWorkspaceStats(ws, new Date('2026-01-01T02:00:00.000Z'));
    assert.deepEqual(errors, []);
});

test('computeWorkspaceStats: an unreadable events.jsonl (a directory) produces one errors entry without failing the request or omitting others', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dirA = path.join(ws, 'projA');
    const dirBroken = path.join(ws, 'projBroken');
    fs.mkdirSync(dirA, { recursive: true });
    writeEvents(dirA, [JSON.stringify({ task: 'T1', field: 'status', from: null, to: 'backlog', at: '2026-01-01T00:00:00.000Z' })]);
    fs.mkdirSync(path.join(dirBroken, '.meridian', 'events.jsonl'), { recursive: true });
    writeRegistry(ws, [dirA, dirBroken]);

    const { tasks, errors } = computeWorkspaceStats(ws, new Date('2026-01-01T02:00:00.000Z'));
    assert.ok(tasks[`${dirA}::T1`]);
    assert.equal(errors.length, 1);
});

test('computeWorkspaceStats with an empty/missing projects.json returns empty tasks/stages/errors', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const result = computeWorkspaceStats(ws, new Date());
    assert.deepEqual(result, { tasks: {}, stages: {}, errors: [] });
});

// A dispatch refusal (type: 'dispatch_refused') is neither a status change
// nor a running interval nor a token event, so it must fall into
// aggregateTaskStats' "anything else: not used" branch — counted nowhere,
// crashing nothing. This pins that a refusal line dropped into the same
// log a pass's successful dispatch already writes to cannot skew the very
// numbers this file reports.
test('a dispatch_refused event is ignored cleanly — no task entry, no crash, no effect on sibling events', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-01T00:05:00.000Z');
    const events = [
        { task: 'X', field: 'status', from: null, to: 'backlog', at: t0.toISOString() },
        { task: 'X', type: 'dispatch_refused', reason: 'X is already done', scope: 'task', at: t1.toISOString() },
        { task: 'Y', type: 'dispatch_refused', reason: 'CLI not authenticated', scope: 'environment', at: t1.toISOString() }
    ];
    const { tasks } = aggregateStats(events, new Date('2026-01-01T01:00:00.000Z'));
    // X still only shows the visit its status event produced.
    assert.deepEqual(tasks['X'].stages, { backlog: { visits: 1 } });
    // Y never had a status/running/dispatch_tokens event, so it gets no
    // entry at all — a refusal alone never fabricates a task record.
    assert.equal(tasks['Y'], undefined);
});
