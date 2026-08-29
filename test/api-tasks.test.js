const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Builds an isolated fixture workspace: a registry at <ws>/.meridian/projects.json
// pointing at one project. The server is pointed here with MERIDIAN_RUNNING_DIR so
// the tests never see the six real projects.
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

test('POST /api/projects/tasks stores the extended fields and stamps dates', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: dir,
                title: 'Add a thing',
                expected_results: ['The thing exists'],
                priority: 'high',
                justification: 'because'
            })
        });
        assert.equal(res.status, 201);
        const { task } = await res.json();
        assert.equal(task.id, 'TST-1');
        assert.equal(task.status, 'backlog');
        assert.equal(task.priority, 'high');
        assert.deepEqual(task.expected_results, ['The thing exists']);
        assert.equal(task.justification, 'because');
        assert.ok(task.created_at && task.moved_at && task.updated_at);
    });
});

test('POST /api/projects/tasks defaults priority to medium', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'No priority given' })
        });
        const { task } = await res.json();
        assert.equal(task.priority, 'medium');
        assert.deepEqual(task.expected_results, []);
    });
});

async function seed(base, dir, body) {
    const res = await fetch(`${base}/api/projects/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, title: 'seed', ...body })
    });
    return (await res.json()).task;
}

async function put(base, dir, id, body) {
    const res = await fetch(`${base}/api/projects/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, ...body })
    });
    return (await res.json()).task;
}

test('PUT accepts the pipeline fields', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const task = await put(base, dir, 'TST-1', {
            spec_path: 'docs/tasks/TST-1-spec.md',
            spec_iterations: 2,
            code_review_iterations: 1,
            qa_iterations: 0,
            last_review_findings: ['missing test'],
            expected_results: ['works'],
            priority: 'critical'
        });
        assert.equal(task.spec_path, 'docs/tasks/TST-1-spec.md');
        assert.equal(task.spec_iterations, 2);
        assert.equal(task.code_review_iterations, 1);
        assert.equal(task.qa_iterations, 0);
        assert.deepEqual(task.last_review_findings, ['missing test']);
        assert.equal(task.priority, 'critical');
    });
});

test('PUT stamps completed_at when the task enters done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const task = await put(base, dir, 'TST-1', { status: 'done' });
        assert.ok(task.completed_at, 'completed_at should be set');
        assert.equal(task.completed_at, task.moved_at);
    });
});

test('PUT clears completed_at when the task leaves done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        await put(base, dir, 'TST-1', { status: 'done' });
        const task = await put(base, dir, 'TST-1', { status: 'inprogress' });
        assert.equal(task.completed_at, null);
    });
});

test('PUT without a status change leaves moved_at alone', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const seeded = await seed(base, dir);
        const task = await put(base, dir, 'TST-1', { title: 'renamed' });
        assert.equal(task.title, 'renamed');
        assert.equal(task.moved_at, seeded.moved_at);
    });
});

test('POST rejects a status outside the canonical nine', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'bad', status: 'in progress' })
        });
        assert.equal(res.status, 400);
        const { error } = await res.json();
        assert.match(error, /Invalid status 'in progress'/);
        assert.match(error, /inprogress/);
    });
});

test('POST rejects a priority outside the canonical four', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'bad', priority: 'urgent' })
        });
        assert.equal(res.status, 400);
        const { error } = await res.json();
        assert.match(error, /Invalid priority 'urgent'/);
        assert.match(error, /critical, high, medium, low/);
    });
});

