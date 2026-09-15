'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOP_N = 5;

// Stage durations measure one thing: how long an agent actually ran. That is
// the `running` flag, not the status interval. A status interval runs until
// somebody happens to invoke `meridian:work` again, so it mixes the agent's
// run with arbitrary idle time — a task left in `in_progress` overnight
// reported as fourteen hours of "developer".
//
// So a stage is timed by the `running: true` -> `running: false` intervals
// recorded against it, and by nothing else. No status is excluded by name:
// a waiting stage (`ready_todo`, `spec_approval`, `blocked`, `done`, `nope`)
// simply has no running interval and ends up with no duration, while
// `backlog` and `spec_review` — where the spec-generator and spec-reviewer
// really do run — get real numbers.

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

// Which stage a task was in at `at`: the interval whose start is the latest
// one not after it. An `at` before the task's first known status event (clock
// skew, or a history older than this log) clamps to the first interval rather
// than being dropped; a task with no status event at all answers `unknown`.
// Shared by running-interval timing and dispatch-token attribution, which must
// agree on where a moment belongs.
function stageAt(intervals, at) {
    if (intervals.length === 0) return 'unknown';
    let match = intervals[0];
    for (const iv of intervals) {
        if (iv.start.getTime() <= at.getTime()) match = iv;
        else break; // intervals are ascending by start
    }
    return match.stage;
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
//
// Everything up to (not including) the "shape stages from entries" step:
// returns the raw per-task map plus the two entry-maps that step consumes,
// so a caller aggregating several projects can merge entries across
// projects before shaping them (see aggregateWorkspaceStats).
function aggregateTaskStats(events, now = new Date()) {
    const statusByTask = new Map();
    const runningByTask = new Map();
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
        } else if (ev.field === 'running') {
            if (typeof ev.to !== 'boolean') continue;
            if (!runningByTask.has(ev.task)) runningByTask.set(ev.task, []);
            runningByTask.get(ev.task).push({ to: ev.to, at });
        } else if (ev.type === 'dispatch_tokens') {
            if (typeof ev.output_tokens !== 'number' || !Number.isFinite(ev.output_tokens)) continue;
            if (typeof ev.context_tokens !== 'number' || !Number.isFinite(ev.context_tokens)) continue;
            if (!dispatchByTask.has(ev.task)) dispatchByTask.set(ev.task, []);
            dispatchByTask.get(ev.task).push({
                output_tokens: ev.output_tokens,
                context_tokens: ev.context_tokens,
                agent: typeof ev.agent === 'string' && ev.agent ? ev.agent : null,
                at
            });
        }
        // anything else: not used by this aggregation.
    }

    const tasks = {};
    const stageTimeEntries = new Map();   // stage -> [{task, ms, ongoing}] — timed stages only
    const stageTokenEntries = new Map();  // stage -> [{task, tokens, maxContextTokens}]
    const stageAgentEntries = new Map();  // stage -> [{task, agent, tokens}]
    const stageVisitEntries = new Map();  // stage -> [{task}] — every stage a task visited, timed or not

    // A task can have running events with no status event at all (its status
    // history predates this log), so the union — not statusByTask alone — is
    // what must be walked.
    const allTaskIds = new Set([...statusByTask.keys(), ...runningByTask.keys(), ...dispatchByTask.keys()]);

    for (const taskId of allTaskIds) {
        const rawEvents = statusByTask.get(taskId) || [];
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

        // Visits come from the status history: entering a stage is a visit
        // whether or not an agent ever ran there.
        const stages = {};
        for (const iv of intervals) {
            if (!stages[iv.stage]) stages[iv.stage] = { visits: 0 };
            stages[iv.stage].visits += 1;
        }

        // Duration comes from the running flag. Each `true` opens an interval
        // attributed to the stage in effect at that moment — the PUT that
        // dispatches an agent appends its status event before its running
        // event, so the stage is already the new one by the time the flag
        // goes up. A `false` with nothing open is ignored (the flag was
        // cleared by a writer that never set it), and a `true` that reopens
        // an already-open interval closes the previous one at that instant
        // rather than losing it.
        const runEvents = [...(runningByTask.get(taskId) || [])].sort((a, b) => a.at - b.at);
        let open = null;
        const closeAt = (end, ongoing) => {
            const stage = open.stage;
            if (!stages[stage]) stages[stage] = { visits: 0 };
            if (stages[stage].totalMs === undefined) {
                stages[stage].totalMs = 0;
                stages[stage].ongoing = false;
            }
            stages[stage].totalMs += Math.max(0, end.getTime() - open.at.getTime());
            if (ongoing) stages[stage].ongoing = true;
            open = null;
        };
        for (const ev of runEvents) {
            if (ev.to === true) {
                if (open) closeAt(ev.at, false);
                open = { at: ev.at, stage: stageAt(intervals, ev.at) };
            } else if (open) {
                closeAt(ev.at, false);
            }
        }
        // An interval still open is an agent that never cleared the flag —
        // usually one still working, sometimes a session that died. Counted
        // up to `now` and flagged ongoing, which is what the board renders.
        if (open) closeAt(now, true);

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

            const stage = stageAt(intervals, d.at);
            if (!stageTokenAcc[stage]) stageTokenAcc[stage] = { totalOutputTokens: 0, maxContextTokens: 0 };
            stageTokenAcc[stage].totalOutputTokens += d.output_tokens;
            if (d.context_tokens > stageTokenAcc[stage].maxContextTokens) {
                stageTokenAcc[stage].maxContextTokens = d.context_tokens;
            }

            if (!stageAgentEntries.has(stage)) stageAgentEntries.set(stage, []);
            stageAgentEntries.get(stage).push({ task: taskId, agent: d.agent, tokens: d.output_tokens });
        }

        tasks[taskId] = {
            stages,
            dispatches: { count: dispatchCount, totalOutputTokens, maxContextTokens }
        };

        for (const [stage, s] of Object.entries(stages)) {
            // The visited signal is threaded through for every stage,
            // independent of whether it's timed — this is what keeps an
            // untimed stage with zero token/agent entries from vanishing
            // from `stages` entirely (see shapeStages).
            if (!stageVisitEntries.has(stage)) stageVisitEntries.set(stage, []);
            stageVisitEntries.get(stage).push({ task: taskId });

            // No duration means no agent ever ran in this stage for this task:
            // it contributes a visit and nothing to the timing aggregate.
            if (s.totalMs === undefined) continue;
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
        if (!stageAgentEntries.has('unknown')) stageAgentEntries.set('unknown', []);
        for (const d of dispatches) {
            stageAgentEntries.get('unknown').push({ task: taskId, agent: d.agent, tokens: d.output_tokens });
        }
    }

    return { tasks, stageTimeEntries, stageTokenEntries, stageAgentEntries, stageVisitEntries };
}

