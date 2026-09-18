'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Is the installed plugin still the plugin in this repository?
//
// Neither CLI can answer that. Both install by copying, and both report a
// version that does not move when a file changes: Claude reports whatever the
// manifest declared at install time, Antigravity reports no version at all.
// So the check compares content — the failure this exists to catch is editing
// a skill and having the agent keep reading the old one, with nothing on
// screen to say so.
//
// The rule is one-directional: the installed copy is current when every file
// this repository ships arrived intact. Files it holds beyond that are the
// installer's own bookkeeping, not drift.

function walk(dir, base = dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, base, out);
        } else if (entry.isFile()) {
            out.push(path.relative(base, full));
        }
    }
    return out;
}

function digest(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (err) {
        return null;
    }
}

function comparePluginTrees(sourceDir, installedDir) {
    const files = walk(sourceDir).sort();
    if (files.length === 0) {
        // Nothing to compare against: report not current rather than claiming
        // a match nobody verified.
        return { current: false, differing: [], missing: [] };
    }

    const differing = [];
    const missing = [];
    for (const rel of files) {
        const installed = path.join(installedDir, rel);
        if (!fs.existsSync(installed)) {
            missing.push(rel);
            continue;
        }
        if (digest(path.join(sourceDir, rel)) !== digest(installed)) {
            differing.push(rel);
        }
    }

    return { current: differing.length === 0 && missing.length === 0, differing, missing };
}

// The version the installed copy declares. Read from the copy rather than
// from the CLI because neither reports it usefully: Antigravity reports no
// version at all, and Claude reports the marketplace revision it installed
// from, which says nothing about what the manifest declares.
function readInstalledVersion(installedDir) {
    for (const rel of [path.join('.claude-plugin', 'plugin.json'), 'plugin.json']) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(installedDir, rel), 'utf8'));
            if (parsed && typeof parsed.version === 'string' && parsed.version) return parsed.version;
        } catch (err) {
            // Missing or unreadable: try the next, then give up.
        }
    }
    return null;
}

module.exports = { comparePluginTrees, readInstalledVersion };
