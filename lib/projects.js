'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveKey } = require('./tasks');
const { ensureMeridianIgnored } = require('./gitignore');

// Registering a project happens from two places — `meridian add` and
// POST /api/projects — and they had drifted: the CLI wrote a legacy registry
// entry carrying name/stack/purpose and never created project-info.json, so a
// project added from the command line had no `key` and its task ids came back
// as TASK-1. This is the one implementation both now call.
//
// Returns { registered, key, ignored }. `registered` is false when the path is
// already in the registry; nothing is written in that case.
function registerProject({ registryPath, projPath, name, stack, description }) {
    const registryDir = path.dirname(registryPath);
    if (!fs.existsSync(registryDir)) fs.mkdirSync(registryDir, { recursive: true });

    let registry = { projects: [] };
    if (fs.existsSync(registryPath)) {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }
    if (!Array.isArray(registry.projects)) registry.projects = [];

    if (registry.projects.find(p => p.path === projPath)) {
        return { registered: false, key: null, ignored: false };
    }

    // The registry holds paths and nothing else. Every descriptive field lives
    // in the project's own project-info.json, which is what makes a project
    // portable between workspaces.
    registry.projects.push({ path: projPath });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    const meridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(meridianDir)) fs.mkdirSync(meridianDir, { recursive: true });

    const key = deriveKey(name);
    fs.writeFileSync(
        path.join(meridianDir, 'project-info.json'),
        JSON.stringify({ name, key, stack: stack || [], description: description || '' }, null, 2),
        'utf8'
    );

    let ignored = false;
    try {
        ignored = ensureMeridianIgnored(projPath);
    } catch {
        // A project may legitimately have no writable .gitignore. Registration
        // itself succeeded; do not fail it over this.
    }

    return { registered: true, key, ignored };
}

module.exports = { registerProject };
