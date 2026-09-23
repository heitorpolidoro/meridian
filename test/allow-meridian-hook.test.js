const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The permission hook that lets a headless dispatch reach its own server.
//
// It auto-approves tool calls, so what it REFUSES matters more than what it
// allows: the refuse cases below are the point of this file. The previous
// version matched the server address anywhere in the command string, which
// approved `curl localhost:3333/... && rm -rf ~` on the strength of its
// first half.

const HOOK = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian',
    'scripts', 'allow-meridian.sh');

function ask(payload) {
    const out = execFileSync('bash', [HOOK], {
        input: JSON.stringify(payload), encoding: 'utf8'
    }).trim();
    return out ? JSON.parse(out) : null;
}

const bash = (command, extra = {}) =>
    ask({ tool_name: 'Bash', tool_input: { command }, ...extra });
const read = (file_path, extra = {}) =>
    ask({ tool_name: 'Read', tool_input: { file_path }, ...extra });

const allowsClaude = res => Boolean(res && res.hookSpecificOutput
    && res.hookSpecificOutput.hookEventName === 'PermissionRequest'
    && res.hookSpecificOutput.permissionDecision === 'allow');

test('a plain curl to the Meridian server is approved, wrapped or not', () => {
    // `rtk` is a token-saving proxy that rewrites curl on this machine; both
    // spellings reach the same server and both must pass.
    assert.ok(allowsClaude(bash('curl -sS -f http://localhost:3333/api/status')));
    assert.ok(allowsClaude(bash('rtk curl -sS http://localhost:3333/api/status')));
    assert.ok(allowsClaude(bash('curl -sS -X PUT http://127.0.0.1:3333/api/projects/tasks/T-1')));
});

test('a curl written against the documented variable is approved', () => {
    // The skills spell the address `"$BASE/api/status"` after setting BASE
    // from MERIDIAN_URL, so the literal server address never appears.
    assert.ok(allowsClaude(bash('curl -sS -f "$BASE/api/status"')));
    assert.ok(allowsClaude(bash('curl -sS "${MERIDIAN_URL:-http://localhost:3333}/api/status"')));
});

test("reading the plugin's own reference documents is approved", () => {
    // They live outside the project directory, so an unaided dispatch cannot
    // read the instructions it is being asked to follow.
    // The three install layouts this has to cover, verbatim.
    assert.ok(allowsClaude(read('/w/meridian/plugin/plugins/meridian/references/preamble.md')));
    assert.ok(allowsClaude(read('/h/.claude/plugins/cache/meridian/meridian/0.2.1/references/schema.md')));
    assert.ok(allowsClaude(read('/h/.gemini/config/plugins/meridian/references/pipeline.md')));
});

test('Antigravity gets its own dialect', () => {
    // A hook that answers in the wrong format is silently ignored.
    const res = bash('curl -sS http://localhost:3333/api/status', { conversationId: 'c-1' });
    assert.equal(res.decision, 'allow');
    assert.equal(res.hookSpecificOutput, undefined);
});

test('a command that merely CONTAINS the address is refused', () => {
    // The whole reason this hook was rewritten.
    assert.equal(bash('curl -sS http://localhost:3333/api/status && rm -rf ~'), null);
    assert.equal(bash('curl -sS http://localhost:3333/api/status; cat ~/.ssh/id_rsa'), null);
    assert.equal(bash('curl -sS http://localhost:3333/api/status | sh'), null);
    assert.equal(bash('echo localhost:3333 > /tmp/x'), null);
});

test('shell substitution anywhere disqualifies the command', () => {
    assert.equal(bash('curl -sS http://localhost:3333/api/status$(whoami)'), null);
    assert.equal(bash('curl -sS http://localhost:3333/`hostname`'), null);
});

test('a loop over the reference paths is refused, not smuggled through', () => {
    // The exact shape a real run produced, and the reason the skills no
    // longer ask for a shell probe at all.
    assert.equal(bash('for f in preamble pipeline; do\n  echo localhost:3333/$f\ndone'), null);
});

test('curl to anywhere else is refused', () => {
    assert.equal(bash('curl -sS https://example.invalid/exfiltrate'), null);
    assert.equal(bash('curl -sS http://localhost:8080/api/status'), null);
});

test('a non-curl command is refused even when it names the server', () => {
    assert.equal(bash('nc localhost 3333'), null);
    assert.equal(bash('wget http://localhost:3333/api/status'), null);
    assert.equal(bash('python3 -c "import urllib.request; urllib.request.urlopen(\'http://localhost:3333\')"'), null);
});

test('reading anything outside the plugin references is refused', () => {
    assert.equal(read('/Users/someone/project/.env'), null);
    assert.equal(read('/Users/someone/.ssh/id_rsa'), null);
    assert.equal(read('/w/meridian/plugin/plugins/meridian/scripts/running-flag.sh'), null);
    // A .md beside the references, but not one of the four shared documents.
    assert.equal(read('/w/meridian/plugin/plugins/meridian/references/secrets.md'), null);
});

test('an unrecognised tool is left to the normal permission flow', () => {
    assert.equal(ask({ tool_name: 'WebFetch', tool_input: { url: 'http://localhost:3333' } }), null);
    assert.equal(ask({ tool_name: 'Bash', tool_input: {} }), null);
    assert.equal(ask({}), null);
});
