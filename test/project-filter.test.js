const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectOptions, filterByProject } = require('../lib/project-filter');

const TASKS = [
    { id: 'B-1', projectName: 'Beta', projectPath: '/w/beta' },
    { id: 'A-1', projectName: 'Alpha', projectPath: '/w/alpha' },
    { id: 'B-2', projectName: 'Beta', projectPath: '/w/beta' },
    { id: 'A-2', projectName: 'Alpha', projectPath: '/w/alpha' },
    { id: 'B-3', projectName: 'Beta', projectPath: '/w/beta' }
];

test('options are one per project, counted, ordered by name', () => {
    assert.deepEqual(projectOptions(TASKS), [
        { path: '/w/alpha', name: 'Alpha', count: 2 },
        { path: '/w/beta', name: 'Beta', count: 3 }
    ]);
});

test('two projects sharing a name stay separate, ordered by path', () => {
    // The reason path is the identity: filtering by label would merge these
    // two registered directories into one option.
    const tasks = [
        { id: 'X-1', projectName: 'api', projectPath: '/w/z-api' },
        { id: 'Y-1', projectName: 'api', projectPath: '/w/a-api' }
    ];
    assert.deepEqual(projectOptions(tasks).map(o => o.path), ['/w/a-api', '/w/z-api']);
});

test('tasks with no project are left out of the options', () => {
    // A single-project board's tasks carry no projectPath; the selector has
    // nothing to offer there and must not invent an "undefined" option.
    assert.deepEqual(projectOptions([{ id: 'T-1' }, { id: 'T-2', projectPath: null }]), []);
});

test('an empty or absent list yields no options', () => {
    assert.deepEqual(projectOptions([]), []);
    assert.deepEqual(projectOptions(null), []);
    assert.deepEqual(projectOptions(undefined), []);
});

test('a project with no name falls back to its path as the label', () => {
    assert.deepEqual(projectOptions([{ id: 'T-1', projectPath: '/w/unnamed' }]),
        [{ path: '/w/unnamed', name: '/w/unnamed', count: 1 }]);
});

test('no selection means every task', () => {
    assert.equal(filterByProject(TASKS, '').length, 5);
    assert.equal(filterByProject(TASKS, null).length, 5);
    assert.equal(filterByProject(TASKS, undefined).length, 5);
});

test('a selection keeps only that project, in the original order', () => {
    assert.deepEqual(filterByProject(TASKS, '/w/beta').map(t => t.id), ['B-1', 'B-2', 'B-3']);
});

test('a selection matching nothing shows nothing, never everything', () => {
    // Falling back to the full list would read as the filter clearing itself
    // behind the operator's back.
    assert.deepEqual(filterByProject(TASKS, '/w/gone'), []);
});

test('an absent task list is handled, not thrown on', () => {
    assert.deepEqual(filterByProject(null, '/w/beta'), []);
    assert.deepEqual(filterByProject(undefined, ''), []);
});
