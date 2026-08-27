'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getTasks, saveTasks } = require('../lib/tasks');

const registry = path.join(process.cwd(), '.meridian', 'projects.json');
const { projects } = JSON.parse(fs.readFileSync(registry, 'utf8'));

for (const { path: projPath } of projects) {
    const data = getTasks(projPath);
    saveTasks(projPath, data);
    const done = data.tasks.filter(t => t.status === 'done');
    const stamped = done.filter(t => t.completed_at);
    console.log(`${projPath}: ${data.tasks.length} tasks, ${stamped.length}/${done.length} done with completed_at`);
}