// Turns four entry-maps (stage -> [{task, ms, ongoing, ...}] / [{task,
// tokens, maxContextTokens, ...}] / [{task, agent, tokens}] / [{task}]) into
// the final `stages` object: avgMs, maxMs, topByTime (TOP_N), avgTokens,
// maxTokens, topByTokens (TOP_N), agents. Shared by aggregateStats and
// aggregateWorkspaceStats so both the single-project and workspace-wide
// paths shape stages identically.
//
// `stageVisitEntries` carries one entry per task that ever visited a stage,
// timed or not — it's what keeps an untimed stage in
// `stages` (via allStageNames) and gives it a correct `taskCount` even when
// it has zero timed or token/agent entries of its own. For a timed stage,
// `taskCount` is still `timeEntries.length` (unchanged, byte-for-byte); an
// untimed stage never gets avgMs/maxMs/topByTime at all — those three keys
// are omitted, not zeroed.
function shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries, stageVisitEntries) {
    const stages = {};
    const allStageNames = new Set([
        ...stageTimeEntries.keys(), ...stageTokenEntries.keys(),
        ...stageAgentEntries.keys(), ...stageVisitEntries.keys()
    ]);
    for (const stage of allStageNames) {
        const timeEntries = stageTimeEntries.get(stage) || [];
        const tokenEntries = stageTokenEntries.get(stage) || [];
        const agentEntries = stageAgentEntries.get(stage) || [];
        const visitEntries = stageVisitEntries.get(stage) || [];
        // Untimed is a property of the data, not a list of status names: a
        // stage nobody ran an agent in has no time entries.
        const untimed = timeEntries.length === 0;

        const avgTokens = tokenEntries.length
            ? tokenEntries.reduce((s, e) => s + e.tokens, 0) / tokenEntries.length : 0;
        const maxTokens = tokenEntries.length ? Math.max(...tokenEntries.map(e => e.tokens)) : 0;

        // One row per distinct agent (a dispatch_tokens event with no
        // `agent` field groups under the `null` key rather than being
        // dropped), sorted so the dominant agent is always index 0.
        const agentTotals = new Map();
        for (const e of agentEntries) {
            if (!agentTotals.has(e.agent)) agentTotals.set(e.agent, { totalOutputTokens: 0, dispatches: 0 });
            const acc = agentTotals.get(e.agent);
            acc.totalOutputTokens += e.tokens;
            acc.dispatches += 1;
        }
        const agents = [...agentTotals.entries()]
            .map(([agent, v]) => ({ agent, totalOutputTokens: v.totalOutputTokens, dispatches: v.dispatches }))
            .sort((a, b) => b.totalOutputTokens - a.totalOutputTokens);

        stages[stage] = {
            taskCount: untimed ? visitEntries.length : timeEntries.length,
            ...(untimed ? {} : {
                avgMs: timeEntries.length
                    ? timeEntries.reduce((s, e) => s + e.ms, 0) / timeEntries.length : 0,
                maxMs: timeEntries.length ? Math.max(...timeEntries.map(e => e.ms)) : 0,
                topByTime: [...timeEntries].sort((a, b) => b.ms - a.ms).slice(0, TOP_N)
            }),
            avgTokens, maxTokens,
            topByTokens: [...tokenEntries].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N),
            agents
        };
    }
    return stages;
}

