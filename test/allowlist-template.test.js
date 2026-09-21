const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectRunner, allowlistFor } = require('../lib/allowlist-template');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-allowlist-'));
}

test('detectRunner finds mix.exs', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'mix.exs'), 'defmodule Foo.MixProject do end');
    assert.equal(detectRunner(dir), 'mix test');
});

test('detectRunner finds pyproject.toml', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.poetry]\nname = "x"\n');
    assert.equal(detectRunner(dir), 'pytest');
});

test('detectRunner finds pytest.ini', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    assert.equal(detectRunner(dir), 'pytest');
});

test('detectRunner finds a [tool:pytest] section in setup.cfg', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'setup.cfg'), '[metadata]\nname = x\n\n[tool:pytest]\ntestpaths = tests\n');
    assert.equal(detectRunner(dir), 'pytest');
});

test('a setup.cfg with no [tool:pytest] section is not pytest', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'setup.cfg'), '[metadata]\nname = x\n');
    assert.equal(detectRunner(dir), null);
});

test('detectRunner finds npm test in package.json', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    assert.equal(detectRunner(dir), 'npm test');
});

test('a package.json with no scripts.test is not npm test', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    assert.equal(detectRunner(dir), null);
});

test('an empty directory has no runner', () => {
    assert.equal(detectRunner(tmpDir()), null);
});

test('a directory that does not exist has no runner', () => {
    assert.equal(detectRunner(path.join(os.tmpdir(), 'meridian-allowlist-does-not-exist')), null);
});

test('mix wins over package.json when both are present', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'mix.exs'), 'defmodule Foo.MixProject do end');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    assert.equal(detectRunner(dir), 'mix test');
});

// The full deny list is read at call time from this repository's own
// .claude/settings.json, not hardcoded here — reading the same file the
// generator reads is how this test stays honest about what "the full deny
// list" means without duplicating it.
function ownDenyList() {
    const ownSettings = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'));
    return ownSettings.permissions.deny;
}

test("allowlistFor('mix test') includes that command and the full deny list", () => {
    const settings = allowlistFor('mix test');
    assert.ok(settings.permissions.allow.includes('Bash(mix test)'));
    assert.ok(settings.permissions.allow.includes('Bash(mix test:*)'));
    assert.deepEqual(settings.permissions.deny, ownDenyList());
});

test('allowlistFor(null) omits runner entries but keeps git and deny', () => {
    const settings = allowlistFor(null);
    assert.ok(!settings.permissions.allow.some(e => /test/.test(e)));
    assert.ok(settings.permissions.allow.some(e => e.startsWith('Bash(git ')));
    assert.deepEqual(settings.permissions.deny, ownDenyList());
});

test('the result of allowlistFor survives JSON.stringify/parse unchanged', () => {
    for (const runner of ['mix test', 'pytest', 'npm test', null]) {
        const settings = allowlistFor(runner);
        assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
    }
});
