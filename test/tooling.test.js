const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    TOOLS, parsePluginState, parseReadiness, nextAction, commandFor, ptyWrap, needsPty
} = require('../lib/tooling');

test('the two supported CLIs carry a label and an icon', () => {
    assert.deepEqual(Object.keys(TOOLS).sort(), ['agy', 'claude']);
    for (const cli of Object.keys(TOOLS)) {
        assert.ok(TOOLS[cli].label, `${cli} has a label`);
        assert.match(TOOLS[cli].icon, /^\/icons\/.+\.png$/);
    }
});

// --- plugin state ------------------------------------------------------------

const CLAUDE_LIST = JSON.stringify([
    { id: 'claude-md-management@claude-plugins-official', version: '1.0.0', enabled: true },
    { id: 'meridian@meridian', version: '0.1.0', scope: 'user', enabled: true }
]);

test('claude: the meridian entry is found by its id prefix, with its version', () => {
    assert.deepEqual(parsePluginState('claude', CLAUDE_LIST), { installed: true, version: '0.1.0' });
});

test('claude: a list without meridian reads as not installed', () => {
    const other = JSON.stringify([{ id: 'code-simplifier@claude-plugins-official', version: '1.0.0' }]);
    assert.deepEqual(parsePluginState('claude', other), { installed: false, version: null });
});

// agy reports a different shape: an `imports` array of names, no versions.
test('agy: the meridian entry is found in imports', () => {
    const list = JSON.stringify({ imports: [{ name: 'conductor' }, { name: 'meridian' }] });
    assert.deepEqual(parsePluginState('agy', list), { installed: true, version: null });
});

test('agy: a list without meridian reads as not installed', () => {
    const list = JSON.stringify({ imports: [{ name: 'conductor' }] });
    assert.deepEqual(parsePluginState('agy', list), { installed: false, version: null });
});

// A CLI that is missing, erroring or printing a banner must not read as
// "installed" — the screen would then offer Uninstall for something absent.
test('unparseable output reads as not installed rather than throwing', () => {
    for (const junk of ['', 'command not found', '<html>502</html>', null, undefined]) {
        assert.deepEqual(parsePluginState('claude', junk), { installed: false, version: null });
        assert.deepEqual(parsePluginState('agy', junk), { installed: false, version: null });
    }
});

// --- readiness ---------------------------------------------------------------

test('claude: loggedIn true is ready, false carries the reason', () => {
    assert.deepEqual(
        parseReadiness('claude', JSON.stringify({ loggedIn: true, authMethod: 'claudeai' }), 0),
        { ready: true, reason: null }
    );
    const out = parseReadiness('claude', JSON.stringify({ loggedIn: false, authMethod: 'none' }), 0);
    assert.equal(out.ready, false);
    assert.match(out.reason, /not authenticated/i);
});

// Antigravity has no auth verb at all, so readiness is whether `agy models`
// could reach the service — it needs working credentials and costs nothing.
test('agy: a zero exit from the models probe is ready', () => {
    assert.deepEqual(parseReadiness('agy', 'gemini-3.8-flash-high\tGemini', 0), { ready: true, reason: null });
});

test('agy: a non-zero exit is not ready and reports what came back', () => {
    const out = parseReadiness('agy', 'Error: could not fetch models', 1);
    assert.equal(out.ready, false);
    assert.match(out.reason, /could not fetch models/);
});

test('claude: unparseable auth output is not ready rather than optimistically ready', () => {
    const out = parseReadiness('claude', 'zsh: command not found: claude', 127);
    assert.equal(out.ready, false);
    assert.ok(out.reason);
});

// --- which action the button offers ------------------------------------------

test('claude: not authenticated asks for login before anything else', () => {
    assert.equal(nextAction('claude', { installed: false, ready: false }), 'login');
    assert.equal(nextAction('claude', { installed: true, ready: false }), 'login');
});

test('authenticated and missing offers install; present offers uninstall', () => {
    assert.equal(nextAction('claude', { installed: false, ready: true }), 'install');
    assert.equal(nextAction('claude', { installed: true, ready: true }), 'uninstall');
});

// agy has no login action to offer, so readiness never changes its button —
// the screen reports the reason separately instead of offering a dead button.
test('agy never offers login, whatever its readiness', () => {
    assert.equal(nextAction('agy', { installed: false, ready: false }), 'install');
    assert.equal(nextAction('agy', { installed: true, ready: false }), 'uninstall');
    assert.equal(nextAction('agy', { installed: false, ready: true }), 'install');
});

// --- the command shown is the command run ------------------------------------

test('every action resolves to an argv and a display string built from it', () => {
    const opts = { pluginDir: '/ws/meridian/plugin/plugins/meridian' };
    for (const [cli, actions] of [['claude', ['install', 'uninstall', 'login']], ['agy', ['install', 'uninstall']]]) {
        for (const action of actions) {
            const cmd = commandFor(cli, action, opts);
            assert.ok(Array.isArray(cmd.argv) && cmd.argv.length > 0, `${cli}/${action} has argv`);
            assert.equal(cmd.argv[0], cli);
            assert.equal(cmd.display, cmd.argv.join(' '));
        }
    }
});

test('agy install carries the plugin directory it was given', () => {
    const cmd = commandFor('agy', 'install', { pluginDir: '/ws/meridian/plugin/plugins/meridian' });
    assert.ok(cmd.argv.includes('/ws/meridian/plugin/plugins/meridian'));
});

