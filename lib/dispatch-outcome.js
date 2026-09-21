'use strict';

// Did the dispatch succeed, and if not, what does the operator need to read?
//
// The exit code is not enough and neither CLI has a flag to change that:
// `agy -p` was measured printing "no output produced — a tool required the
// 'command' permission that headless mode cannot prompt for, so it was
// auto-denied" and exiting 0. So the verdict comes from the structured final
// event of the stream, and a run that produced no result at all is a failure
// whatever the exit code says.
//
// The two CLIs wrap that event differently. Captured 2026-09-20:
//   claude: {"type":"result","is_error":false,"result":"…",
//            "permission_denials":[],"terminal_reason":"completed"}
//   agy:    {"event":"result","result":{"status":"SUCCESS","response":"…"}}

const AUTH_REMEDY = 'CLI not authenticated — run `claude auth login`';
const ALLOWLIST_REMEDY = 'Run stopped: a command is outside the allowlist';

// Measured repeatedly on a machine that routinely runs five or more Claude
// Code sessions at once: several of them renew the OAuth token at the same
// moment and one loses the race. It is the only failure shape in this
// catalogue that resolves itself — the CLI's own message says so, and says
// to retry — so it gets a `retryable` flag the runner (server.js) can
// branch on, rather than every other failure, which needs a human.
const OAUTH_CONTENTION_PATTERN = /failed to refresh oauth token/i;
const OAUTH_CONTENTION_REMEDY = 'OAuth token refresh contention — another Claude Code process is renewing '
    + 'it; this is transient, and the run will be retried once';

// Unstructured fallbacks. These only fire when no result event arrived, which
// is why they stay: output that never became JSON still has to be readable.
const TEXT_SHAPES = [
    [/failed to authenticate|oauth session expired/i, AUTH_REMEDY],
    [/permission that headless mode cannot prompt for/i, ALLOWLIST_REMEDY],
    [OAUTH_CONTENTION_PATTERN, OAUTH_CONTENTION_REMEDY]
];

// Whether this failure is the transient OAuth-refresh race, from the raw
// text the CLI produced — checked independently of translateText so the
// `retryable` flag survives however that text ended up being worded.
function isOAuthContention(text) {
    return OAUTH_CONTENTION_PATTERN.test(String(text || ''));
}

function isResultEvent(obj) {
    return obj && (obj.type === 'result' || obj.event === 'result');
}

// The last result event in the stream. Lines that are not JSON are skipped:
// a CLI is free to print a banner, and one bad line must not lose the verdict.
function finalEvent(text) {
    if (typeof text !== 'string') return null;
    let found = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isResultEvent(parsed)) found = parsed;
        } catch (err) {
            // Not JSON, or a partial line. Keep looking.
        }
    }
    return found;
}

function tail(text, lines = 12, cap = 800) {
    const body = String(text || '').trim().split('\n').slice(-lines).join('\n');
    return body.length > cap ? body.slice(-cap) : body;
}

function translateText(text) {
    for (const [pattern, remedy] of TEXT_SHAPES) {
        if (pattern.test(String(text || ''))) return remedy;
    }
    return null;
}

// A denial is structured, so it is read rather than matched, and the command
// that was refused is named — that is the thing the operator has to add.
function denialReason(denials) {
    if (!Array.isArray(denials) || denials.length === 0) return null;
    const first = denials[0] || {};
    const what = (first.tool_input && (first.tool_input.command || first.tool_input.file_path))
        || first.tool_name || 'a tool call';
    return `${ALLOWLIST_REMEDY} (${what})`;
}

function dispatchOutcome({ stdout, code }) {
    const event = finalEvent(stdout);

    if (!event) {
        // No verdict at all. This is the measured exit-0-with-nothing case.
        const translated = translateText(stdout);
        return {
            ok: false,
            reason: translated || `the run produced no result${code ? ` (exit ${code})` : ''}: ${tail(stdout)}`,
            summary: '',
            retryable: isOAuthContention(stdout)
        };
    }

    if (event.type === 'result') {
        const denial = denialReason(event.permission_denials);
        if (denial) return { ok: false, reason: denial, summary: String(event.result || ''), retryable: false };
        if (event.is_error || event.terminal_reason === 'error') {
            return {
                ok: false,
                reason: translateText(event.result) || tail(event.result) || 'the run reported an error',
                summary: String(event.result || ''),
                retryable: isOAuthContention(event.result)
            };
        }
        return { ok: true, reason: null, summary: String(event.result || '') };
    }

    // agy
    const result = event.result || {};
    const response = String(result.response || '').trim();
    if (result.status !== 'SUCCESS') {
        return {
            ok: false,
            reason: translateText(response) || tail(response) || `the run reported ${result.status || 'no status'}`,
            summary: response,
            retryable: isOAuthContention(response)
        };
    }
    return { ok: true, reason: null, summary: response };
}

module.exports = { finalEvent, dispatchOutcome, isOAuthContention, OAUTH_CONTENTION_REMEDY };
