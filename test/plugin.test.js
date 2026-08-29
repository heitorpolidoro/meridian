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