// The client sends an action name, never a command. Anything unknown must
// resolve to nothing at all, or this screen becomes a remote shell.
test('an unknown cli or action yields no command', () => {
    assert.equal(commandFor('claude', 'rm -rf /', {}), null);
    assert.equal(commandFor('agy', 'login', {}), null);
    assert.equal(commandFor('bash', 'install', {}), null);
    assert.equal(commandFor('claude', '', {}), null);
});

// --- allocating a terminal ---------------------------------------------------
//
// `claude auth login` refuses to behave without a TTY, and a plain spawn gives
// pipes. `script` is a system tool on both platforms, so no dependency is
// added — but its syntax differs, and the repo runs on macOS while CI is Linux.

test('on macOS the command is wrapped in BSD script syntax', () => {
    assert.deepEqual(
        ptyWrap(['claude', 'auth', 'login'], 'darwin'),
        ['script', '-q', '/dev/null', 'claude', 'auth', 'login']
    );
});

test('on Linux the command is wrapped in GNU script syntax, as one -c string', () => {
    assert.deepEqual(
        ptyWrap(['claude', 'auth', 'login'], 'linux'),
        ['script', '-qec', 'claude auth login', '/dev/null']
    );
});

test('only login needs a terminal; the plugin commands do not', () => {
    assert.equal(needsPty('login'), true);
    assert.equal(needsPty('install'), false);
    assert.equal(needsPty('uninstall'), false);
});

test('login pre-answers the account prompt so no keystroke is needed', () => {
    const cmd = commandFor('claude', 'login', {});
    assert.deepEqual(cmd.argv, ['claude', 'auth', 'login', '--claudeai']);
});

// --- the installed copy drifting from the repository -------------------------

test('an installed copy that no longer matches the repo offers update', () => {
    assert.equal(nextAction('claude', { installed: true, ready: true, current: false }), 'update');
    assert.equal(nextAction('agy', { installed: true, ready: true, current: false }), 'update');
});

test('uninstall returns once the copy matches again', () => {
    assert.equal(nextAction('claude', { installed: true, ready: true, current: true }), 'uninstall');
});

// Login still outranks drift: updating a plugin into a CLI that cannot run is
// busywork.
test('an unauthenticated claude still asks for login before update', () => {
    assert.equal(nextAction('claude', { installed: true, ready: false, current: false }), 'login');
});

test('update resolves to a command for both CLIs', () => {
    assert.deepEqual(commandFor('claude', 'update', {}).argv, ['claude', 'plugin', 'update', 'meridian@meridian']);
    assert.deepEqual(commandFor('agy', 'update', { pluginDir: '/ws/p' }).argv, ['agy', 'plugin', 'install', '/ws/p']);
});

// --- the CLI itself not being installed --------------------------------------
//
// Every state above assumes the binary exists. When it does not, the probes
// fail at spawn and the old model fell through to its nearest branch: Claude
// offered "Login" for a binary that is not there, and the readiness pill
// printed a raw Node error. Absence is its own state, and it outranks the
// rest — nothing can be installed into, or logged into, a CLI that is absent.

const { isCliMissing } = require('../lib/tooling');

const ENOENT = { stdout: '', stderr: 'spawn claude ENOENT', code: 127 };
const WORKED = { stdout: '[]', stderr: '', code: 0 };

test('both probes failing to spawn means the CLI is not installed', () => {
    assert.equal(isCliMissing(ENOENT, { ...ENOENT, stderr: 'spawn agy ENOENT' }), true);
});

// A binary that exists cannot ENOENT, so one working probe settles it. This
// keeps a CLI that is merely erroring from being reported as absent.
test('a CLI that answers either probe is present, however badly it answered', () => {
    assert.equal(isCliMissing(WORKED, ENOENT), false);
    assert.equal(isCliMissing(ENOENT, WORKED), false);
    assert.equal(isCliMissing({ stdout: '', stderr: 'boom', code: 1 }, { stdout: '', stderr: 'boom', code: 1 }), false);
});

test('missing probe results do not read as an absent CLI', () => {
    assert.equal(isCliMissing(null, null), false);
    assert.equal(isCliMissing(undefined, ENOENT), false);
});

test('an absent CLI outranks every other action, including login', () => {
    assert.equal(nextAction('claude', { present: false, installed: false, ready: false }), 'missing');
    assert.equal(nextAction('agy', { present: false, installed: false, ready: false }), 'missing');
    // Login would otherwise win here; a binary that is not there cannot log in.
    assert.equal(nextAction('claude', { present: false, installed: true, ready: false, current: false }), 'missing');
});

test('a present CLI behaves exactly as before', () => {
    assert.equal(nextAction('claude', { present: true, installed: true, ready: true, current: true }), 'uninstall');
    // Absent `present` means the caller did not probe for it — not absence.
    assert.equal(nextAction('claude', { installed: true, ready: true, current: true }), 'uninstall');
});

// There is no command to offer: installing a CLI is a platform-specific
// `curl | sh` that Meridian has no business running. The screen links to the
// vendor's own instructions instead.
test('the missing state resolves to no runnable command', () => {
    assert.equal(commandFor('claude', 'missing', {}), null);
    assert.equal(commandFor('agy', 'missing', {}), null);
});

test('each CLI carries the official installation page it links to', () => {
    for (const cli of Object.keys(TOOLS)) {
        assert.match(TOOLS[cli].installUrl, /^https:\/\//, `${cli} links over https`);
    }
    assert.equal(TOOLS.claude.installUrl, 'https://code.claude.com/docs/en/setup');
    assert.equal(TOOLS.agy.installUrl, 'https://antigravity.google/docs/getting-started?tab=cli');
});
