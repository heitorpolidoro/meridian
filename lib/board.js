'use strict';

// The done-column window rule. public/app.js carries an inline copy of this
// function: the frontend has no module system and no build step, so the rule
// cannot be imported there. This file is the source of truth — change both.
function withinWindow(raw, windowDays, now) {
    if (windowDays === null || windowDays === undefined) return true;
    if (!raw) return false;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return false;
    return (now.getTime() - when.getTime()) <= windowDays * 24 * 60 * 60 * 1000;
}

function isRecentlyCompleted(task, windowDays, now = new Date()) {
    return withinWindow(task && task.completed_at, windowDays, now);
}

// The nope column shares the done column's window, but keyed on moved_at:
// completed_at is stamped only on entering `done`, so a dismissed task never
// has one. moved_at is when it was dismissed, which is the question anyway.
function isRecentlyDismissed(task, windowDays, now = new Date()) {
    return withinWindow(task && task.moved_at, windowDays, now);
}

// The only status changes the board offers a human. Everything else is the
// pipeline's job, driven through the API by meridian:work — a card dragged to
// an arbitrary status is how a task arrives at a stage whose prerequisites were
// never produced. `done` offers nothing: a finished task is not "won't do", and
// leaving `done` would null its completed_at. public/app.js carries an inline
// copy of this function for the same reason as above — change both.
const WORKING_STATUSES = [
    'backlog', 'spec_review', 'spec_approval', 'ready_todo', 'in_progress',
    'code_review', 'qa_review', 'blocked'
];

function manualTransition(status) {
    if (status === 'nope') return { to: 'backlog', label: 'Reopen' };
    if (WORKING_STATUSES.includes(status)) return { to: 'nope', label: 'Nope' };
    return null;
}

// Terminal columns sort by recency of the event that put the task there —
// completed_at for done, moved_at for nope — newest first, timestampless
// last. Id order is creation order, and an old task finished today belongs at
// the top, not buried under last week. public/app.js mirrors this; this file
// is the source of truth.
function byRecencyDesc(field) {
    return (a, b) => {
        const ra = (a && a[field]) || '';
        const rb = (b && b[field]) || '';
        return String(rb).localeCompare(String(ra));
    };
}

// Which columns render collapsed into rails. A column is "empty" when it holds
// zero tasks in that status in total — the done/nope window plays no part, so
// a done column whose every task is older than the window is a full column
// with a "+N concluídas" chip, never a rail. Empty columns collapse unless the
// operator expanded them this session; a column with any task never collapses.
// public/app.js mirrors this; this file is the source of truth.
function collapsedColumns(columns, expanded) {
    const open = expanded || new Set();
    const out = new Set();
    for (const col of columns || []) {
        if (col.count > 0) continue;
        if (open.has(col.id)) continue;
        out.add(col.id);
    }
    return out;
}

// A task is a "parent" when at least one other task on the board names it as
// `parent`. Scoped by projectPath when tasks carry one — the global view
// tags every task with its owning project before flattening every project's
// list into a single array, and two different projects can reuse the same
// task id. public/app.js mirrors this; this file is the source of truth.
function childrenOf(tasks, task) {
    return (tasks || []).filter(t =>
        t && task && t.parent === task.id &&
        (t.projectPath || null) === (task.projectPath || null)
    );
}

// null when the task has no children (nothing to show); otherwise the counts
// the board's progress chip renders. "done" mirrors the status a completed
// task carries, not the completed_at window done/nope columns apply — a
// child counts the moment its status is done, regardless of age.
function subtaskProgress(tasks, task) {
    const children = childrenOf(tasks, task);
    if (children.length === 0) return null;
    return { done: children.filter(t => t.status === 'done').length, total: children.length };
}

// null when the task has no parent; otherwise the label the child card's
// badge renders.
function parentBadge(task) {
    return task && task.parent ? `↳ ${task.parent}` : null;
}

// Which of the three situations is this task in? One button, and its label
// says which — enqueue is idempotent anyway, so an accidental double click
// cannot queue a task twice.
//
// public/app.js carries an inline copy: the frontend has no module system.
// This file is the source of truth — change both.
const NO_DISPATCH = ['done', 'nope'];

function dispatchButton(task, { queue, runningTaskId, dispatchGateBlocked, dispatchBlockedReason }) {
    if (!task || NO_DISPATCH.includes(task.status)) return null;
    // Running outranks queued. A task cannot honestly be both, and if the
    // state ever disagrees the useful button is the one that stops a process.
    if (task.id === runningTaskId) {
        return { action: 'stop', label: 'Stop', title: 'Signal the running session (SIGTERM)' };
    }
    if ((queue || []).includes(task.id)) {
        return { action: 'unqueue', label: 'Remove from queue', title: 'Drop this task from the queue' };
    }
    // The same gate the header's `Dispatch all` is disabled by, read from a
    // field of its own rather than from dispatchBlockedReason. That string
    // is overloaded: it also carries "a run is in flight", and an in-flight
    // run must NOT disable this button — queueing more work behind a running
    // one is the feature. Only a repository that can host no run at all,
    // which today means no allowlist, closes this gate. Stop and Remove
    // above stay enabled through it: both reduce activity.
    if (dispatchGateBlocked) {
        return {
            action: 'dispatch', label: 'Dispatch', disabled: true,
            title: dispatchBlockedReason || 'This repository cannot host a dispatch right now'
        };
    }
    return { action: 'dispatch', label: 'Dispatch', title: 'Queue this task; runs at once if the repo is free' };
}

module.exports = {
    isRecentlyCompleted, isRecentlyDismissed, manualTransition, byRecencyDesc,
    collapsedColumns, childrenOf, subtaskProgress, parentBadge, dispatchButton
};
