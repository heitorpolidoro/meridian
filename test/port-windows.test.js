const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every test file that spawns a real server picks its ports from a
// deterministic `const PORT_BASE = <n>` plus a `nextPort++` counter, so two
// files never draw the same port and race each other under `node --test`'s
// parallel execution — a loser never binds, never answers, and times out,
// surfacing as an unrelated-looking failure in whichever file lost.
//
// This is the SECOND time that collision has happened. The first time, four
// files sharing one range were given disjoint deterministic bases; a fifth
// file (test/cli.test.js) was deliberately left drawing ports at random
// because its range did not overlap anything THEN. New files have since
// grown into it, and a `Math.random()` draw does not even fail
// consistently — it fails one run in some, on whichever file happened to
// lose the race that time. That is exactly the shape of bug that survives
// code review and shows up three days later as "the suite is flaky again".
//
// So the invariant is checked here, mechanically, rather than left as
// something the next person adding a server-spawning test file is supposed
// to already know: every PORT_BASE window is disjoint from every other,
// with room to spare. A new file that picks a colliding base fails THIS
// test, at `npm test`, the same day it is added.

const TEST_DIR = __dirname;

// A conservative, generic over-count: every test() block in a file that
// declares a PORT_BASE is assumed to draw one port, whether or not it
// actually spawns a server. This can only overstate a file's window, never
// understate it — every file in this suite that spawns servers today draws
// at most one port per test block (verified by hand when this test was
// written: `grep -c 'await withServer('` matched `grep -c '^test('`
// exactly, in every file that uses that helper) — so "room to spare" is
// built into the count itself, not just the gaps between windows.
function portWindows() {
    const windows = [];
    for (const file of fs.readdirSync(TEST_DIR)) {
        if (!file.endsWith('.test.js')) continue;
        const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
        const baseMatch = src.match(/^const PORT_BASE = (\d+);/m);
        if (!baseMatch) continue;
        const base = Number(baseMatch[1]);
        const testCount = (src.match(/^test\(/gm) || []).length;
        // Never zero: a file with a PORT_BASE but no counted test() blocks
        // would otherwise report a zero-width, always-"disjoint" window and
        // hide the very collision this test exists to catch.
        const size = Math.max(testCount, 1);
        windows.push({ file, base, end: base + size });
    }
    return windows;
}

test('every test file with a PORT_BASE claims a port window disjoint from every other', () => {
    const windows = portWindows();
    // Sanity: if this drops to 0 or 1, the scan itself is broken (e.g. the
    // PORT_BASE regex stopped matching a real declaration), not that the
    // suite suddenly stopped spawning servers.
    assert.ok(windows.length >= 5, `expected several PORT_BASE files, found ${windows.length}`);

    windows.sort((a, b) => a.base - b.base);
    for (let i = 0; i < windows.length - 1; i++) {
        const a = windows[i], b = windows[i + 1];
        assert.ok(
            a.end <= b.base,
            `${a.file} claims [${a.base}, ${a.end}) which overlaps ${b.file}'s window ` +
            `starting at ${b.base} — give one of them a fresh PORT_BASE clear of every ` +
            `other file's window (see the files listed by this same scan for what is taken)`
        );
    }
});
