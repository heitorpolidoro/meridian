'use strict';

// Where a URL path lands in the SPA. public/app.js carries an inline copy of
// this function: the frontend has no module system and no build step, so the
// rule cannot be imported there. This file is the source of truth — change both.
//
//   '/'                              -> { view: 'dashboard' }
//   '/tickets' | '/all-tickets' | '/global' -> { view: 'global' }
//   '/settings'                      -> { view: 'settings' }
//   '/<slug>' matching a project     -> { view: 'project', path }
//   anything else                    -> { view: 'unknown', slug }
//
// A slug matches a project by its relativePath or its name, case-insensitively,
// after leading/trailing slashes are trimmed and percent-escapes decoded.
const GLOBAL_SLUGS = ['tickets', 'all-tickets', 'global'];
const SETTINGS_SLUG = 'settings';

function resolveRoute(pathname, projects) {
    let slug = String(pathname || '').replace(/^\/+|\/+$/g, '');
    try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
    if (!slug) return { view: 'dashboard' };

    const lower = slug.toLowerCase();
    if (GLOBAL_SLUGS.includes(lower)) return { view: 'global' };
    if (lower === SETTINGS_SLUG) return { view: 'settings' };

    const proj = (projects || []).find(p => {
        const rel = p.relativePath || String(p.path || '').split('/').pop() || '';
        return rel.toLowerCase() === lower || String(p.name || '').toLowerCase() === lower;
    });
    if (proj) return { view: 'project', path: proj.path };

    return { view: 'unknown', slug };
}

module.exports = { resolveRoute };
