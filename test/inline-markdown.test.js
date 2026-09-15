const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderInlineCode } = require('../lib/inline-markdown');

test('a backtick span becomes a code element', () => {
    assert.equal(
        renderInlineCode('no `use client` here'),
        'no <code>use client</code> here'
    );
});

test('several spans in one line are each converted', () => {
    assert.equal(
        renderInlineCode('ER1 `src/app/page.tsx` has no `useState` and no `useEffect`'),
        'ER1 <code>src/app/page.tsx</code> has no <code>useState</code> and no <code>useEffect</code>'
    );
});

// The whole point of the feature is showing code, and code contains angle
// brackets. Escaping the span's content twice would render `Array<T>` as the
// literal text "Array&lt;T&gt;" — which is what happens when markdown runs
// over already-escaped text.
test('angle brackets inside a span are escaped exactly once', () => {
    assert.equal(
        renderInlineCode('generic `Array<T>` here'),
        'generic <code>Array&lt;T&gt;</code> here'
    );
});

// Task text is written by agents into a gitignored file and rendered straight
// into the DOM. Markup outside a span is content, never markup.
test('html outside a span is escaped, never rendered', () => {
    assert.equal(
        renderInlineCode('see <img src=x onerror=alert(1)> now'),
        'see &lt;img src=x onerror=alert(1)&gt; now'
    );
});

test('html inside a span is escaped too', () => {
    assert.equal(
        renderInlineCode('run `<script>alert(1)</script>`'),
        'run <code>&lt;script&gt;alert(1)&lt;/script&gt;</code>'
    );
});

test('an ampersand is escaped once, in and out of a span', () => {
    assert.equal(
        renderInlineCode('a & b `x && y`'),
        'a &amp; b <code>x &amp;&amp; y</code>'
    );
});

test('an unmatched backtick stays literal', () => {
    assert.equal(renderInlineCode('80% `done'), '80% `done');
    assert.equal(renderInlineCode('a `b` c `d'), 'a <code>b</code> c `d');
});

test('an empty span is left literal rather than producing an empty code element', () => {
    assert.equal(renderInlineCode('nothing `` here'), 'nothing `` here');
});

test('a span never spans a newline', () => {
    assert.equal(renderInlineCode('a `b\nc` d'), 'a `b\nc` d');
});

test('both quote characters are escaped, matching the frontend escapeHtml', () => {
    assert.equal(renderInlineCode('say "hi"'), 'say &quot;hi&quot;');
    assert.equal(
        renderInlineCode("no `'use client'` directive"),
        'no <code>&#39;use client&#39;</code> directive'
    );
});

test('null, undefined and non-strings never throw', () => {
    assert.equal(renderInlineCode(null), '');
    assert.equal(renderInlineCode(undefined), '');
    assert.equal(renderInlineCode(42), '42');
});

test('text with no backtick is escaped and otherwise untouched', () => {
    assert.equal(renderInlineCode('plain text'), 'plain text');
});
