const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// plugin.json exists twice: .claude-plugin/plugin.json is what Claude Code
// reads; the copy at the plugin root is what Antigravity reads. Two copies of
// one truth is the drift pattern that has bitten this repo before (the 72
// copied agent files, the CLI vs API registration) — this test is the guard.
test('the Antigravity plugin.json copy matches the Claude Code one', () => {
    const root = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian');
    const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const antigravity = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    assert.deepEqual(antigravity, claude);
});

// hooks.json also exists twice, but NOT as copies: hooks/hooks.json is Claude
// Code's format (events at top level, ${CLAUDE_PLUGIN_ROOT}); hooks.json at the
// plugin root is Antigravity's (named hooks, absolute command paths — no
// plugin-root variable is documented there, and the install is a symlink to
// this checkout, so the absolute path is deliberate). What must stay true in
// both: every command points at the same running-flag.sh, and it exists.
test('both hook manifests drive the same script, and it exists', () => {
    const root = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian');
    const script = path.join(root, 'scripts', 'running-flag.sh');
    assert.ok(fs.existsSync(script), 'running-flag.sh exists');
    assert.ok((fs.statSync(script).mode & 0o111) !== 0, 'and is executable');

    for (const manifest of ['hooks.json', path.join('hooks', 'hooks.json')]) {
        const raw = fs.readFileSync(path.join(root, manifest), 'utf8');
        JSON.parse(raw); // must be valid JSON
        assert.match(raw, /running-flag\.sh/, `${manifest} references the script`);
    }
});
