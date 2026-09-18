const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLACEHOLDER, renderInto } = require('../scripts/render-agy-hooks');

const ROOT = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian');

// Antigravity's hook manifest needs an absolute command path and documents no
// plugin-root variable. That absolute path is a fact about one machine, so it
// cannot live in version control — the repository carries a placeholder and
// the installed copy gets the real directory written into it.
test('the tracked manifest carries the placeholder and no absolute path', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8');
    assert.ok(raw.includes(PLACEHOLDER), 'placeholder present');
    assert.doesNotMatch(raw, /\/Users\/|\/home\/|\/Volumes\//, 'no machine path');
    JSON.parse(raw);
});

test('rendering writes the install directory into every command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
    fs.copyFileSync(path.join(ROOT, 'hooks.json'), path.join(dir, 'hooks.json'));

    const changed = renderInto(dir);
    assert.equal(changed, true);

    const raw = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
    assert.ok(!raw.includes(PLACEHOLDER), 'placeholder consumed');
    assert.match(raw, /running-flag\.sh/);
    for (const hook of collectCommands(JSON.parse(raw))) {
        assert.ok(hook.startsWith(dir), `${hook} points into the install dir`);
    }
});

// Running the installer twice must not corrupt an already-rendered copy.
test('rendering is idempotent and reports when there is nothing to do', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
    fs.copyFileSync(path.join(ROOT, 'hooks.json'), path.join(dir, 'hooks.json'));
    renderInto(dir);
    const once = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
    assert.equal(renderInto(dir), false);
    assert.equal(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), once);
});

test('a directory with no manifest is reported, not thrown', () => {
    assert.equal(renderInto(path.join(os.tmpdir(), 'absent-' + Date.now())), false);
});

function collectCommands(node, out = []) {
    if (Array.isArray(node)) { node.forEach(n => collectCommands(n, out)); return out; }
    if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k === 'command' && typeof v === 'string') out.push(v);
            else collectCommands(v, out);
        }
    }
    return out;
}
