const { test } = require('node:test');
const assert = require('node:assert/strict');
const { highlightCommand } = require('../lib/command-highlight');

test('the binary is marked apart from its subcommands', () => {
    assert.equal(
        highlightCommand('claude auth login'),
        '<span class="tok-bin">claude</span> <span class="tok-sub">auth</span> <span class="tok-sub">login</span>'
    );
});

test('a path argument is marked as a path', () => {
    const html = highlightCommand('agy plugin install /ws/meridian/plugin');
    assert.match(html, /<span class="tok-path">\/ws\/meridian\/plugin<\/span>/);
    assert.match(html, /<span class="tok-bin">agy<\/span>/);
});

test('flags are marked apart from subcommands', () => {
    const html = highlightCommand('claude plugin list --json');
    assert.match(html, /<span class="tok-flag">--json<\/span>/);
    assert.match(html, /<span class="tok-sub">list<\/span>/);
});

// The command is rendered into innerHTML, and it carries operator-supplied
// paths. Every token is escaped exactly once, inside its span.
test('html in a token is escaped, never rendered', () => {
    const html = highlightCommand('agy plugin install /tmp/<script>alert(1)</script>');
    assert.match(html, /&lt;script&gt;/);
    assert.ok(!html.includes('<script>'), 'no live script tag');
});

test('an ampersand is escaped once', () => {
    assert.match(highlightCommand('x a&b'), /a&amp;b/);
});

test('runs of whitespace collapse to single spaces and edges are trimmed', () => {
    assert.equal(
        highlightCommand('  claude   auth  '),
        '<span class="tok-bin">claude</span> <span class="tok-sub">auth</span>'
    );
});

test('empty and non-string input yield an empty string', () => {
    for (const v of ['', '   ', null, undefined, 42]) {
        assert.equal(highlightCommand(v), '');
    }
});
