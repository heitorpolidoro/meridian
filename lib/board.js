'use strict';

// The done-column window rule. public/app.js carries an inline copy of this
// function: the frontend has no module system and no build step, so the rule
// cannot be imported there. This file is the source of truth — change both.
function isRecentlyCompleted(task, windowDays, now = new Date()) {
    if (windowDays === null || windowDays === undefined) return true;
    const raw = task && task.completed_at;
    if (!raw) return false;
    const completed = new Date(raw);
    if (Number.isNaN(completed.getTime())) return false;
    return (now.getTime() - completed.getTime()) <= windowDays * 24 * 60 * 60 * 1000;
}

// The only status changes the board offers a human. Everything else is the
// pipeline's job, driven through the API by meridian:work — a card dragged to
// an arbitrary status is how a task arrives at a stage whose prerequisites were
// never produced. `done` offers nothing: a finished task is not "won't do", and
// leaving `done` would null its completed_at. public/app.js carries an inline
// copy of this function for the same reason as above — change both.
const WORKING_STATUSES = [
    'backlog', 'specreview', 'readytodo', 'inprogress',
    'codereview', 'qareview', 'blocked'
];

function manualTransition(status) {
    if (status === 'nope') return { to: 'backlog', label: 'Reopen' };
    if (WORKING_STATUSES.includes(status)) return { to: 'nope', label: 'Nope' };
    return null;
}

module.exports = { isRecentlyCompleted, manualTransition };
