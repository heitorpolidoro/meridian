const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same fixture pattern as test/api-tasks.test.js / test/api-events.test.js:
// an isolated workspace with one registered project, and a server spawned
// against it via MERIDIAN_RUNNING_DIR — never the real board.
function workspaceWith(name) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dir = path.join(ws, 'fixture-project');
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'project-info.json'),
        JSON.stringify({ name, key: 'TST', stack: [], description: 'x' })
    );
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: [{ path: dir }] })
    );
    return { ws, dir };
}

async function withServer(ws, fn) {
    const port = 3400 + Math.floor(Math.random() * 500);
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PORT: String(port), MERIDIAN_RUNNING_DIR: ws },
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const start = Date.now();
        let ready = false;
        for (let i = 0; i < 50; i++) {
            try { await fetch(`http://localhost:${port}/api/status`); ready = true; break; }
            catch { await new Promise(r => setTimeout(r, 100)); }
        }
        if (!ready) {
            throw new Error(
                `Server on port ${port} did not respond after ${Date.now() - start}ms.\n` +
                `stderr:\n${stderr || '(empty)'}`
            );
        }
        await fn(`http://localhost:${port}`);
    } finally {
        proc.kill('SIGKILL');
    }
}

async function seed(base, dir, body) {
    const res = await fetch(`${base}/api/projects/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, title: 'seed', ...body })
    });
    return (await res.json()).task;
}

async function put(base, dir, id, body) {
    return fetch(`${base}/api/projects/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, ...body })
    });
}

function eventsPath(dir) {
    return path.join(dir, '.meridian', 'events.jsonl');
}

// A workspace registering N projects, one shared .meridian/projects.json.
// Mirrors workspaceWith but for the workspace-aggregate ("no project param")
// tests this task adds.
function workspaceWithProjects(names) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dirs = names.map((name, i) => {
        const dir = path.join(ws, `fixture-project-${i}`);
        fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.meridian', 'project-info.json'),
            JSON.stringify({ name, key: `T${i}`, stack: [], description: 'x' })
        );
        return dir;
    });
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: dirs.map(path => ({ path })) })
    );
    return { ws, dirs };
}

test('GET /api/stats with no project query param returns 200 with a workspace-wide aggregate across two projects', async () => {
    const { ws, dirs } = workspaceWithProjects(['Project A', 'Project B']);
    await withServer(ws, async (base) => {
        const taskA = await seed(base, dirs[0], { status: 'backlog' });
        await put(base, dirs[0], taskA.id, { status: 'in_progress' });
        const taskB = await seed(base, dirs[1], { status: 'backlog' });
        await put(base, dirs[1], taskB.id, { status: 'in_progress' });

        const res = await fetch(`${base}/api/stats`);
        assert.equal(res.status, 200);
        const body = await res.json();

        const keyA = `${dirs[0]}::${taskA.id}`;
        const keyB = `${dirs[1]}::${taskB.id}`;
        assert.ok(body.tasks[keyA], 'project A task present under composite key');
        assert.ok(body.tasks[keyB], 'project B task present under composite key');
        assert.equal(body.tasks[keyA].project.path, dirs[0]);
        assert.equal(body.tasks[keyA].project.name, 'Project A');
        assert.equal(body.tasks[keyB].project.path, dirs[1]);
        assert.equal(body.tasks[keyB].project.name, 'Project B');
    });
});