test('PUT rejects the non-canonical statuses the board used to send', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        for (const bad of ['in progress', 'qa/review', 'ready to do', 'PENDING']) {
            const res = await fetch(`${base}/api/projects/tasks/TST-1`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: dir, status: bad })
            });
            assert.equal(res.status, 400, `status '${bad}' should be rejected`);
        }
        // The task is untouched by the rejected writes.
        const one = await (await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`)).json();
        assert.equal(one.projects[0].tasks[0].status, 'backlog');
    });
});

test('PUT accepts every one of the nine canonical statuses', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const all = ['backlog', 'specreview', 'readytodo', 'inprogress', 'codereview',
                     'qareview', 'blocked', 'done', 'nope'];
        for (const status of all) {
            const task = await put(base, dir, 'TST-1', { status });
            assert.equal(task.status, status);
        }
    });
});

test('PUT rejects an unknown priority', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const res = await fetch(`${base}/api/projects/tasks/TST-1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, priority: 'urgent' })
        });
        assert.equal(res.status, 400);
    });
});

test('GET /api/status?project= narrows to one project', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const all = await (await fetch(`${base}/api/status`)).json();
        assert.equal(all.projects.length, 1);
        const one = await (await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`)).json();
        assert.equal(one.projects.length, 1);
        assert.equal(one.projects[0].path, dir);

        const none = await (await fetch(`${base}/api/status?project=${encodeURIComponent('/nope')}`)).json();
        assert.equal(none.projects.length, 0);
    });
});

test('GET /api/status?limit= caps each status independently, not the total', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        // Three tasks in backlog, three moved to inprogress.
        for (let i = 0; i < 6; i++) await seed(base, dir);
        for (const id of ['TST-4', 'TST-5', 'TST-6']) {
            await put(base, dir, id, { status: 'inprogress' });
        }
        const res = await (await fetch(`${base}/api/status?limit=2`)).json();
        const tasks = res.projects[0].tasks;
        const perStatus = {};
        for (const t of tasks) perStatus[t.status] = (perStatus[t.status] || 0) + 1;
        assert.deepEqual(perStatus, { backlog: 2, inprogress: 2 },
            'each status is capped at 2, so a two-status project returns 4 tasks');
    });
});

test('GET /api/status?limit= orders a non-done status by priority then age', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        // Seeded in this order, so created_at is ascending by id.
        await seed(base, dir, { title: 'low one', priority: 'low' });        // TST-1
        await seed(base, dir, { title: 'critical', priority: 'critical' });  // TST-2
        await seed(base, dir, { title: 'medium old', priority: 'medium' });  // TST-3
        await seed(base, dir, { title: 'high', priority: 'high' });          // TST-4
        await seed(base, dir, { title: 'medium new', priority: 'medium' });  // TST-5

        const res = await (await fetch(`${base}/api/status?limit=5`)).json();
        const backlog = res.projects[0].tasks.filter(t => t.status === 'backlog');
        assert.deepEqual(backlog.map(t => t.id), ['TST-2', 'TST-4', 'TST-3', 'TST-5', 'TST-1'],
            'critical > high > medium > low, and the older medium comes first');

        const top = await (await fetch(`${base}/api/status?limit=1`)).json();
        assert.deepEqual(top.projects[0].tasks.map(t => t.id), ['TST-2']);
    });
});

test('GET /api/status?limit= orders done by completed_at, most recent first', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (let i = 0; i < 3; i++) await seed(base, dir);
        // Completed oldest-first, so TST-3 has the most recent completed_at.
        for (const id of ['TST-1', 'TST-2', 'TST-3']) {
            await put(base, dir, id, { status: 'done' });
            await new Promise(r => setTimeout(r, 5));
        }
        const res = await (await fetch(`${base}/api/status?limit=2`)).json();
        const done = res.projects[0].tasks.filter(t => t.status === 'done');
        assert.deepEqual(done.map(t => t.id), ['TST-3', 'TST-2'],
            'done is sorted by completed_at descending, and capped at the limit');
        // Priority must not leak into the done ordering.
        assert.ok(done.every(t => t.completed_at));
    });
});

test('GET /api/status?limit= never lets an unknown priority out-rank critical', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir, { title: 'critical', priority: 'critical' });
        await seed(base, dir, { title: 'unknown priority' });
        // The API refuses an unknown priority, so plant one the way a hand-edit would.
        const file = path.join(dir, '.meridian', 'tasks.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.find(t => t.id === 'TST-2').priority = 'urgent';
        fs.writeFileSync(file, JSON.stringify(raw, null, 2));

        const res = await (await fetch(`${base}/api/status?limit=1`)).json();
        assert.deepEqual(res.projects[0].tasks.map(t => t.id), ['TST-1'],
            "'urgent' must sort as medium, behind critical");
    });
});

test('GET /api/status with no query parameters returns every task unsorted', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (let i = 0; i < 3; i++) await seed(base, dir, { priority: 'low' });
        await put(base, dir, 'TST-1', { status: 'done' });
        const res = await (await fetch(`${base}/api/status`)).json();
        assert.deepEqual(res.projects[0].tasks.map(t => t.id), ['TST-1', 'TST-2', 'TST-3'],
            'file order is preserved when no limit is given');
    });
});

test('POST refuses to write over a malformed tasks.json', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir, { title: 'first' });
        await seed(base, dir, { title: 'second' });
        const file = path.join(dir, '.meridian', 'tasks.json');
        const whole = fs.readFileSync(file, 'utf8');
        const truncated = whole.slice(0, whole.length - 30);
        fs.writeFileSync(file, truncated);

        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'third' })
        });
        assert.equal(res.status, 500);
        assert.match((await res.json()).error, /Malformed tasks.json/);
        assert.equal(fs.readFileSync(file, 'utf8'), truncated,
            'the corrupt file must be left exactly as it was');
    });
});

test('PUT refuses to write over a malformed tasks.json', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const file = path.join(dir, '.meridian', 'tasks.json');
        fs.writeFileSync(file, '{not json');
        const res = await fetch(`${base}/api/projects/tasks/TST-1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, status: 'done' })
        });
        assert.equal(res.status, 500);
        assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
    });
});

