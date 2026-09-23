'use strict';

const fs = require('fs');
const path = require('path');

// Builds a starting-point `.claude/settings.json` for a project Meridian is
// about to dispatch into. This is NOT a security audit of the target
// project — it is the minimum allowlist that lets a headless
// `claude -p ... --permission-mode acceptEdits` run reach its test and
// commit steps instead of dying after it has already edited files on disk.
// The operator is expected to review and extend what this writes.

// This repository's own settings.json is the single source of truth for
// the git allow entries and the deny list: both are read from it at call
// time (not copied into this module) so a future edit to that file changes
// every newly generated allowlist without a code change here. The cost is
// one extra file read per generation; that is cheaper than a second copy of
// the same rules quietly drifting from the original.
const OWN_SETTINGS_PATH = path.join(__dirname, '..', '.claude', 'settings.json');

function readOwnSettings() {
    try {
        return JSON.parse(fs.readFileSync(OWN_SETTINGS_PATH, 'utf8'));
    } catch (err) {
        return {};
    }
}

function gitAllowEntries() {
    const settings = readOwnSettings();
    const allow = settings.permissions && Array.isArray(settings.permissions.allow)
        ? settings.permissions.allow : [];
    return allow.filter(entry => /^Bash\(git /.test(entry));
}

function denyEntries() {
    const settings = readOwnSettings();
    return settings.permissions && Array.isArray(settings.permissions.deny)
        ? settings.permissions.deny : [];
}

// True when `iniPath` exists and contains a `[tool:pytest]` section — the
// one way a bare setup.cfg declares itself a pytest project.
function hasPytestSection(iniPath) {
    if (!fs.existsSync(iniPath)) return false;
    try {
        return /\[tool:pytest\]/.test(fs.readFileSync(iniPath, 'utf8'));
    } catch (err) {
        return false;
    }
}

function hasTestScript(pkgPath) {
    if (!fs.existsSync(pkgPath)) return false;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return Boolean(pkg && pkg.scripts && pkg.scripts.test);
    } catch (err) {
        return false;
    }
}

// Inspects the project root and returns the test command to allow, or null
// when nothing recognizable is there. Checked in order and stops at the
// first hit — a project can hold both a package.json and a mix.exs, and the
// more specific one wins.
function detectRunner(projectPath) {
    try {
        if (fs.existsSync(path.join(projectPath, 'mix.exs'))) return 'mix test';
        if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) return 'pytest';
        if (fs.existsSync(path.join(projectPath, 'pytest.ini'))) return 'pytest';
        if (hasPytestSection(path.join(projectPath, 'setup.cfg'))) return 'pytest';
        if (hasTestScript(path.join(projectPath, 'package.json'))) return 'npm test';
        return null;
    } catch (err) {
        // A directory that does not exist, or one we cannot read, has
        // nothing detectable in it — same as an empty directory.
        return null;
    }
}

function runnerAllowEntries(runner) {
    if (!runner) return [];
    return [`Bash(${runner})`, `Bash(${runner}:*)`];
}

// Builds the settings object for the detected runner. When `runner` is
// null the runner entries are omitted entirely rather than guessed —
// guessing wrong means a run that dies at the test step with a confusing
// reason, which is worse than an allowlist the operator must finish by
// hand.
function allowlistFor(runner) {
    return {
        permissions: {
            allow: [...runnerAllowEntries(runner), ...gitAllowEntries()],
            deny: denyEntries()
        }
    };
}

// What an existing allowlist is missing against what the template would
// generate for that project today.
//
// Only absences count. Entries the operator added themselves are theirs —
// listing them as drift would invite a "fix" that deletes the very rules they
// wrote to make their own project dispatchable.
//
// The drift worth catching is not a mistake anyone made: the deny list is read
// from this repository's own settings at generation time, never copied, so a
// project generated before a deny entry existed keeps the older list forever,
// silently. This is what tells the board to offer closing that gap.
function allowlistDrift(existing, generated) {
    const permissions = existing && typeof existing === 'object' && existing.permissions
        && typeof existing.permissions === 'object' ? existing.permissions : {};
    const has = key => new Set(Array.isArray(permissions[key]) ? permissions[key] : []);

    const wantAllow = (generated && generated.permissions && generated.permissions.allow) || [];
    const wantDeny = (generated && generated.permissions && generated.permissions.deny) || [];

    const presentAllow = has('allow');
    const presentDeny = has('deny');
    return {
        missingAllow: wantAllow.filter(e => !presentAllow.has(e)),
        missingDeny: wantDeny.filter(e => !presentDeny.has(e))
    };
}

module.exports = { detectRunner, allowlistFor, allowlistDrift };
