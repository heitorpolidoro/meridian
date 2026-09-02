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
    'backlog', 'spec_review', 'ready_todo', 'in_progress',
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

module.exports = { isRecentlyCompleted, isRecentlyDismissed, manualTransition, byRecencyDesc, collapsedColumns };
