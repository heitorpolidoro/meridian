'use strict';
// Removes stale Meridian plugin snapshots from Claude Code's cache.
//
// `claude plugin install` copies the plugin into a commit-hash directory under
// ~/.claude/plugins/cache/meridian/meridian/ and never removes the previous
// one, so every reinstall leaves a snapshot behind — a dozen piled up in three
// days of iterating. Only the directory named by installed_plugins.json is
// live; everything beside it is unreachable.
//
// Run via `npm run plugin:reload`, which calls this after reinstalling.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const claudeDir = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
// Inside main(): this deletes directories, and at module scope it did so on
// import — including from a test that only wanted to load the file.
function main() {
    const registry = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    const cacheDir = path.join(claudeDir, 'plugins', 'cache', 'meridian', 'meridian');

    const installs = JSON.parse(fs.readFileSync(registry, 'utf8'))
        .plugins['meridian@meridian'] || [];
    const live = new Set(installs.map(i => path.basename(i.installPath)));
    if (live.size === 0) {
        console.error('No live meridian install found in the registry — refusing to prune.');
        process.exit(1);
    }

    let removed = 0;
    for (const entry of fs.readdirSync(cacheDir)) {
        if (live.has(entry)) continue;
        fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
        removed++;
    }
    console.log(`Pruned ${removed} stale snapshot(s); kept: ${[...live].join(', ')}`);
}

if (require.main === module) main();

module.exports = { main };
