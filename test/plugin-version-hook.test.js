const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The guard that makes AGENTS.md's version-bump rule hold: a commit touching
// the plugin must raise the manifest version, because `claude plugin update`
// is version-gated and a missed bump fails silently.
//
// Exercised against a real throwaway repository rather than by reading the
// script, since what is being tested IS git's behaviour — above all that an
// amend of an already-bumped commit is not asked to bump a second time.

const HOOK = path.join(__dirname, '..', '.githooks', 'pre-commit');
const MANIFEST = 'plugin/plugins/meridian/.claude-plugin/plugin.json';

function git(repo, ...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Returns { ok, stderr } instead of throwing: a refusal is the expected
// outcome of half these tests, not an error.
function commit(repo, message, extraArgs = []) {
    try {
        git(repo, 'commit', '-m', message, ...extraArgs);
        return { ok: true, stderr: '' };
    } catch (err) {
        return { ok: false, stderr: String(err.stderr || '') };
    }
}

function writeManifest(repo, version) {
    const file = path.join(repo, MANIFEST);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: 'meridian', version }, null, 2) + '\n');
}

function writeSkill(repo, text) {
    const file = path.join(repo, 'plugin/plugins/meridian/skills/work/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function repoWithBaseline() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hook-'));
    git(repo, 'init', '-q', '.');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    // The hook under test, installed exactly as `npm install` installs it.
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.copyFileSync(HOOK, path.join(repo, '.githooks', 'pre-commit'));
    fs.chmodSync(path.join(repo, '.githooks', 'pre-commit'), 0o755);
    git(repo, 'config', 'core.hooksPath', '.githooks');

    writeManifest(repo, '0.2.0');
    writeSkill(repo, 'original\n');
    fs.writeFileSync(path.join(repo, 'server.js'), '// unrelated\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'baseline');
    return repo;
}

test('a plugin change without a version bump is refused', () => {
    const repo = repoWithBaseline();
    writeSkill(repo, 'edited\n');
    git(repo, 'add', '-A');

    const res = commit(repo, 'feat: change a skill');
    assert.equal(res.ok, false, 'the commit must not be created');
    assert.match(res.stderr, /still declares 0\.2\.0/);
    assert.match(res.stderr, /skills\/work\/SKILL\.md/, 'names the offending files');
    assert.equal(git(repo, 'log', '--oneline').trim().split('\n').length, 1,
        'only the baseline commit exists');
});

test('a plugin change with a version bump is allowed', () => {
    const repo = repoWithBaseline();
    writeSkill(repo, 'edited\n');
    writeManifest(repo, '0.2.1');
    git(repo, 'add', '-A');

    assert.equal(commit(repo, 'fix: change a skill').ok, true);
});

test('a commit that does not touch the plugin bumps nothing', () => {
    const repo = repoWithBaseline();
    fs.writeFileSync(path.join(repo, 'server.js'), '// changed\n');
    git(repo, 'add', '-A');

    assert.equal(commit(repo, 'refactor: server only').ok, true);
});

test('amending an already-bumped commit is not asked to bump again', () => {
    // On an amend the baseline is the amended commit's PARENT; comparing
    // against HEAD would see the bump already there and demand another.
    // Both spellings are covered: `--amend --no-edit` and `--amend -m`, which
    // an earlier prepare-commit-msg version could not tell apart.
    const repo = repoWithBaseline();
    writeSkill(repo, 'edited\n');
    writeManifest(repo, '0.2.1');
    git(repo, 'add', '-A');
    assert.equal(commit(repo, 'fix: change a skill').ok, true);

    writeSkill(repo, 'edited again\n');
    git(repo, 'add', '-A');
    const res = commit(repo, 'fix: change a skill, reworded', ['--amend']);
    assert.equal(res.ok, true, res.stderr);
    assert.equal(git(repo, 'log', '--oneline').trim().split('\n').length, 2,
        'the amend replaced the commit rather than adding one');

    // The same amend with no message rewrite at all.
    writeSkill(repo, 'edited a third time\n');
    git(repo, 'add', '-A');
    const noEdit = execFileSync('git', ['commit', '--amend', '--no-edit'],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(noEdit, /fix: change a skill, reworded/);
});

test('amending a commit that never bumped is still refused', () => {
    const repo = repoWithBaseline();
    fs.writeFileSync(path.join(repo, 'server.js'), '// changed\n');
    git(repo, 'add', '-A');
    assert.equal(commit(repo, 'refactor: server only').ok, true);

    // Now amend it into a plugin change, with no bump.
    writeSkill(repo, 'edited\n');
    git(repo, 'add', '-A');
    assert.equal(commit(repo, 'refactor: and a skill', ['--amend']).ok, false);
});

test('--no-verify walks past the guard, as every hook can', () => {
    // Documented rather than defended: a hook is a guard, not a gate, and
    // this escape hatch is why the check lives in pre-commit — a wrong
    // refusal must always have a way out.
    const repo = repoWithBaseline();
    writeSkill(repo, 'edited\n');
    git(repo, 'add', '-A');
    assert.equal(commit(repo, 'feat: bypass', ['--no-verify']).ok, true);
});