test('GET /api/status reports a malformed tasks.json instead of showing no tasks', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), '{not json');
        const res = await (await fetch(`${base}/api/status`)).json();
        assert.equal(res.projects.length, 1);
        assert.deepEqual(res.projects[0].tasks, []);
        assert.ok(res.errors.some(e => /Malformed tasks.json/.test(e.message)),
            'the corruption must surface as an error, not as an empty board');
    });
});

test('GET /api/status?project= reports an error when nothing matches', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await (await fetch(`${base}/api/status?project=/nope/not/here`)).json();
        assert.equal(res.projects.length, 0);
        assert.equal(res.errors.length, 1);
        assert.match(res.errors[0].message, /not registered|no project/i);
    });
});

test('POST /api/projects gitignores .meridian/ like cli.js add does', async () => {
    const { ws } = workspaceWith('Test Project');
    const fresh = path.join(ws, 'fresh-project');
    fs.mkdirSync(fresh, { recursive: true });
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Fresh Project',
                path: fresh,
                stack: ['node'],
                description: 'x'
            })
        });
        assert.equal(res.status, 201);
        // The registration just wrote a task board into <project>/.meridian, and
        // schema.md tells agents that directory is gitignored. It has to be true.
        const gitignore = path.join(fresh, '.gitignore');
        assert.ok(fs.existsSync(gitignore), '.gitignore must be created when absent');
        assert.match(fs.readFileSync(gitignore, 'utf8'), /^\.meridian\/$/m);
    });
});

test('POST /api/projects appends to an existing .gitignore without eating a line', async () => {
    const { ws } = workspaceWith('Test Project');
    const fresh = path.join(ws, 'has-gitignore');
    fs.mkdirSync(fresh, { recursive: true });
    const gitignore = path.join(fresh, '.gitignore');
    fs.writeFileSync(gitignore, 'node_modules');  // no trailing newline
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Has Gitignore', path: fresh })
        });
        assert.equal(res.status, 201);
        const lines = fs.readFileSync(gitignore, 'utf8').split('\n');
        assert.ok(lines.includes('node_modules'), 'existing entries survive intact');
        assert.ok(lines.includes('.meridian/'), '.meridian/ is appended on its own line');
    });
});

