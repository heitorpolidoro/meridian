const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finalEvent, dispatchOutcome } = require('../lib/dispatch-outcome');

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
test('an unrecognised failure is surfaced verbatim, trimmed to the end', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = dispatchOutcome({ stdout: noise, code: 3 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /line 199/, 'keeps the end, where the error is');
    assert.ok(out.reason.length < 1000, 'but does not dump the whole run');
});
