const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchCommand, DISPATCH_TIMEOUT_MS } = require('../lib/dispatch-command');

test('both CLIs invoke the work skill for the given task', () => {
    for (const tool of ['claude', 'agy']) {
        const cmd = dispatchCommand(tool, 'MERID-12');
        assert.equal(cmd.argv[0], tool);
        assert.ok(cmd.argv.includes('/meridian:work MERID-12'),
            `${tool} passes the slash command as one argv entry`);
        assert.equal(cmd.display, cmd.argv.join(' '));
    }
});

// Probed 2026-09-20: `claude -p --output-format stream-json` without
// --verbose exits immediately with "requires --verbose". Without this the
// feature never runs once.
test('claude asks for stream-json and the --verbose it requires', () => {
    const { argv } = dispatchCommand('claude', 'T-1');
    assert.ok(argv.includes('--output-format'));
    assert.ok(argv.includes('stream-json'));
    assert.ok(argv.includes('--verbose'), 'stream-json is refused without it');
});

test('agy asks for stream-json and an explicit timeout', () => {
    const { argv } = dispatchCommand('agy', 'T-1');
    assert.ok(argv.includes('--output-format'));
    assert.ok(argv.includes('stream-json'));
    const at = argv.indexOf('--print-timeout');
    assert.notEqual(at, -1, 'timeout is stated rather than inherited');
    assert.match(argv[at + 1], /^\d+[ms]$/);
});

// Probed: a relative write under --sandbox landed in the CLI's scratch
// directory instead of the repository, while an absolute write to /tmp
// succeeded. It breaks real work without preventing escape.
test('agy never runs sandboxed', () => {
    assert.ok(!dispatchCommand('agy', 'T-1').argv.includes('--sandbox'));
});

test('neither CLI is given a permission mode that bypasses the allowlist', () => {
    for (const tool of ['claude', 'agy']) {
        const flat = dispatchCommand(tool, 'T-1').argv.join(' ');
        assert.ok(!/bypassPermissions|dangerously/i.test(flat));
    }
});

// The task id reaches a spawn. Anything that is not an id must not get there,
// and argv (no shell) plus this guard are the two layers that stop it.
test('an id that is not a plain task id yields no command', () => {
    for (const bad of ['T-1; rm -rf /', '$(whoami)', '../../etc/passwd', '', null]) {
        assert.equal(dispatchCommand('claude', bad), null, `refused: ${bad}`);
    }
});

test('an unknown tool yields no command', () => {
    assert.equal(dispatchCommand('bash', 'T-1'), null);
    assert.equal(dispatchCommand('', 'T-1'), null);
});

test('the timeout is well above the longest observed run', () => {
    assert.ok(DISPATCH_TIMEOUT_MS >= 2 * 60 * 60 * 1000, 'at least two hours');
});
