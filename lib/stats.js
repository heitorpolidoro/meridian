'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOP_N = 5;

// Reads <projectPath>/.meridian/events.jsonl, JSON.parse-ing one event per
// line. A missing file returns []. A line that fails to parse is skipped —
// this is the "unknown/malformed lines never fatal" contract; nothing here
// throws for a corrupt file, it just contributes fewer events.
function readEventLines(projectPath) {
    const file = path.join(projectPath, '.meridian', 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            events.push(JSON.parse(trimmed));
        } catch (err) {
            // malformed line: skip, never fatal
        }
    }
    return events;
}

function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
}

// Pure aggregation over already-parsed event objects — the two shapes
// MERID-3 writes:
//   {task, field:"status", from, to, at}
//   {task, type:"dispatch_tokens", agent?, output_tokens, context_tokens, at}
// A `field:"running"` event, or anything else with a recognisable `task`/`at`
// but neither a usable `field` nor `type`, is accepted as input without
// throwing and simply ignored by this aggregation (running-derived dispatch
// durations are out of scope — see below). Anything missing `task` or a
// parseable `at` is skipped outright.
//
// `now` is injectable so tests get deterministic "ongoing" durations instead
// of a real wall-clock race.
function aggregateStats(events, now = new Date()) {
    const statusByTask = new Map();
    const dispatchByTask = new Map();

    for (const ev of events || []) {
        if (!ev || typeof ev !== 'object') continue;
        if (typeof ev.task !== 'string' || !ev.task) continue;
        const at = new Date(ev.at);
        if (!isValidDate(at)) continue;

        if (ev.field === 'status') {
            if (typeof ev.to !== 'string' || !ev.to) continue;
            if (!statusByTask.has(ev.task)) statusByTask.set(ev.task, []);
            statusByTask.get(ev.task).push({ to: ev.to, at });
        } else if (ev.type === 'dispatch_tokens') {
            if (typeof ev.output_tokens !== 'number' || !Number.isFinite(ev.output_tokens)) continue;
            if (typeof ev.context_tokens !== 'number' || !Number.isFinite(ev.context_tokens)) continue;
            if (!dispatchByTask.has(ev.task)) dispatchByTask.set(ev.task, []);
            dispatchByTask.get(ev.task).push({
                output_tokens: ev.output_tokens,
                context_tokens: ev.context_tokens,
                at
            });
        }
        // field:"running" and anything else: not used by this aggregation.
    }

    const tasks = {};
    const stageTimeEntries = new Map();   // stage -> [{task, ms, ongoing}]
    const stageTokenEntries = new Map();  // stage -> [{task, tokens, maxContextTokens}]

    for (const [taskId, rawEvents] of statusByTask) {
        // Sort chronologically. Duration is derived purely from consecutive
        // `to`/`at` pairs — `from` is never trusted for the math, only used
        // by the caller for display elsewhere.
        const sorted = [...rawEvents].sort((a, b) => a.at - b.at);
        const intervals = sorted.map((e, i) => ({
            stage: e.to,
            start: e.at,
            end: i + 1 < sorted.length ? sorted[i + 1].at : now,
            ongoing: i + 1 >= sorted.length
        }));

        const stages = {};
        for (const iv of intervals) {
            const ms = Math.max(0, iv.end.getTime() - iv.start.getTime());
            if (!stages[iv.stage]) stages[iv.stage] = { totalMs: 0, visits: 0, ongoing: false };
            stages[iv.stage].totalMs += ms;
            stages[iv.stage].visits += 1;
            // A later, closed visit to the same stage must not un-flag an
            // ongoing one — only the interval that is actually last (by
            // construction, ongoing is only ever true for the last interval)
            // sets this, so plain assignment (not OR) is fine here.
            if (iv.ongoing) stages[iv.stage].ongoing = true;
        }

        // Attribute each dispatch_tokens event to the stage the task was in
        // at that timestamp — the interval whose start is the latest one
        // not after the dispatch's `at`. A dispatch timestamped before the
        // task's first known status event (clock skew, or the ledger
        // predating the earliest retained status event) is clamped to the
        // first interval rather than dropped.
        const dispatches = dispatchByTask.get(taskId) || [];
        let dispatchCount = 0, totalOutputTokens = 0, maxContextTokens = 0;
        const stageTokenAcc = {};

        for (const d of dispatches) {
            dispatchCount += 1;
            totalOutputTokens += d.output_tokens;
            if (d.context_tokens > maxContextTokens) maxContextTokens = d.context_tokens;

            let stage = 'unknown';
            if (intervals.length > 0) {
                let match = intervals[0];
                for (const iv of intervals) {
                    if (iv.start.getTime() <= d.at.getTime()) match = iv;
                    else break; // intervals are ascending by start
                }
                stage = match.stage;
            }
            if (!stageTokenAcc[stage]) stageTokenAcc[stage] = { totalOutputTokens: 0, maxContextTokens: 0 };
            stageTokenAcc[stage].totalOutputTokens += d.output_tokens;
            if (d.context_tokens > stageTokenAcc[stage].maxContextTokens) {
                stageTokenAcc[stage].maxContextTokens = d.context_tokens;
            }
        }

        tasks[taskId] = {
            stages,
            dispatches: { count: dispatchCount, totalOutputTokens, maxContextTokens }
        };

        for (const [stage, s] of Object.entries(stages)) {
            if (!stageTimeEntries.has(stage)) stageTimeEntries.set(stage, []);
            stageTimeEntries.get(stage).push({ task: taskId, ms: s.totalMs, ongoing: s.ongoing });
        }
        for (const [stage, tk] of Object.entries(stageTokenAcc)) {
            if (!stageTokenEntries.has(stage)) stageTokenEntries.set(stage, []);
            stageTokenEntries.get(stage).push({
                task: taskId, tokens: tk.totalOutputTokens, maxContextTokens: tk.maxContextTokens
            });
        }
    }

    // A dispatch_tokens event can reference a task id with no status event at
    // all in this file (e.g. the task predates events.jsonl, or was created
    // in another way). MERID-3 tolerates that on write; this must tolerate
    // it on read too — surface the dispatch totals with no stage breakdown
    // instead of silently dropping the task.
    for (const [taskId, dispatches] of dispatchByTask) {
        if (tasks[taskId]) continue;
        let dispatchCount = 0, totalOutputTokens = 0, maxContextTokens = 0;
        for (const d of dispatches) {
            dispatchCount += 1;
            totalOutputTokens += d.output_tokens;
            if (d.context_tokens > maxContextTokens) maxContextTokens = d.context_tokens;
        }
        tasks[taskId] = { stages: {}, dispatches: { count: dispatchCount, totalOutputTokens, maxContextTokens } };
        if (!stageTokenEntries.has('unknown')) stageTokenEntries.set('unknown', []);
        stageTokenEntries.get('unknown').push({ task: taskId, tokens: totalOutputTokens, maxContextTokens });
    }

    const stages = {};
    const allStageNames = new Set([...stageTimeEntries.keys(), ...stageTokenEntries.keys()]);
    for (const stage of allStageNames) {
        const timeEntries = stageTimeEntries.get(stage) || [];
        const tokenEntries = stageTokenEntries.get(stage) || [];

        const avgMs = timeEntries.length
            ? timeEntries.reduce((s, e) => s + e.ms, 0) / timeEntries.length : 0;
        const maxMs = timeEntries.length ? Math.max(...timeEntries.map(e => e.ms)) : 0;
        const avgTokens = tokenEntries.length
            ? tokenEntries.reduce((s, e) => s + e.tokens, 0) / tokenEntries.length : 0;
        const maxTokens = tokenEntries.length ? Math.max(...tokenEntries.map(e => e.tokens)) : 0;

        stages[stage] = {
            taskCount: timeEntries.length,
            avgMs, maxMs,
            topByTime: [...timeEntries].sort((a, b) => b.ms - a.ms).slice(0, TOP_N),
            avgTokens, maxTokens,
            topByTokens: [...tokenEntries].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N)
        };
    }

    return { tasks, stages };
}

// The only function that touches the filesystem. server.js calls this, and
// only this, per request — never a cached copy.
function computeProjectStats(projectPath, now = new Date()) {
    const events = readEventLines(projectPath);
    return aggregateStats(events, now);
}

module.exports = { aggregateStats, computeProjectStats, readEventLines, TOP_N };
