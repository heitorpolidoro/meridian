const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoute } = require('../lib/routes');

const PROJECTS = [
    { path: '/ws/meridian', relativePath: 'meridian', name: 'Meridian' },
    { path: '/ws/project_d', relativePath: 'project_d', name: 'Project D' }
];

test('the root path is the dashboard', () => {
    assert.deepEqual(resolveRoute('/', PROJECTS), { view: 'dashboard' });
});

test('an empty path is the dashboard too', () => {
    assert.deepEqual(resolveRoute('', PROJECTS), { view: 'dashboard' });
});

test('/tickets, /all-tickets and /global are the global board', () => {
    for (const p of ['/tickets', '/all-tickets', '/global']) {
        assert.deepEqual(resolveRoute(p, PROJECTS), { view: 'global' }, `failed for ${p}`);
    }
});

test('a slug matching relativePath resolves to that project path', () => {
    assert.deepEqual(resolveRoute('/meridian', PROJECTS), { view: 'project', path: '/ws/meridian' });
});

test('a slug matching the project name resolves too', () => {
    assert.deepEqual(resolveRoute('/Project%20D', PROJECTS), { view: 'project', path: '/ws/project_d' });
});

test('matching is case-insensitive', () => {
    assert.deepEqual(resolveRoute('/MERIDIAN', PROJECTS), { view: 'project', path: '/ws/meridian' });
    assert.deepEqual(resolveRoute('/Tickets', PROJECTS), { view: 'global' });
});

test('a trailing slash does not change the match', () => {
    assert.deepEqual(resolveRoute('/meridian/', PROJECTS), { view: 'project', path: '/ws/meridian' });
    assert.deepEqual(resolveRoute('/tickets/', PROJECTS), { view: 'global' });
});

test('a project without relativePath falls back to the last path segment', () => {
    const projects = [{ path: '/ws/project_f', name: 'Audit' }];
    assert.deepEqual(resolveRoute('/project_f', projects), { view: 'project', path: '/ws/project_f' });
});

test('a slug matching nothing is unknown, carrying the slug', () => {
    assert.deepEqual(resolveRoute('/does-not-exist', PROJECTS), { view: 'unknown', slug: 'does-not-exist' });
});

test('a non-root path with no projects is unknown', () => {
    assert.deepEqual(resolveRoute('/meridian', []), { view: 'unknown', slug: 'meridian' });
    assert.deepEqual(resolveRoute('/meridian', undefined), { view: 'unknown', slug: 'meridian' });
});

test('a malformed percent-escape keeps the raw slug instead of throwing', () => {
    assert.deepEqual(resolveRoute('/%E0%A4%A', PROJECTS), { view: 'unknown', slug: '%E0%A4%A' });
});

test('a project entry missing name and relativePath is matched by nothing but never throws', () => {
    const projects = [{ path: '' }];
    assert.deepEqual(resolveRoute('/anything', projects), { view: 'unknown', slug: 'anything' });
});

test('/settings resolves to the settings view', () => {
    assert.deepEqual(resolveRoute('/settings', []), { view: 'settings' });
    assert.deepEqual(resolveRoute('/Settings/', []), { view: 'settings' });
});

// A project whose slug is literally "settings" would be unreachable, which is
// worth knowing rather than discovering later.
test('the settings slug wins over a project of the same name', () => {
    assert.deepEqual(resolveRoute('/settings', [{ path: '/ws/settings', relativePath: 'settings' }]), { view: 'settings' });
});
