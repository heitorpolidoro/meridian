'use strict';

// The aggregated all-tickets view's project filter.
//
// Every card in that view already carries the project it came from
// (`projectName`, `projectPath`, added when the flat list is built), so the
// filter is a pure function over the list the board already has — no request,
// no server-side view.
//
// `projectPath` is the identity, not `projectName`: two registered
// directories may legitimately declare the same name, and filtering by a
// label would silently merge them.

// The options the selector offers, one per project present in `tasks`,
// ordered by name so the list does not reshuffle as counts change. Counts
// come from the same list the board is about to render, so what the option
// promises and what selecting it shows cannot disagree.
function projectOptions(tasks) {
    const byPath = new Map();
    for (const task of tasks || []) {
        if (!task || !task.projectPath) continue;
        const entry = byPath.get(task.projectPath);
        if (entry) {
            entry.count++;
        } else {
            byPath.set(task.projectPath, {
                path: task.projectPath,
                name: task.projectName || task.projectPath,
                count: 1
            });
        }
    }
    return [...byPath.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

// An empty/absent selection means every project — the default, and what a
// selection that no longer matches anything must NOT silently become. A path
// that has vanished from the board returns an empty list instead, so the
// board shows "no cards" rather than quietly showing all of them, which would
// read as the filter having been cleared behind the operator's back.
function filterByProject(tasks, projectPath) {
    if (!projectPath) return tasks || [];
    return (tasks || []).filter(t => t && t.projectPath === projectPath);
}

module.exports = { projectOptions, filterByProject };
