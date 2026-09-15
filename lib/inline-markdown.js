'use strict';

// Inline `code` spans for task text — expected results and justifications,
// which are written in Markdown by the agents and were rendering their
// backticks literally.
//
// public/app.js carries an inline copy of both functions: the frontend has no
// module system and no build step, so they cannot be imported there. This file
// is the source of truth — change both.
//
// This does not use `marked`, which the spec viewer loads, for a reason worth
// keeping: running Markdown over raw task text renders any HTML in it (an
// `<img onerror=...>` in a task title becomes a live element), while running it
// over pre-escaped text escapes the span's contents twice, so `Array<T>` shows
// up as the literal `Array&lt;T&gt;` — and showing code is the whole point.
// Escaping each segment exactly once, and never emitting a tag the text asked
// for, gets both right.

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// A span is a backtick, at least one character that is neither a backtick nor a
// newline, and a closing backtick. An unmatched backtick is content: `80% done`
// in prose must not swallow the rest of the line looking for a partner.
const CODE_SPAN = /`([^`\n]+)`/g;

function renderInlineCode(text) {
    if (text === null || text === undefined) return '';
    const src = String(text);
    let out = '';
    let last = 0;
    CODE_SPAN.lastIndex = 0;
    let match;
    while ((match = CODE_SPAN.exec(src)) !== null) {
        out += escapeHtml(src.slice(last, match.index));
        out += `<code>${escapeHtml(match[1])}</code>`;
        last = match.index + match[0].length;
    }
    return out + escapeHtml(src.slice(last));
}

module.exports = { renderInlineCode, escapeHtml };