function aggregateStats(events, now = new Date()) {
    const { tasks, stageTimeEntries, stageTokenEntries, stageAgentEntries, stageVisitEntries }
        = aggregateTaskStats(events, now);
    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries, stageVisitEntries) };
}

// The only function that touches the filesystem for the single-project path.
// server.js calls this, and only this, per request — never a cached copy.
function computeProjectStats(projectPath, now = new Date()) {
    const events = readEventLines(projectPath);
    return aggregateStats(events, now);
}

// Reads <workspaceDir>/.meridian/projects.json and resolves each entry's
// display name from its own project-info.json (falling back to the
// directory's basename), mirroring the name resolution server.js's
// getStatusData() does — duplicated here in miniature because this module
// owns its own filesystem reads and server.js must stay a thin route.
// A missing or malformed registry returns [] rather than throwing; a
// project directory without a readable project-info.json still gets an
// entry (name falls back to basename).
function listRegisteredProjects(workspaceDir) {
    const registryPath = path.join(workspaceDir, '.meridian', 'projects.json');
    if (!fs.existsSync(registryPath)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (err) {
        return [];
    }
    return (parsed.projects || []).map(p => {
        const projPath = p.path;
        let name = path.basename(projPath);
        try {
            const infoPath = path.join(projPath, '.meridian', 'project-info.json');
            if (fs.existsSync(infoPath)) {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                if (info && info.name) name = info.name;
            }
        } catch (err) {
            // fall back to basename
        }
        return { path: projPath, name };
    });
}

// Merges already-read per-project event arrays into one workspace-wide
// aggregate. `projectEntries` is [{path, name, events}] — events already
// read by the caller, so this function stays pure/fs-free like
// aggregateStats. Each project's own per-task math is computed by
// aggregateTaskStats (the same code aggregateStats uses), so a task's stage
// totals are identical whether read through the single-project or
// workspace-wide path.
//
// Task keys are `${projectPath}::${taskId}` because task ids are only
// unique within one project — two projects can both have a "T1". Each
// task's value additionally carries `task` (the bare id) and `project`
// ({path, name}) so the UI never has to parse the composite key. Stage
// top-N entries (topByTime/topByTokens) get the same `project` tag added,
// so an outlier identifies which project it belongs to.
//
// A project with no events (missing events.jsonl, or none read due to an
// upstream error) contributes nothing — no task entries, no stage entries —
// without any special-casing here.
function aggregateWorkspaceStats(projectEntries, now = new Date()) {
    const tasks = {};
    const stageTimeEntries = new Map();
    const stageTokenEntries = new Map();
    const stageAgentEntries = new Map();
    const stageVisitEntries = new Map();

    for (const entry of projectEntries || []) {
        if (!entry || typeof entry.path !== 'string') continue;
        const project = { path: entry.path, name: entry.name || entry.path };
        const {
            tasks: projTasks, stageTimeEntries: projTime, stageTokenEntries: projTokens,
            stageAgentEntries: projAgents, stageVisitEntries: projVisits
        } = aggregateTaskStats(entry.events, now);

        for (const [taskId, t] of Object.entries(projTasks)) {
            tasks[`${entry.path}::${taskId}`] = { task: taskId, project, ...t };
        }
        for (const [stage, list] of projTime) {
            if (!stageTimeEntries.has(stage)) stageTimeEntries.set(stage, []);
            stageTimeEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
        for (const [stage, list] of projTokens) {
            if (!stageTokenEntries.has(stage)) stageTokenEntries.set(stage, []);
            stageTokenEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
        for (const [stage, list] of projAgents) {
            if (!stageAgentEntries.has(stage)) stageAgentEntries.set(stage, []);
            stageAgentEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
        for (const [stage, list] of projVisits) {
            if (!stageVisitEntries.has(stage)) stageVisitEntries.set(stage, []);
            stageVisitEntries.get(stage).push(...list.map(e => ({ ...e, project })));
        }
    }

    return { tasks, stages: shapeStages(stageTimeEntries, stageTokenEntries, stageAgentEntries, stageVisitEntries) };
}

// Reads every registered project's events.jsonl fresh — no caching — and
// aggregates across all of them. A project whose events.jsonl can't be read
// (I/O error other than "file missing", which readEventLines already
// tolerates) contributes an `errors` entry instead of failing the whole
// request; its own data is simply absent from tasks/stages.
function computeWorkspaceStats(workspaceDir, now = new Date()) {
    const registered = listRegisteredProjects(workspaceDir);
    const errors = [];
    const projectEntries = registered.map(p => {
        try {
            return { path: p.path, name: p.name, events: readEventLines(p.path) };
        } catch (err) {
            errors.push({ file: `${p.name} (events.jsonl)`, message: err.message });
            return { path: p.path, name: p.name, events: [] };
        }
    });
    const { tasks, stages } = aggregateWorkspaceStats(projectEntries, now);
    return { tasks, stages, errors };
}

module.exports = {
    aggregateStats, computeProjectStats, readEventLines, TOP_N,
    aggregateWorkspaceStats, computeWorkspaceStats, listRegisteredProjects
};
