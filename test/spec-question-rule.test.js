const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Both spec agents may put a question in front of the operator, so both carry
// the rule that a visual one arrives with something to look at. The rule
// lives in two files by necessity — an agent reads only its own — and this is
// what keeps one from silently losing it while the other keeps it.
//
// A real question listed a file:line, two token names and a spec clause to
// ask how a page background should LOOK, and came back answered with "can you
// make mocks to help me decide?".

const AGENTS = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian', 'agents');
const read = name => fs.readFileSync(path.join(AGENTS, name), 'utf8');

for (const agent of ['spec-generator.md', 'spec-reviewer.md']) {
    test(`${agent} tells the agent how to ask a question`, () => {
        const src = read(agent);
        assert.match(src, /^## Asking the Operator a Question$/m,
            'the section itself');
        assert.match(src, /mock/i, 'it must name the mock');
        assert.match(src, /-mock\.html/,
            'and the exact file, so two agents cannot write to different ones');
    });

    test(`${agent} scopes the rule to visual questions only`, () => {
        // Without this, every question would arrive with a mock attached and
        // the signal would be worth nothing.
        assert.match(read(agent), /[Tt]echnical and architectural questions stay in words/,
            'technical questions must stay in prose');
    });
}

test('the mockup section points at the question rule', () => {
    // Its own trigger is "introduces or redesigns UI", which a token
    // migration does not satisfy — that is exactly how the real question
    // ended up with no mock.
    assert.match(read('spec-generator.md'), /Asking the Operator a Question\*\* above/);
});
