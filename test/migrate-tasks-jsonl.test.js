const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProject } = require('../scripts/migrate-tasks-jsonl');

function legacyProject(tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.json'),
        JSON.stringify(tasks, null, 2)
    );
    return dir;
}

const TASKS = [
    { id: 'A-1', title: 'um', status: 'done', priority: 'high', expected_results: ['r1', 'r2'], completed_at: '2026-01-01T00:00:00.000Z' },
    { id: 'A-2', title: 'dois', status: 'backlog', priority: 'medium', expected_results: [] }
];

test('migrateProject: converts, verifies and retires the legacy file', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);

    const lines = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(!lines[0].includes('expected_results'));
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, '.meridian', 'tasks', 'A-1.json'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks', 'A-2.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), true);
    assert.ok(fs.readdirSync(path.join(dir, '.meridian')).some(f => f.startsWith('tasks.json.bak.')));
});

test('migrateProject: dry-run leaves the legacy file in place', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
});

test('migrateProject: dry-run leaves no trace behind after a successful verification', () => {
    // getTasks prefers tasks.jsonl the instant it exists, so a dry-run that
    // left one behind would migrate the board for real, silently, the moment
    // someone ran "just to check". A dry-run must leave the project exactly
    // as it found it.
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
});

test('migrateProject: both tasks.jsonl and tasks.json present is refused, not silently skipped', () => {
    // This shape means a prior run wrote tasks.jsonl but never retired
    // tasks.json — getTasks is already serving the new file. Treating it as
    // "already migrated" would report ok without re-verifying anything, and
    // the operator would never learn tasks.json was left behind.
    const dir = legacyProject(TASKS);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /manual inspection/i);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), true);
});

test('migrateProject: a verification mismatch aborts with the legacy file intact', () => {
    const dir = legacyProject(TASKS);
    // Um id duplicado faz duas linhas disputarem o mesmo arquivo de detalhe:
    // a releitura não bate com o original e a migração tem de recusar.
    const broken = [{ id: 'A-1', expected_results: ['r1'] }, { id: 'A-1', expected_results: ['r9'] }];
    const brokenContent = JSON.stringify(broken, null, 2);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), brokenContent);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification/i);
    // Conteúdo real, não só presença: prova que o arquivo não foi tocado, nem
    // truncado, nem reescrito — byte a byte o que estava lá antes de rodar.
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8'), brokenContent);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
    // O tasks.jsonl não-verificado não pode sobreviver ao abort — getTasks o
    // serviria como se a migração tivesse dado certo.
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), false);
    const bakFiles = fs.readdirSync(path.join(dir, '.meridian')).filter(f => f.startsWith('tasks.json.bak.'));
    assert.equal(bakFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', bakFiles[0]), 'utf8'), brokenContent);
});

test('migrateProject: a project already on jsonl is skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /already/i);
});

const { renameTaskDetails } = require('../scripts/migrate-task-ids');

test('renameTaskDetails: simple rename moves the detail file with content intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ids-'));
    const tasksDir = path.join(dir, '.meridian', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'OLD-1.json'), JSON.stringify({ expected_results: ['r1'] }));

    renameTaskDetails(dir, { 'OLD-1': 'NEW-1' });
    assert.equal(fs.existsSync(path.join(tasksDir, 'OLD-1.json')), false);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(tasksDir, 'NEW-1.json'), 'utf8')),
        { expected_results: ['r1'] }
    );
});

test('renameTaskDetails: missing file is tolerated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ids-'));
    const tasksDir = path.join(dir, '.meridian', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    renameTaskDetails(dir, { 'MISSING-1': 'NEW-2' });
    // Should not throw
});

test('renameTaskDetails: cycle remap preserves all content without corruption', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ids-'));
    const tasksDir = path.join(dir, '.meridian', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    const content1 = { expected_results: ['from-A-2'] };
    const content2 = { expected_results: ['from-A-1'] };
    fs.writeFileSync(path.join(tasksDir, 'A-2.json'), JSON.stringify(content1));
    fs.writeFileSync(path.join(tasksDir, 'A-1.json'), JSON.stringify(content2));

    // Cycle: A-2 → A-1, A-1 → A-2. Without two-phase rename, one overwrites the other.
    renameTaskDetails(dir, { 'A-2': 'A-1', 'A-1': 'A-2' });

    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(tasksDir, 'A-1.json'), 'utf8')),
        content1
    );
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(tasksDir, 'A-2.json'), 'utf8')),
        content2
    );
    // No temp files should remain
    const files = fs.readdirSync(tasksDir);
    assert.ok(!files.some(f => f.endsWith('.tmp')));
});

