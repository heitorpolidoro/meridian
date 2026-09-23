const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowlistDrift } = require('../lib/allowlist-template');

const generated = {
    permissions: {
        allow: ['Bash(mix test)', 'Bash(git status)'],
        deny: ['Bash(git push:*)', 'Bash(rm -rf:*)']
    }
};

test('a complete allowlist has no drift', () => {
    const existing = { permissions: { allow: [...generated.permissions.allow], deny: [...generated.permissions.deny] } };
    assert.deepEqual(allowlistDrift(existing, generated), { missingAllow: [], missingDeny: [] });
});

test('missing entries are reported, in the order the template lists them', () => {
    const existing = { permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf:*)'] } };
    assert.deepEqual(allowlistDrift(existing, generated), {
        missingAllow: ['Bash(mix test)'],
        missingDeny: ['Bash(git push:*)']
    });
});

test("the operator's own extra entries are never drift", () => {
    // Reporting them would invite a "fix" that deletes the rules they wrote
    // to make their own project dispatchable.
    const existing = {
        permissions: {
            allow: [...generated.permissions.allow, 'Bash(docker compose up:*)'],
            deny: [...generated.permissions.deny, 'Bash(terraform apply:*)']
        }
    };
    assert.deepEqual(allowlistDrift(existing, generated), { missingAllow: [], missingDeny: [] });
});

test('a file with no permissions key is missing everything', () => {
    assert.deepEqual(allowlistDrift({ enabledPlugins: {} }, generated), {
        missingAllow: generated.permissions.allow,
        missingDeny: generated.permissions.deny
    });
});

test('absent, malformed or empty input is missing everything, not thrown on', () => {
    for (const input of [null, undefined, 'not an object', [], {}, { permissions: null }, { permissions: { allow: 'x' } }]) {
        assert.deepEqual(allowlistDrift(input, generated), {
            missingAllow: generated.permissions.allow,
            missingDeny: generated.permissions.deny
        }, `input ${JSON.stringify(input)}`);
    }
});

test('a template with nothing to offer produces no drift', () => {
    // A project with no detected runner still gets the git and deny entries;
    // an empty template is only reachable if this repo's own settings are
    // unreadable, and it must not report every existing entry as wrong.
    assert.deepEqual(allowlistDrift({ permissions: { allow: ['Bash(x)'] } }, { permissions: { allow: [], deny: [] } }),
        { missingAllow: [], missingDeny: [] });
    assert.deepEqual(allowlistDrift({}, {}), { missingAllow: [], missingDeny: [] });
});
