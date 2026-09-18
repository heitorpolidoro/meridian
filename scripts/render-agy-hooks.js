#!/usr/bin/env node
'use strict';

// Writes the real install directory into Antigravity's hook manifest.
//
// Antigravity's hooks.json needs an absolute command path — it documents no
// plugin-root variable, unlike Claude Code's ${CLAUDE_PLUGIN_ROOT}. An
// absolute path is a fact about one machine, so the repository carries a
// placeholder instead and this renders it at install time. `agy plugin
// install` copies the plugin rather than symlinking it, which is what makes
// this possible: the tracked file stays generic and only the copy is
// machine-specific.
//
// Run after `agy plugin install` — `npm run plugin:reload` does both.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLACEHOLDER = '__MERIDIAN_PLUGIN_DIR__';
const DEFAULT_INSTALL_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'meridian');

// Returns true when it wrote something. A copy that is already rendered, or a
// directory with no manifest, is not an error: the installer may simply not
// have run, and this must be safe to call unconditionally.
function renderInto(installDir) {
    const manifest = path.join(installDir, 'hooks.json');
    let raw;
    try {
        raw = fs.readFileSync(manifest, 'utf8');
    } catch (err) {
        return false;
    }
    if (!raw.includes(PLACEHOLDER)) return false;

    const rendered = raw.split(PLACEHOLDER).join(installDir);
    JSON.parse(rendered); // refuse to write something the CLI cannot read
    fs.writeFileSync(manifest, rendered);
    return true;
}

if (require.main === module) {
    const target = process.argv[2] || DEFAULT_INSTALL_DIR;
    const done = renderInto(target);
    console.log(done
        ? `Rendered Antigravity hooks into ${target}`
        : `Nothing to render in ${target} (already rendered, or not installed)`);
}

module.exports = { PLACEHOLDER, DEFAULT_INSTALL_DIR, renderInto };