const { parseArgs, runningServerPid, main } = require('../scripts/migrate-tasks-jsonl');

test('migrateProject: a task without an id is refused before the backup', () => {
    // saveTasks would write this one as tasks/undefined.json — unreachable
    // forever, since getTask matches on id. Nothing may be written at all.
    const dir = legacyProject([{ title: 'sem id', expected_results: ['r1'] }]);
    const before = fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /id/i);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.meridian')), ['tasks.json']);
});

test('migrateProject: an id that escapes the tasks directory is refused before the backup', () => {
    const dir = legacyProject([{ id: '../escaped', expected_results: ['r1'] }]);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /escaped/);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'escaped.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.meridian')), ['tasks.json']);
});

test('migrateProject: an id-less task leaves no tasks/ directory behind', () => {
    // Two id-less tasks used to reach verification, fail it, and leave
    // tasks/undefined.json plus a tasks/ directory that did not exist before.
    const dir = legacyProject([{ id: undefined, title: 'a' }, { title: 'b' }]);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), false);
});

test('parseArgs: --dry-run and --registry are understood', () => {
    assert.equal(parseArgs([]).dryRun, false);
    assert.equal(parseArgs(['--dry-run']).dryRun, true);
    assert.equal(parseArgs(['--registry', '/tmp/x.json']).registry, '/tmp/x.json');
    assert.equal(parseArgs(['--dry-run', '--registry', '/tmp/x.json']).dryRun, true);
});

test('parseArgs: anything else is a hard error, not a silent real run', () => {
    for (const argv of [['--dryrun'], ['--dry_run'], ['--dry-run=true'], ['-n'], ['whatever'], ['--registry']]) {
        assert.throws(() => parseArgs(argv), /unknown argument|requires a path/i, 'accepted ' + JSON.stringify(argv));
    }
});

test('runningServerPid: a live pid is reported, a stale or absent one is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-'));
    const live = path.join(dir, 'live.pid');
    fs.writeFileSync(live, String(process.pid) + '\n');
    assert.equal(runningServerPid(live), process.pid);

    const stale = path.join(dir, 'stale.pid');
    // A pid that cannot exist: kill(pid, 0) raises ESRCH, which is "stale".
    fs.writeFileSync(stale, '4194303');
    assert.equal(runningServerPid(stale), null);

    assert.equal(runningServerPid(path.join(dir, 'absent.pid')), null);
    fs.writeFileSync(path.join(dir, 'junk.pid'), 'not a pid');
    assert.equal(runningServerPid(path.join(dir, 'junk.pid')), null);
});

function fixtureRegistry(projectDirs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-reg-'));
    const registryPath = path.join(dir, 'projects.json');
    fs.writeFileSync(registryPath, JSON.stringify({ projects: projectDirs.map(p => ({ path: p })) }));
    return registryPath;
}

test('main: a running server aborts the whole run before any project is touched', () => {
    const proj = legacyProject(TASKS);
    const before = fs.readFileSync(path.join(proj, '.meridian', 'tasks.json'), 'utf8');
    const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-')), 'server.pid');
    fs.writeFileSync(pidPath, String(process.pid));

    const code = main(['--registry', fixtureRegistry([proj])], { pidPath });
    assert.notEqual(code, 0);
    assert.equal(fs.readFileSync(path.join(proj, '.meridian', 'tasks.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(proj, '.meridian')), ['tasks.json']);
});

test('main: a stale pid file does not block the run', () => {
    const proj = legacyProject(TASKS);
    const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-')), 'server.pid');
    fs.writeFileSync(pidPath, '4194303');

    const code = main(['--registry', fixtureRegistry([proj])], { pidPath });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(proj, '.meridian', 'tasks.jsonl')), true);
    assert.equal(fs.existsSync(path.join(proj, '.meridian', 'tasks.json.migrated')), true);
});

test('main: an unrecognized flag exits non-zero without touching anything', () => {
    const proj = legacyProject(TASKS);
    const before = fs.readFileSync(path.join(proj, '.meridian', 'tasks.json'), 'utf8');
    const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-')), 'server.pid');

    const code = main(['--dryrun', '--registry', fixtureRegistry([proj])], { pidPath });
    assert.notEqual(code, 0);
    assert.equal(fs.readFileSync(path.join(proj, '.meridian', 'tasks.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(proj, '.meridian')), ['tasks.json']);
});

test('main: --registry points the run at a fixture workspace', () => {
    const proj = legacyProject(TASKS);
    const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-')), 'server.pid');
    const code = main(['--dry-run', '--registry', fixtureRegistry([proj])], { pidPath });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(proj, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(proj, '.meridian', 'tasks.jsonl')), false);
});
