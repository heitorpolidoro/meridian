const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { comparePluginTrees, readInstalledVersion } = require('../lib/plugin-sync');

function tree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sync-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

const SOURCE = {
    'plugin.json': '{"name":"meridian"}',
    'skills/work/SKILL.md': '# work',
    'agents/qa.md': '# qa'
};

test('identical trees are current', () => {
    const a = tree(SOURCE);
    const b = tree(SOURCE);
    assert.deepEqual(comparePluginTrees(a, b), { current: true, differing: [], missing: [] });
});

test('a changed file is reported by its relative path', () => {
    const a = tree(SOURCE);
    const b = tree({ ...SOURCE, 'skills/work/SKILL.md': '# work, edited' });
    const out = comparePluginTrees(a, b);
    assert.equal(out.current, false);
    assert.deepEqual(out.differing, ['skills/work/SKILL.md']);
    assert.deepEqual(out.missing, []);
});

test('a file the installed copy never received is reported as missing', () => {
    const a = tree(SOURCE);
    const b = tree({ 'plugin.json': '{"name":"meridian"}', 'agents/qa.md': '# qa' });
    const out = comparePluginTrees(a, b);
    assert.equal(out.current, false);
    assert.deepEqual(out.missing, ['skills/work/SKILL.md']);
});

// An installer writes its own bookkeeping next to the files it copied. That is
// not drift: the question is whether everything the repo ships arrived intact,
// not whether the installed copy holds nothing else.
test('extra files in the installed copy do not make it outdated', () => {
    const a = tree(SOURCE);
    const b = tree({ ...SOURCE, '.gemini-extension-install.json': '{"installedAt":"now"}' });
    assert.equal(comparePluginTrees(a, b).current, true);
});

test('an installed directory that does not exist reads as not current', () => {
    const a = tree(SOURCE);
    const out = comparePluginTrees(a, path.join(os.tmpdir(), 'meridian-sync-absent-' + Date.now()));
    assert.equal(out.current, false);
    assert.equal(out.missing.length, 3);
});

test('a missing source directory reports not current rather than throwing', () => {
    const b = tree(SOURCE);
    const out = comparePluginTrees(path.join(os.tmpdir(), 'nope-' + Date.now()), b);
    assert.equal(out.current, false);
});

// Nested directories must be walked, or a stale skill three levels down would
// report as current — the exact bug this check exists to catch.
test('nested files are compared, not just the top level', () => {
    const a = tree({ 'skills/work/references/deep.md': 'one' });
    const b = tree({ 'skills/work/references/deep.md': 'two' });
    assert.deepEqual(comparePluginTrees(a, b).differing, ['skills/work/references/deep.md']);
});

// --- the version the installed copy declares ---------------------------------
//
// Neither CLI reports it usefully: Antigravity reports none at all, and Claude
// reports the marketplace revision it installed from. The copy itself carries
// the manifest, so that is where the declared version comes from.

test('the version is read from the canonical manifest', () => {
    const dir = tree({ '.claude-plugin/plugin.json': '{"name":"meridian","version":"0.1.0"}' });
    assert.equal(readInstalledVersion(dir), '0.1.0');
});

test('the root manifest is used when there is no .claude-plugin one', () => {
    const dir = tree({ 'plugin.json': '{"name":"meridian","version":"0.2.0"}' });
    assert.equal(readInstalledVersion(dir), '0.2.0');
});

test('the canonical manifest wins when both are present', () => {
    const dir = tree({
        '.claude-plugin/plugin.json': '{"version":"0.1.0"}',
        'plugin.json': '{"version":"9.9.9"}'
    });
    assert.equal(readInstalledVersion(dir), '0.1.0');
});

test('a manifest without a version, unreadable, or absent yields null', () => {
    assert.equal(readInstalledVersion(tree({ 'plugin.json': '{"name":"meridian"}' })), null);
    assert.equal(readInstalledVersion(tree({ 'plugin.json': 'not json' })), null);
    assert.equal(readInstalledVersion(path.join(os.tmpdir(), 'absent-' + Date.now())), null);
});