test('GET /api/stats?project= (present but blank) still returns 400', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/stats?project=`);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /project is required/i);
    });
});

test('GET /api/stats?project=<one of two> returns only that project\'s tasks', async () => {
    const { ws, dirs } = workspaceWithProjects(['Project A', 'Project B']);
    await withServer(ws, async (base) => {
        const taskA = await seed(base, dirs[0], { status: 'backlog' });
        const taskB = await seed(base, dirs[1], { status: 'backlog' });

        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent(dirs[0])}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.tasks[taskA.id]);
        assert.ok(!body.tasks[taskB.id]);
        assert.equal(body.tasks[taskA.id].project, undefined);
    });
});

test('a third registered project with no events.jsonl contributes no entries and no error to the workspace aggregate', async () => {
    const { ws, dirs } = workspaceWithProjects(['Project A', 'Project B', 'Project C']);
    await withServer(ws, async (base) => {
        await seed(base, dirs[0], { status: 'backlog' });
        assert.ok(!fs.existsSync(eventsPath(dirs[2])));

        const res = await fetch(`${base}/api/stats`);
        assert.equal(res.status, 200);
        const body = await res.json();
        const cKeys = Object.keys(body.tasks).filter(k => k.startsWith(`${dirs[2]}::`));
        assert.deepEqual(cKeys, []);
        assert.deepEqual(body.errors, []);
    });
});

test('a malformed line in one project\'s events.jsonl does not fail the no-project-param request', async () => {
    const { ws, dirs } = workspaceWithProjects(['Project A', 'Project B']);
    await withServer(ws, async (base) => {
        const taskA = await seed(base, dirs[0], { status: 'backlog' });
        await put(base, dirs[0], taskA.id, { status: 'in_progress' });
        const taskB = await seed(base, dirs[1], { status: 'backlog' });
        await put(base, dirs[1], taskB.id, { status: 'in_progress' });
        fs.appendFileSync(eventsPath(dirs[0]), 'not json\n');

        const res = await fetch(`${base}/api/stats`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.tasks[`${dirs[1]}::${taskB.id}`]);
    });
});

test('two consecutive no-project-param GET /api/stats calls with a mutation in between return different tasks — no caching', async () => {
    const { ws, dirs } = workspaceWithProjects(['Project A', 'Project B']);
    await withServer(ws, async (base) => {
        const taskA = await seed(base, dirs[0], { status: 'backlog' });

        const res1 = await fetch(`${base}/api/stats`);
        const body1 = await res1.json();

        await put(base, dirs[0], taskA.id, { status: 'in_progress' });

        const res2 = await fetch(`${base}/api/stats`);
        const body2 = await res2.json();

        const key = `${dirs[0]}::${taskA.id}`;
        assert.notDeepEqual(body1.tasks[key], body2.tasks[key]);
        assert.ok(!(body1.tasks[key] && body1.tasks[key].stages.in_progress));
        assert.ok(body2.tasks[key].stages.in_progress);
    });
});

test('GET /app.js contains the stats-icon-btn class and the stats-tab-selection branch', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/app.js`);
        const body = await res.text();
        assert.match(body, /stats-icon-btn/);
        assert.match(body, /initialTab === 'stats'/);
    });
});

test('GET /api/stats?project=<unregistered path> returns 200 with empty tasks/stages and a not-registered error', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent('/not/registered/anywhere')}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.tasks, {});
        assert.deepEqual(body.stages, {});
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].message, /not registered/i);
    });
});

test('GET /api/stats?project=<registered, no events.jsonl yet> returns 200 with empty tasks/stages and no errors', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        assert.ok(!fs.existsSync(eventsPath(dir)));
        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.tasks, {});
        assert.deepEqual(body.stages, {});
        assert.deepEqual(body.errors, []);
    });
});

test('GET /api/stats reflects real status-change events from a seeded task', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'backlog' });
        await put(base, dir, task.id, { status: 'in_progress' });

        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        const stats = body.tasks[task.id];
        assert.ok(stats, 'stats for seeded task present');
        assert.ok(stats.stages.backlog);
        assert.ok(stats.stages.in_progress);
        assert.ok(stats.stages.backlog.totalMs >= 0);
        assert.ok(stats.stages.in_progress.totalMs >= 0);
        assert.equal(stats.stages.in_progress.ongoing, true);
    });
});

test('GET /api/stats reflects a dispatch_tokens event posted via the API', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'backlog' });
        await fetch(`${base}/api/projects/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: dir, task: task.id, type: 'dispatch_tokens',
                output_tokens: 500, context_tokens: 12000
            })
        });

        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        const body = await res.json();
        const stats = body.tasks[task.id];
        assert.equal(stats.dispatches.count, 1);
        assert.equal(stats.dispatches.totalOutputTokens, 500);
        assert.equal(stats.dispatches.maxContextTokens, 12000);
    });
});

test('a malformed line appended directly to events.jsonl does not fail GET /api/stats', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'backlog' });
        await put(base, dir, task.id, { status: 'in_progress' });
        fs.appendFileSync(eventsPath(dir), 'not json\n');

        const res = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        const stats = body.tasks[task.id];
        assert.ok(stats.stages.backlog);
        assert.ok(stats.stages.in_progress);
    });
});

test('two GET /api/stats calls with a mutation in between return different data — no caching', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'backlog' });

        const res1 = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        const body1 = await res1.json();

        await put(base, dir, task.id, { status: 'in_progress' });

        const res2 = await fetch(`${base}/api/stats?project=${encodeURIComponent(dir)}`);
        const body2 = await res2.json();

        assert.notDeepEqual(body1.tasks[task.id].stages, body2.tasks[task.id].stages);
        assert.ok(!body1.tasks[task.id].stages.in_progress);
        assert.ok(body2.tasks[task.id].stages.in_progress);
    });
});

test('GET / serves index.html containing the Stats tab and panel markup', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/`);
        const body = await res.text();
        assert.match(body, /id="tab-stats-btn"/);
        assert.match(body, /id="stats-panel"/);
        assert.match(body, /id="stats-stage-tbody"/);
        assert.match(body, /id="stats-task-tbody"/);
        assert.match(body, /class="stats-col-project"/);
        assert.match(body, /data-sort="project"/);
    });
});
