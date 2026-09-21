const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finalEvent, dispatchOutcome, isOAuthContention } = require('../lib/dispatch-outcome');

// The exact message probed 2026-09-20, quoted in full because the pattern
// must survive it verbatim, not just some paraphrase of it.
const OAUTH_MESSAGE = 'Failed to refresh OAuth token: another Claude Code process is refreshing it '
    + 'or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close '
    + 'other Claude Code processes or sign in again';

const CLAUDE_OK = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    permission_denials: [], terminal_reason: 'completed', num_turns: 4
});
const AGY_OK = JSON.stringify({
    event: 'result',
    result: { conversation_id: 'c1', status: 'SUCCESS', response: 'done\n', num_turns: 4 }
});

const stream = (...lines) => lines.join('\n') + '\n';

test('the final result event is found past any amount of chatter', () => {
    const text = stream('{"type":"system","subtype":"init"}',
                        '{"type":"assistant"}', CLAUDE_OK);
    assert.equal(finalEvent(text).type, 'result');
});

test('unparseable lines are skipped rather than throwing', () => {
    const text = stream('not json at all', '', '   ', CLAUDE_OK);
    assert.equal(finalEvent(text).subtype, 'success');
});

test('a stream with no result event yields null', () => {
    assert.equal(finalEvent(stream('{"type":"assistant"}')), null);
    assert.equal(finalEvent(''), null);
    assert.equal(finalEvent(null), null);
});

test('a successful run of either CLI reads as ok', () => {
    for (const text of [stream(CLAUDE_OK), stream(AGY_OK)]) {
        assert.deepEqual(dispatchOutcome({ stdout: text, code: 0 }),
            { ok: true, reason: null, summary: 'done' });
    }
});

// The measured failure that started all of this: agy printed nothing useful
// and exited 0. A run with no result is a failure whatever the code says.
test('no result event is a failure even on exit 0', () => {
    const out = dispatchOutcome({ stdout: stream('{"type":"assistant"}'), code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /no result/i);
});

test('claude is_error is a failure and carries its text', () => {
    const text = stream(JSON.stringify({
        type: 'result', is_error: true, result: 'the model refused',
        permission_denials: [], terminal_reason: 'error'
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /the model refused/);
});

test('agy a non-SUCCESS status is a failure and carries its status', () => {
    const text = stream(JSON.stringify({
        event: 'result', result: { status: 'ERROR', response: 'boom' }
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /boom|ERROR/);
});

// A permission denial is structured now, so it is read rather than matched.
// This is the failure the allowlist causes, and it has a specific remedy.
test('a permission denial is translated to the allowlist remedy', () => {
    const text = stream(JSON.stringify({
        type: 'result', is_error: false, result: '',
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }],
        terminal_reason: 'completed'
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /outside the allowlist/i);
    assert.match(out.reason, /npm run lint/, 'names the command that was denied');
});

// Text matching survives only where the output arrived unstructured.
test('an auth failure in unstructured output is still translated', () => {
    const out = dispatchOutcome({ stdout: 'Failed to authenticate: OAuth session expired', code: 1 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not authenticated/i);
    assert.match(out.reason, /claude auth login/);
});

test('an unstructured denial message is translated too', () => {
    const out = dispatchOutcome({
        stdout: "a tool required the 'command' permission that headless mode cannot prompt for",
        code: 0
    });
    assert.match(out.reason, /outside the allowlist/i);
});

// A translation table that swallows what it does not recognise is worse than
// no table at all.
// CHANGE 3: the only failure shape in the catalogue that resolves itself.
// It must be detected from the structured outcome, with a field the runner
// can branch on, rather than a re-match of the text in server.js.
test('a claude result event failing on OAuth token refresh contention is retryable', () => {
    const text = stream(JSON.stringify({
        type: 'result', is_error: true, result: OAUTH_MESSAGE,
        permission_denials: [], terminal_reason: 'error'
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, true);
    assert.match(out.reason, /transient/i);
});

test('the same OAuth failure in unstructured output (no result event) is retryable', () => {
    const out = dispatchOutcome({ stdout: OAUTH_MESSAGE, code: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, true);
});

test('an agy failure carrying the OAuth message is retryable too', () => {
    const text = stream(JSON.stringify({
        event: 'result', result: { status: 'ERROR', response: OAUTH_MESSAGE }
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, true);
});

// Every other failure shape needs a human and must never retry: a
// permission denial, an authentication failure, and a model error all say
// nothing about a transient race, so retrying them burns tokens for nothing.
test('an authentication failure, a permission denial, and a plain model error are not retryable', () => {
    const authFailure = dispatchOutcome({ stdout: 'Failed to authenticate: OAuth session expired', code: 1 });
    assert.equal(authFailure.retryable, false);

    const denialText = stream(JSON.stringify({
        type: 'result', is_error: false, result: '',
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }],
        terminal_reason: 'completed'
    }));
    const denial = dispatchOutcome({ stdout: denialText, code: 0 });
    assert.equal(denial.retryable, false);

    const modelErrorText = stream(JSON.stringify({
        type: 'result', is_error: true, result: 'the model refused',
        permission_denials: [], terminal_reason: 'error'
    }));
    const modelError = dispatchOutcome({ stdout: modelErrorText, code: 0 });
    assert.equal(modelError.retryable, false);
});

test('isOAuthContention matches the exact message and rejects unrelated text', () => {
    assert.equal(isOAuthContention(OAUTH_MESSAGE), true);
    assert.equal(isOAuthContention('the model refused'), false);
    assert.equal(isOAuthContention(''), false);
    assert.equal(isOAuthContention(undefined), false);
});

test('an unrecognised failure is surfaced verbatim, trimmed to the end', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = dispatchOutcome({ stdout: noise, code: 3 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /line 199/, 'keeps the end, where the error is');
    assert.ok(out.reason.length < 1000, 'but does not dump the whole run');
});
