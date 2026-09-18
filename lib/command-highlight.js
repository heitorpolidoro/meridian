'use strict';

// Syntax highlighting for the one-line shell commands the settings screen
// shows. Deliberately not a shell parser: these commands come from a fixed
// table in lib/tooling.js, so they are always `<binary> <words…>` with no
// quoting, pipes or substitution. Four token classes is the whole grammar.
//
// public/app.js carries an inline copy: the frontend has no module system and
// no build step. This file is the source of truth — change both.
//
// Every token is escaped exactly once, inside its span. The command carries
// absolute paths from the operator's machine and is written into innerHTML.

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function classOf(token, index) {
    if (index === 0) return 'tok-bin';
    if (token.startsWith('-')) return 'tok-flag';
    if (token.includes('/')) return 'tok-path';
    return 'tok-sub';
}

function highlightCommand(text) {
    if (typeof text !== 'string') return '';
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    return tokens
        .map((tok, i) => `<span class="${classOf(tok, i)}">${escapeHtml(tok)}</span>`)
        .join(' ');
}

module.exports = { highlightCommand };
