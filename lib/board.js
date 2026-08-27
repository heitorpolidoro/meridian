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

module.exports = { isRecentlyCompleted };
