'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getTasks, saveTasks } = require('../lib/tasks');

const registry = path.join(process.cwd(), '.meridian', 'projects.json');
const { projects } = JSON.parse(fs.readFileSync(registry, 'utf8'));

let failures = 0;

for (const { path: projPath } of projects) {
    let data;
    try {
        data = getTasks(projPath);
    } catch (err) {
        // A malformed tasks.json is never normalized away: writing here would
        // replace the backlog with an empty array. Skip it and report loudly.
        console.error(`${projPath}: SKIPPED — ${err.message}`);
        failures++;
        continue;
    }
    saveTasks(projPath, data);
    const done = data.tasks.filter(t => t.status === 'done');
    const stamped = done.filter(t => t.completed_at);
    console.log(`${projPath}: ${data.tasks.length} tasks, ${stamped.length}/${done.length} done with completed_at`);
}

if (failures > 0) {
    console.error(`${failures} project(s) skipped due to a malformed tasks.json.`);
    process.exitCode = 1;
}