test('POST honors a valid status instead of forcing backlog', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'codereview' });
        assert.equal(task.status, 'codereview');
        assert.ok(task.created_at && task.moved_at, 'still stamped on create');
    });
});

test('POST still defaults to backlog when no status is given', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir);
        assert.equal(task.status, 'backlog');
    });
});

test('POST stamps completed_at for a task created straight into done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'done' });
        assert.equal(task.status, 'done');
        assert.equal(task.completed_at, task.moved_at);
    });
});

test('POST leaves completed_at absent for any status other than done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'readytodo' });
        assert.equal(task.completed_at, undefined);
    });
});

test('POST still rejects a status outside the nine', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'x', status: 'todo' })
        });
        assert.equal(res.status, 400);
    });
});

test('GET with limit returns a summary computed over the whole board', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (let i = 0; i < 10; i++) await seed(base, dir);          // TST-1..10 in backlog
        const done = await seed(base, dir, { status: 'done' });       // TST-11
        await put(base, dir, 'TST-1', { status: 'inprogress' });
        await put(base, dir, 'TST-2', { running: true });
        await put(base, dir, 'TST-3', { status: 'blocked', blockedBy: [done.id] });
        await put(base, dir, 'TST-4', { status: 'blocked', blockedBy: ['TST-5'] });

        const res = await (await fetch(
            `${base}/api/status?project=${encodeURIComponent(dir)}&limit=5`)).json();
        const p = res.projects[0];

        const backlogPage = p.tasks.filter(t => t.status === 'backlog');
        assert.equal(backlogPage.length, 5, 'the page is still capped at five per status');
        assert.equal(p.summary.counts.backlog, 7, 'counts cover the whole board, not the page');
        assert.equal(p.summary.counts.done, 1);

        const interrupted = p.summary.interrupted.map(t => t.id).sort();
        assert.deepEqual(interrupted, ['TST-1', 'TST-2'], 'inprogress or running, both');

        assert.deepEqual(p.summary.unblockable.map(t => t.id), ['TST-3'],
            'blocked with every dependency done');
    });
});

test('GET without limit carries no summary', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const res = await (await fetch(
            `${base}/api/status?project=${encodeURIComponent(dir)}`)).json();
        assert.equal(res.projects[0].summary, undefined);
    });
});

test('GET with workable=1 returns only workable tasks, in selection order', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir, { priority: 'critical' });              // TST-1 backlog critical
        await seed(base, dir, { status: 'qareview', priority: 'low' }); // TST-2
        await seed(base, dir, { status: 'done' });                    // TST-3
        await seed(base, dir, { status: 'nope' });                    // TST-4
        await put(base, dir, 'TST-3', {});                            // no-op, keeps ids stable
        await seed(base, dir, { status: 'readytodo', priority: 'high' }); // TST-5
        await seed(base, dir, { status: 'readytodo', priority: 'critical' }); // TST-6
        const blocked = await seed(base, dir);                        // TST-7
        await put(base, dir, blocked.id, { status: 'blocked', blockedBy: ['TST-1'] });

        const res = await (await fetch(
            `${base}/api/status?project=${encodeURIComponent(dir)}&workable=1`)).json();
        const ids = res.projects[0].tasks.map(t => t.id);

        assert.ok(!ids.includes('TST-3'), 'done excluded');
        assert.ok(!ids.includes('TST-4'), 'nope excluded');
        assert.ok(!ids.includes('TST-7'), 'blocked excluded');
        assert.equal(ids[0], 'TST-2', 'stage beats priority: low qareview before critical backlog');
        assert.deepEqual(ids, ['TST-2', 'TST-6', 'TST-5', 'TST-1'],
            'stage first, then priority, then age');
    });
});
