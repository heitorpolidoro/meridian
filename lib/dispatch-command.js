'use strict';

// The exact command a dispatch runs, per CLI.
//
// Same shape as lib/tooling.js: a fixed table, argv rather than a string, and
// a caller that names a tool rather than supplying a command. The task id is
// the only variable, and it is validated before it reaches a spawn.
//
// Both CLIs run in stream-json. Text mode was measured to exit 0 while
// producing nothing ("a tool required the 'command' permission that headless
// mode cannot prompt for, so it was auto-denied"), so the exit code alone
// cannot be trusted. stream-json gives the live events the board renders and
// a structured verdict from the same mechanism.

// A task id, nothing else. This string reaches a spawn: argv means no shell
// interprets it, and this is the second layer.
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

// The measured median run is 11-15 minutes in `in_progress` alone, and a full
// `work` chains several stages. Two hours is well clear of the longest
// observed run without leaving a wedged process forever.
const DISPATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function dispatchCommand(tool, taskId) {
    if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) return null;

    const prompt = `/meridian:work ${taskId}`;
    const table = {
        // --verbose is not optional: probed 2026-09-20, `claude -p` refuses
        // --output-format stream-json without it.
        claude: ['claude', '-p', prompt,
                 '--output-format', 'stream-json', '--verbose',
                 '--permission-mode', 'acceptEdits'],
        // No --sandbox: it redirects relative writes to a scratch directory
        // while leaving absolute writes through, so it breaks legitimate
        // in-repo work without being a boundary. The allowlist is the
        // boundary.
        agy: ['agy', '-p', prompt,
              '--output-format', 'stream-json',
              '--mode', 'accept-edits',
              '--print-timeout', `${Math.round(DISPATCH_TIMEOUT_MS / 1000)}s`]
    };

    const argv = table[tool];
    if (!argv) return null;
    return { argv, display: argv.join(' ') };
}

module.exports = { dispatchCommand, DISPATCH_TIMEOUT_MS };
