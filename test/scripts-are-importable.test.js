const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Requiring a migration script must not run the migration.
//
// migrate-task-ids.js called main() at module scope, so `require`-ing it for
// its exported helper ran a real migration against whatever registry the
// machine happened to have — writeJSON and renameSync included. It survived
// only because re-running it is a no-op once ids are already correct. On a
// machine with no registry it called process.exit(1) instead, which killed
// the whole test file: a fresh clone lost 19 tests and reported a failure.

const SCRIPTS = fs.readdirSync(path.join(__dirname, '..', 'scripts'))
    .filter(f => f.endsWith('.js'));

test('every script guards its entry point', () => {
    for (const file of SCRIPTS) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
        if (!/^\s*main\(\);?\s*$/m.test(src)) continue;
        assert.match(src, /require\.main === module/,
            `${file} calls main() at module scope without a require.main guard`);
    }
});

// The guard is the mechanism; this is the behaviour it exists to protect.
// Requiring each script from a directory with no registry must stay silent
// and must not exit.
test('requiring a script from an empty workspace does nothing', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-empty-'));
    for (const file of SCRIPTS) {
        const target = path.join(__dirname, '..', 'scripts', file);
        const out = execFileSync(process.execPath,
            ['-e', `require(${JSON.stringify(target)})`],
            { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.equal(out.trim(), '', `${file} printed on require: ${out.trim()}`);
    }
});
