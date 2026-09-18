'use strict';

// What the settings screen knows about the two CLIs that can run the Meridian
// pipeline, and the commands it offers for each.
//
// One table drives both sides: the screen renders a command from `commandFor`
// and the server executes the argv from the same call, so what the operator
// reads is literally what runs. The client posts an action name — never a
// command string — because an endpoint that took a string would turn this
// screen into a remote shell.

const TOOLS = {
    claude: { label: 'Claude Code', icon: '/icons/claude.png' },
    agy: { label: 'Antigravity', icon: '/icons/antigravity.png' }
};

// How each CLI reports what it has installed. Claude prints an array of
// `{id: "<plugin>@<marketplace>", version}`; Antigravity prints
// `{imports: [{name}]}` with no version.
const PLUGIN_NAME = 'meridian';

function safeParse(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

// A CLI that is absent, erroring or printing a banner must read as "not
// installed", never as installed: the screen would otherwise offer Uninstall
// for something that is not there.
function parsePluginState(cli, stdout) {
    const parsed = safeParse(stdout);
    if (!parsed) return { installed: false, version: null };

    if (cli === 'claude') {
        if (!Array.isArray(parsed)) return { installed: false, version: null };
        const entry = parsed.find(p => p && typeof p.id === 'string' && p.id.split('@')[0] === PLUGIN_NAME);
        return entry ? { installed: true, version: entry.version || null } : { installed: false, version: null };
    }

    if (cli === 'agy') {
        const imports = parsed && Array.isArray(parsed.imports) ? parsed.imports : null;
        if (!imports) return { installed: false, version: null };
        const entry = imports.find(p => p && p.name === PLUGIN_NAME);
        return entry ? { installed: true, version: null } : { installed: false, version: null };
    }

    return { installed: false, version: null };
}

// Readiness answers "would a dispatch actually run", which each CLI reports
// differently. Claude has `auth status --json`. Antigravity has no auth verb
// at all, so the probe is `agy models`: it has to reach the service, which
// needs working credentials, and it costs no tokens.
function parseReadiness(cli, stdout, exitCode) {
    if (cli === 'claude') {
        const parsed = safeParse(stdout);
        if (!parsed || typeof parsed.loggedIn !== 'boolean') {
            return { ready: false, reason: firstLine(stdout) || 'could not read authentication status' };
        }
        if (parsed.loggedIn) return { ready: true, reason: null };
        return { ready: false, reason: 'CLI not authenticated — sign in to dispatch' };
    }

    if (cli === 'agy') {
        if (exitCode === 0) return { ready: true, reason: null };
        return { ready: false, reason: firstLine(stdout) || 'the models probe failed' };
    }

    return { ready: false, reason: 'unknown CLI' };
}

function firstLine(text) {
    if (typeof text !== 'string') return '';
    return text.split('\n').map(l => l.trim()).find(Boolean) || '';
}

// Authentication comes first for the CLI that has a verb for it: installing a
// plugin into a CLI that cannot run is busywork. Antigravity has no login
// action, so its readiness never changes the button — the screen states the
// reason beside it rather than offering a button with nothing to call.
function nextAction(cli, state) {
    if (cli === 'claude' && state && state.ready === false) return 'login';
    return state && state.installed ? 'uninstall' : 'install';
}

// `pluginDir` is the absolute path to plugin/plugins/meridian. Claude installs
// from its registered marketplace; Antigravity installs from the directory.
function commandFor(cli, action, options) {
    const pluginDir = (options && options.pluginDir) || '';
    const table = {
        claude: {
            install: ['claude', 'plugin', 'install', `${PLUGIN_NAME}@${PLUGIN_NAME}`],
            uninstall: ['claude', 'plugin', 'uninstall', PLUGIN_NAME],
            login: ['claude', 'auth', 'login']
        },
        agy: {
            install: ['agy', 'plugin', 'install', pluginDir],
            uninstall: ['agy', 'plugin', 'uninstall', PLUGIN_NAME]
        }
    };
    const argv = table[cli] && table[cli][action];
    if (!argv) return null;
    return { argv, display: argv.join(' ') };
}

// The probes the server runs to fill the screen. Here rather than in server.js
// so the command table and the commands that read state stay in one file.
const PROBES = {
    claude: {
        plugin: ['claude', 'plugin', 'list', '--json'],
        ready: ['claude', 'auth', 'status', '--json']
    },
    agy: {
        plugin: ['agy', 'plugin', 'list'],
        ready: ['agy', 'models']
    }
};

module.exports = { TOOLS, PROBES, parsePluginState, parseReadiness, nextAction, commandFor };
