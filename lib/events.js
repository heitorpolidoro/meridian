'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Appends one JSON line to <project>/.meridian/events.jsonl — the full,
// append-only history of every status/running change and dispatch-token
// event a project has ever had. Never trimmed, never rewritten: MERID-4
// (aggregation) depends on every line staying exactly as written.
//
// Best-effort by design: a task write (create/update) must succeed even when
// this fails (disk full, permissions, races), so this never throws. Returns
// true on success, false otherwise — callers may ignore the return value.
function appendEvent(projectPath, event) {
    try {
        const meridianDir = path.join(projectPath, '.meridian');
        if (!fs.existsSync(meridianDir)) fs.mkdirSync(meridianDir, { recursive: true });
        const target = path.join(meridianDir, 'events.jsonl');
        fs.appendFileSync(target, JSON.stringify(event) + '\n', 'utf8');
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { appendEvent };
