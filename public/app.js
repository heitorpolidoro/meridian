const KANBAN_STATUSES = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'spec_review', label: 'Spec Review' },
    { id: 'spec_approval', label: 'Spec Approval' },
    { id: 'ready_todo', label: 'Ready to Do' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'code_review', label: 'Code Review' },
    { id: 'qa_review', label: 'QA / Review' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'done', label: 'Done' },
    { id: 'nope', label: 'Nope' }
];

const STATUS_PRIORITY = {
    'blocked': 8,
    'pending': 8,
    'qa_review': 7,
    'code_review': 6,
    'in_progress': 5,
    'ready_todo': 4,
    'todo': 4,
    'spec_approval': 3,
    'spec_review': 2,
    'backlog': 1
};

const projectsContainer = document.getElementById('projects-container');
const connectionStatus = document.getElementById('connection-status');
const errorContainer = document.getElementById('error-container');
let currentProjectsData = [];
let currentProjectViewPath = null;
let isInitialRouteHandled = false;
let doneWindowDays = (() => {
    const v = localStorage.getItem('meridian_done_window');
    return v === '' ? null : (v === null ? 7 : Number(v));
})();
let cardSearchQuery = '';
let currentKanbanTasks = [];

// Mirrors lib/board.js#isRecentlyCompleted. The frontend has no module
// system and no build step, so it cannot import that file — lib/board.js
// is the source of truth. Keep both in sync when changing this rule.
function withinWindow(raw, windowDays, now) {
    if (windowDays === null || windowDays === undefined) return true;
    if (!raw) return false;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return false;
    return (now.getTime() - when.getTime()) <= windowDays * 24 * 60 * 60 * 1000;
}

function isRecentlyCompleted(task, windowDays, now = new Date()) {
    return withinWindow(task && task.completed_at, windowDays, now);
}

// nope shares the done window, keyed on moved_at — completed_at is stamped
// only on entering `done`, so a dismissed task never has one.
function isRecentlyDismissed(task, windowDays, now = new Date()) {
    return withinWindow(task && task.moved_at, windowDays, now);
}

// Mirrors lib/board.js#manualTransition. The only status changes the board
// offers a human; every other transition belongs to the pipeline, driven
// through the API by meridian:work. lib/board.js is the source of truth.
const WORKING_STATUSES = [
    'backlog', 'spec_review', 'spec_approval', 'ready_todo', 'in_progress',
    'code_review', 'qa_review', 'blocked'
];

function manualTransition(status) {
    if (status === 'nope') return { to: 'backlog', label: 'Reopen' };
    if (WORKING_STATUSES.includes(status)) return { to: 'nope', label: 'Nope' };
    return null;
}

// Mirrors lib/board.js#byRecencyDesc — that file is the source of truth.
function byRecencyDesc(field) {
    return (a, b) => {
        const ra = (a && a[field]) || '';
        const rb = (b && b[field]) || '';
        return String(rb).localeCompare(String(ra));
    };
}

// Mirrors lib/board.js#collapsedColumns — that file is the source of truth.
// `count` is the total number of tasks in the status, never the done/nope
// windowed count: a done column whose tasks are all older than the window is
// a full column with a chip, not a rail.
function collapsedColumns(columns, expanded) {
    const open = expanded || new Set();
    const out = new Set();
    for (const col of columns || []) {
        if (col.count > 0) continue;
        if (open.has(col.id)) continue;
        out.add(col.id);
    }
    return out;
}

// Mirrors lib/board.js#childrenOf — that file is the source of truth. Scoped
// by projectPath when tasks carry one, so the global view's flattened,
// projectPath-tagged task list does not cross-match same-id tasks from two
// different projects.
function childrenOf(tasks, task) {
    return (tasks || []).filter(t =>
        t && task && t.parent === task.id &&
        (t.projectPath || null) === (task.projectPath || null)
    );
}

// Mirrors lib/board.js#subtaskProgress — that file is the source of truth.
function subtaskProgress(tasks, task) {
    const children = childrenOf(tasks, task);
    if (children.length === 0) return null;
    return { done: children.filter(t => t.status === 'done').length, total: children.length };
}

// Mirrors lib/board.js#parentBadge — that file is the source of truth.
function parentBadge(task) {
    return task && task.parent ? `↳ ${task.parent}` : null;
}

// Mirrors lib/board.js#dispatchButton — that file is the source of truth.
// One button whose label says which of the three situations the task is in.
// Running outranks queued: a task cannot honestly be both, and if the state
// ever disagrees the useful button is the one that can stop a process.
const NO_DISPATCH = ['done', 'nope'];

function dispatchButton(task, { queue, runningTaskId }) {
    if (!task || NO_DISPATCH.includes(task.status)) return null;
    if (task.id === runningTaskId) {
        return { action: 'stop', label: 'Stop', title: 'Signal the running session (SIGTERM)' };
    }
    if ((queue || []).includes(task.id)) {
        return { action: 'unqueue', label: 'Remove from queue', title: 'Drop this task from the queue' };
    }
    return { action: 'dispatch', label: 'Dispatch', title: 'Queue this task; runs at once if the repo is free' };
}

// The dispatch state (queue, running task, blocked reason) for the project
// that owns `task`. A task in the global view carries its own projectPath
// (refreshProjectView tags it); a task in a single project's board does not,
// so this falls back to the view currently open.
function dispatchContextFor(projectPath) {
    const proj = currentProjectsData.find(p => p.path === projectPath);
    if (!proj) return { queue: [], runningTaskId: null, dispatchBlockedReason: null };
    const runningTask = (proj.tasks || []).find(t => t.running === true);
    return {
        queue: proj.queue || [],
        runningTaskId: runningTask ? runningTask.id : null,
        dispatchBlockedReason: proj.dispatchBlockedReason || null
    };
}

// Rails the operator expanded this session. Not persisted: a reload collapses
// every empty column again.
const expandedRails = new Set();

// Mirrors lib/routes.js#resolveRoute — that file is the source of truth.
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

const dashboardView = document.getElementById('dashboard-view');
const projectView = document.getElementById('project-view');
const viewLoading = document.getElementById('view-loading');
const breadcrumb = document.getElementById('breadcrumb');
const btnEdit = document.getElementById('pv-edit-btn');

function showFlashMessage(msg, type = 'info') {
    const container = document.getElementById('flash-message-container');
    if (!container) return;
    const flash = document.createElement('div');
    flash.style.padding = '0.8rem 1.2rem';
    flash.style.borderRadius = '8px';
    flash.style.fontSize = '0.9rem';
    flash.style.fontWeight = '600';
    flash.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
    flash.style.background = type === 'error' ? '#ef4444' : '#10b981';
    flash.style.color = '#ffffff';
    flash.style.transition = 'all 0.3s ease';
    flash.textContent = msg;
    container.appendChild(flash);
    setTimeout(() => {
        flash.remove();
    }, 4000);
}

// Task 14: confirms before a click starts a real agent run. This is a
// guard against the slip of a hand, not a security boundary — the dispatch
// and dispatch-all endpoints stay exactly as they are, and anything that
// can reach them directly (curl, another client) bypasses this by design.
//
// Checking "Don't ask again this session" sets this for the rest of the
// page's life and nothing longer: it is never written to localStorage or
// sent to the server, because a suppression that outlived the session is
// how a safety step quietly disappears forever. It only ever suppresses the
// per-card `Dispatch` confirmation — `Dispatch all` arms a loop that starts
// run after run unattended, which always confirms regardless of this flag.
let suppressDispatchConfirm = false;

// public/index.html carries no markup for this dialog — it is built once,
// on first use, the same modal-overlay/modal-content pattern the Add
// Project and Fix Progress modals already use.
function dispatchConfirmModal() {
    let overlay = document.getElementById('dispatch-confirm-modal');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'dispatch-confirm-modal';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `
        <div class="modal-content dispatch-confirm-content">
            <div class="modal-header">
                <h2>Start this run?</h2>
                <button type="button" class="close-modal-btn" id="dispatch-confirm-close" aria-label="Cancel">&times;</button>
            </div>
            <p id="dispatch-confirm-message" class="dispatch-confirm-message"></p>
            <div class="form-group" id="dispatch-confirm-checkbox-row">
                <label class="dispatch-confirm-checkbox-label">
                    <input type="checkbox" id="dispatch-confirm-suppress">
                    Don't ask again this session
                </label>
            </div>
            <div class="form-actions">
                <button type="button" class="secondary-btn" id="dispatch-confirm-cancel">Cancel</button>
                <button type="button" class="primary-btn" id="dispatch-confirm-ok">Dispatch</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    return overlay;
}

// Shows the confirm dialog and resolves to whether the operator confirmed.
// `showCheckbox: false` leaves the suppression choice out entirely rather
// than offer a checkbox that would do nothing — used for `Dispatch all`,
// which always confirms no matter what this checkbox has ever set.
function confirmDispatch(message, { showCheckbox = true, confirmLabel = 'Dispatch' } = {}) {
    return new Promise(resolve => {
        const overlay = dispatchConfirmModal();
        overlay.querySelector('#dispatch-confirm-message').textContent = message;
        const checkboxRow = overlay.querySelector('#dispatch-confirm-checkbox-row');
        const checkbox = overlay.querySelector('#dispatch-confirm-suppress');
        checkbox.checked = false;
        checkboxRow.classList.toggle('hidden', !showCheckbox);
        overlay.classList.remove('hidden');

        // Fix round 1: this dialog is a singleton, and a call in flight
        // leaves its listeners attached — two fast clicks before the
        // triggering button disables itself would otherwise queue two
        // calls, each wiring up its own set, so one click on OK fired both.
        // Cloning the buttons drops every listener a previous call attached
        // without needing to track those closures across calls.
        const oldOkBtn = overlay.querySelector('#dispatch-confirm-ok');
        const okBtn = oldOkBtn.cloneNode(true);
        oldOkBtn.replaceWith(okBtn);
        const oldCancelBtn = overlay.querySelector('#dispatch-confirm-cancel');
        const cancelBtn = oldCancelBtn.cloneNode(true);
        oldCancelBtn.replaceWith(cancelBtn);
        const oldCloseBtn = overlay.querySelector('#dispatch-confirm-close');
        const closeBtn = oldCloseBtn.cloneNode(true);
        oldCloseBtn.replaceWith(closeBtn);
        okBtn.textContent = confirmLabel;

        function cleanup(result) {
            overlay.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            resolve(result);
        }
        function onOk() {
            if (showCheckbox && checkbox.checked) suppressDispatchConfirm = true;
            cleanup(true);
        }
        function onCancel() { cleanup(false); }
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
    });
}

// `Dispatch all` arms auto-dispatch, which will pull and run task after
// task, unattended, until stopped — a different act from starting one run,
// and the one the operator most needs to be sure about. It always confirms,
// even when the per-card suppression above is on.
async function confirmDispatchAll(projectPath, projectName) {
    const ok = await confirmDispatch(
        `Arm automatic dispatch for ${projectName} in ${projectPath}? `
        + `It will start run after run, unattended, until you stop the queue.`,
        { showCheckbox: false, confirmLabel: 'Dispatch all' }
    );
    if (ok) setAutoDispatch(projectPath, true);
}

function renderErrors(errors) {
    if (!errors || errors.length === 0) {
        errorContainer.innerHTML = '';
        return;
    }
    
    errorContainer.innerHTML = errors.map(err => `
        <div class="error-banner">
            <strong>⚠️ Parse Error in <code>${err.file}</code></strong>
            <p>${err.message}</p>
        </div>
    `).join('');
}

function renderProjects(data) {
    renderErrors(data.errors);
    currentProjectsData = data.projects || [];

    let hasAnyIssues = false;

    if (currentProjectsData.length === 0) {
        projectsContainer.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; font-size: 1.2rem;">No projects found in the current directory.</div>`;
    } else {
        projectsContainer.innerHTML = currentProjectsData.map(proj => {
            const needsFix = proj.missingAgentsMd || proj.missingMeridianRules || proj.outdatedMeridianRules || proj.missingStack || proj.missingDescription;
            if (needsFix) hasAnyIssues = true;

            // Convert legacy stack string to array if needed
            let stackArray = Array.isArray(proj.stack) ? proj.stack : (proj.stack ? proj.stack.split(',').map(s => s.trim()).filter(Boolean) : []);
            const stackHtml = stackArray.map(tech => `<span class="stack-badge">${tech}</span>`).join('');
            const escapedPath = proj.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            // The global view has no single project to arm, so it arms every
            // project with its own control, one per row — bound to that
            // row's project path, never to whatever project is open elsewhere.
            const dispatchRowHtml = proj.autoDispatch
                ? `<button type="button" class="secondary-btn dispatch-row-btn" title="Disarm auto-dispatch and discard the queue"
                        onclick="setAutoDispatch('${escapedPath}', false); event.stopPropagation();">Stop queue${(proj.queue || []).length > 0 ? ` (${proj.queue.length})` : ''}</button>`
                : `<button type="button" class="secondary-btn dispatch-row-btn" ${proj.dispatchBlockedReason ? 'disabled' : ''}
                        title="${escapeHtml(proj.dispatchBlockedReason || 'Arm automatic dispatch for this project')}"
                        onclick="confirmDispatchAll('${escapedPath}', '${proj.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'); event.stopPropagation();">Dispatch all</button>`;
            // Offered only when the repository has no `.claude/settings.json`
            // at all — never over a file the operator wrote themselves, even
            // one whose `permissions.allow` is empty.
            const allowlistBtnHtml = proj.canCreateAllowlist
                ? `<button type="button" class="secondary-btn allowlist-btn" title="Write a starting .claude/settings.json for this repository"
                        onclick="createAllowlist('${escapedPath}'); event.stopPropagation();">Create allowlist</button>`
                : '';

            return `
            <div class="project-card" onclick="showProjectView('${proj.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">
                <div class="project-header">
                    <h2 class="project-title">
                        ${proj.name}
                        <button type="button" class="stats-icon-btn" title="View stats for ${proj.name.replace(/"/g, '&quot;')}"
                            onclick="showProjectView('${proj.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', true, 'stats'); event.stopPropagation();">📊</button>
                    </h2>
                    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom: 0.5rem; margin-top: 0.5rem;">
                        ${proj.missingAgentsMd ? '<span class="missing-agents-badge" title="Missing AGENTS.md in project root">⚠️ Missing AGENTS.md</span>' : ''}
                        ${proj.missingMeridianRules && !proj.missingAgentsMd ? '<span class="outdated-agents-badge" title="Missing Meridian Instructions block">⚠️ Missing Meridian Rules</span>' : ''}
                        ${proj.outdatedMeridianRules && !proj.missingAgentsMd ? '<span class="outdated-agents-badge" title="Meridian Instructions block is outdated">⚠️ Outdated Meridian Rules</span>' : ''}
                        ${proj.missingStack ? '<span class="missing-stack-badge" title="Missing Stack">⚠️ Missing Stack</span>' : ''}
                        ${proj.missingDescription ? '<span class="missing-desc-badge" title="Missing Description">⚠️ Missing Description</span>' : ''}
                        ${needsFix
                            ? `<button class="fix-ai-btn" onclick="openFixModal('${proj.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${proj.name.replace(/'/g, "\\'")}', this, ${proj.missingAgentsMd}, ${proj.missingStack}, ${proj.missingDescription}, ${proj.missingMeridianRules}, ${proj.outdatedMeridianRules}); event.stopPropagation();">Fix 🪄</button>`
                            : ''}
                        ${dispatchRowHtml}
                        ${allowlistBtnHtml}
                    </div>
                    <p class="project-purpose">${proj.description}</p>
                    <div class="project-stack">${stackHtml}</div>
                </div>
            
                <div class="dashboard-tasks-preview">
                    ${renderDashboardTasksPreview(proj.tasks || [])}
                </div>
            </div>
            `;
        }).join('');
    }

    const fixAllBtn = document.getElementById('fix-all-btn');
    if (fixAllBtn) {
        if (hasAnyIssues) {
            fixAllBtn.classList.remove('hidden');
        } else {
            fixAllBtn.classList.add('hidden');
        }
    }

    if (!isInitialRouteHandled) {
        isInitialRouteHandled = true;
        handleUrlRouting();
    } else if (currentProjectViewPath) {
        refreshProjectView();
    }
}

function connectSSE() {
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
        try {
            const parsed = JSON.parse(event.data);
            if (parsed.type === 'init' || parsed.type === 'update') {
                renderProjects(parsed.data);
                connectionStatus.textContent = "Live";
                connectionStatus.className = "status-indicator connected";
            } else if (parsed.type === 'tooling-output') {
                const out = document.getElementById(`tooling-out-${parsed.cli}`);
                if (out) {
                    out.classList.remove('hidden');
                    out.textContent += parsed.chunk;
                    out.scrollTop = out.scrollHeight;
                }
            } else if (parsed.type === 'fix-progress' && parsed.projectPath === document.getElementById('fix-proj-path').value) {
                const status = parsed.data.status;
                const msg = parsed.data.message;
                const percent = parsed.data.percent;
                
                if (status === 'log') {
                    const term = document.getElementById('fix-terminal-log');
                    term.textContent += msg;
                    term.scrollTop = term.scrollHeight; // Auto-scroll
                    return;
                }

                // Handle progress bar updates
                const pb = document.getElementById('fix-progress-bar');
                const pt = document.getElementById('fix-progress-text');
                const pp = document.getElementById('fix-progress-percent');
                
                pb.style.width = `${percent}%`;
                pt.textContent = msg;
                pp.textContent = `${percent}%`;
                
                if (status === 'error') {
                    pb.style.background = '#ef4444';
                    pt.style.color = '#ef4444';
                    if (window.isFixAllRunning) {
                        setTimeout(() => window.runNextFixAll(), 1500);
                    }
                } else if (status === 'complete') {
                    pb.style.background = '#10b981';
                    pt.style.color = '#10b981';
                    
                    if (window.isFixAllRunning) {
                        setTimeout(() => window.runNextFixAll(), 1500);
                    } else {
                        const fixSubmitBtn = document.getElementById('fix-submit-btn');
                        if (fixSubmitBtn) fixSubmitBtn.classList.add('hidden');
                        const fixDoneBtn = document.getElementById('fix-done-btn');
                        if (fixDoneBtn) fixDoneBtn.classList.remove('hidden');
                        const cancelBtn = document.querySelector('.close-fix-modal-btn');
                        if (cancelBtn) cancelBtn.classList.add('hidden');
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing SSE:', e);
        }
    };

    eventSource.onerror = () => {
        console.error('SSE connection lost. Reconnecting in 3s...');
        connectionStatus.textContent = "Disconnected (Retrying...)";
        connectionStatus.className = "status-indicator";
        eventSource.close();
        
        setTimeout(connectSSE, 3000);
    };
}

connectSSE();

// Modal Logic
const modal = document.getElementById('add-project-modal');
const openAddModalBtn = document.getElementById('open-add-modal-btn');
const closeModalBtns = document.querySelectorAll('.close-modal-btn');
const addProjectForm = document.getElementById('add-project-form');
const projPathSelect = document.getElementById('proj-path-select');
const pathGroup = document.getElementById('path-form-group');
const modalTitle = document.getElementById('modal-title');
const originalPathInput = document.getElementById('proj-path-hidden');

// Tag Logic
let currentStackTags = [];
const stackInput = document.getElementById('stack-input');
const addStackBtn = document.getElementById('add-stack-btn');
const stackTagsContainer = document.getElementById('stack-tags-container');

function renderStackTags() {
    if (stackTagsContainer) {
        stackTagsContainer.innerHTML = currentStackTags.map((tag, i) => `
            <span class="tag-item">
                ${tag}
                <span class="remove-tag" onclick="removeStackTag(${i}); event.stopPropagation();">&times;</span>
            </span>
        `).join('');
    }
}

function addStackTag() {
    if (!stackInput) return;
    const val = stackInput.value.trim();
    if (val && !currentStackTags.includes(val)) {
        currentStackTags.push(val);
        stackInput.value = '';
        renderStackTags();
    }
}

window.removeStackTag = function(index) {
    currentStackTags.splice(index, 1);
    renderStackTags();
};

if (stackInput) {
    stackInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent form submission
            addStackTag();
        }
    });
}
if (addStackBtn) {
    addStackBtn.addEventListener('click', addStackTag);
}


async function openAddModal() {
    addProjectForm.reset();
    currentStackTags = [];
    renderStackTags();
    originalPathInput.value = '';
    modalTitle.textContent = "Add New Project";
    pathGroup.style.display = 'block';
    projPathSelect.required = true;
    if (projKeyInput) { projKeyInput.value = ''; projKeyInput.dataset.manuallySet = ''; }
    
    modal.classList.remove('hidden');
    projPathSelect.innerHTML = '<option value="">Loading directories...</option>';
    
    try {
        const res = await fetch('/api/directories');
        const data = await res.json();
        
        if (data.directories && data.directories.length > 0) {
            projPathSelect.innerHTML = '<option value="" disabled selected>Select a folder...</option>' + 
                data.directories.map(d => `<option value="${d}">${d}</option>`).join('');
        } else {
            projPathSelect.innerHTML = '<option value="" disabled>No valid directories found</option>';
        }
    } catch (err) {
        projPathSelect.innerHTML = '<option value="" disabled>Error loading directories</option>';
    }
}

function openEditModal(path) {
    const proj = currentProjectsData.find(p => p.path === path);
    if (!proj) return;

    originalPathInput.value = proj.path;
    document.getElementById('proj-name').value = proj.name;
    document.getElementById('proj-key').value = proj.key || '';
    document.getElementById('proj-purpose').value = proj.description || proj.purpose || '';
    
    // Load existing tags
    currentStackTags = Array.isArray(proj.stack) ? [...proj.stack] : (proj.stack ? proj.stack.split(',').map(s => s.trim()).filter(Boolean) : []);
    renderStackTags();
    
    modalTitle.textContent = "Edit Project";
    pathGroup.style.display = 'none';
    projPathSelect.required = false;

    modal.classList.remove('hidden');
}

// Auto-derive key from project name
const projNameInput = document.getElementById('proj-name');
const projKeyInput = document.getElementById('proj-key');
if (projNameInput && projKeyInput) {
    projNameInput.addEventListener('input', () => {
        if (projKeyInput.dataset.manuallySet) return;
        const name = projNameInput.value.trim();
        if (!name) { projKeyInput.placeholder = 'Auto-derived from name'; return; }
        const words = name.split(/[\s_\-]+/).filter(Boolean);
        const key = words.length === 1
            ? words[0].substring(0, 5).toUpperCase()
            : words.map(w => w[0]).join('').toUpperCase();
        projKeyInput.value = key;
    });
    projKeyInput.addEventListener('input', () => {
        projKeyInput.dataset.manuallySet = projKeyInput.value ? '1' : '';
    });
}

function closeModal() {
    modal.classList.add('hidden');
}

if (openAddModalBtn) openAddModalBtn.addEventListener('click', openAddModal);
if (closeModalBtns) closeModalBtns.forEach(btn => btn.addEventListener('click', closeModal));

// Form Submission
addProjectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Attempt to add any text still in the input as a tag before submitting
    addStackTag();
    
    const isEdit = !!document.getElementById('proj-path-hidden').value;
    const method = isEdit ? 'PUT' : 'POST';

    const payload = {
        name: document.getElementById('proj-name').value.trim(),
        key: (document.getElementById('proj-key').value || '').trim().toUpperCase() || undefined,
        description: document.getElementById('proj-purpose').value.trim(),
        stack: currentStackTags,
    };

    if (isEdit) {
        payload.originalPath = document.getElementById('proj-path-hidden').value;
    } else {
        payload.path = document.getElementById('proj-path-select').value;
    }

    try {
        const res = await fetch('/api/projects', {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeModal();
        } else {
            const data = await res.json();
            showFlashMessage('Error saving project: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        showFlashMessage('Network error saving project', 'error');
    }
});

// Fix with AI Modal Logic
const fixModal = document.getElementById('fix-progress-modal');
const closeFixModalBtns = document.querySelectorAll('.close-fix-modal-btn');
const fixForm = document.getElementById('fix-progress-form');
const fixProjPathInput = document.getElementById('fix-proj-path');
const fixCheckboxesContainer = document.getElementById('fix-checkboxes-container');
const fixSubmitBtn = document.getElementById('fix-submit-btn');
const fixProgressContainer = document.getElementById('fix-status-area');

window.openFixModal = function(path, projName, btnEl, missingAgents, missingStack, missingDesc, missingMeridianRules, outdatedMeridianRules) {
    if (document.getElementById('fix-proj-path')) document.getElementById('fix-proj-path').value = path;
    const titleEl = document.getElementById('fix-modal-title') || document.getElementById('fix-title');
    if (titleEl) titleEl.textContent = 'Fixing ' + projName;
    
    // Reset any "Fix All" hidden states
    if (fixCheckboxesContainer) fixCheckboxesContainer.classList.remove('hidden');
    if (fixSubmitBtn) fixSubmitBtn.classList.remove('hidden');
    
    if (fixCheckboxesContainer) fixCheckboxesContainer.innerHTML = '';
    
    if (missingAgents && fixCheckboxesContainer) {
        fixCheckboxesContainer.innerHTML += `
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input type="checkbox" name="fixes" value="agents" checked>
                Generate AGENTS.md
            </label>
        `;
    }
    
    if (!missingAgents && (missingMeridianRules || outdatedMeridianRules) && fixCheckboxesContainer) {
        const labelText = outdatedMeridianRules ? "Update Meridian Rules (System)" : "Inject Meridian Rules (System)";
        fixCheckboxesContainer.innerHTML += `
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input type="checkbox" name="fixes" value="meridian-rules" checked>
                ${labelText}
            </label>
        `;
    }

    if (missingStack && fixCheckboxesContainer) {
        fixCheckboxesContainer.innerHTML += `
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input type="checkbox" name="fixes" value="stack" checked>
                Auto-detect Technology Stack
            </label>
        `;
    }
    if (missingDesc && fixCheckboxesContainer) {
        fixCheckboxesContainer.innerHTML += `
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input type="checkbox" name="fixes" value="description" checked>
                Auto-generate Description
            </label>
        `;
    }

    // Reset progress UI
    if (fixProgressContainer) fixProgressContainer.classList.add('hidden');
    if (document.getElementById('fix-progress-bar')) {
        document.getElementById('fix-progress-bar').style.width = '0%';
        document.getElementById('fix-progress-bar').style.background = 'var(--accent)';
    }
    if (document.getElementById('fix-progress-text')) document.getElementById('fix-progress-text').style.color = 'var(--text-secondary)';
    
    const fixDoneBtn = document.getElementById('fix-done-btn');
    if (fixDoneBtn) fixDoneBtn.classList.add('hidden');
    
    if (fixSubmitBtn) {
        fixSubmitBtn.classList.remove('hidden');
        fixSubmitBtn.disabled = false;
        fixSubmitBtn.textContent = 'Fix 🪄';
    }
    
    const cancelBtn = document.querySelector('.close-fix-modal-btn');
    if (cancelBtn) {
        cancelBtn.classList.remove('hidden');
        cancelBtn.textContent = 'Cancel';
    }
    
    // Ensure all inputs and selects are enabled (in case they were disabled by a previous failed run)
    if (fixForm) fixForm.querySelectorAll('input, select').forEach(el => el.disabled = false);

    if (fixModal) fixModal.classList.remove('hidden');
};

window.closeFixModal = function() {
    if (fixModal) fixModal.classList.add('hidden');
};

const fixDoneBtn = document.getElementById('fix-done-btn');
if (fixDoneBtn) {
    fixDoneBtn.addEventListener('click', closeFixModal);
}

if (closeFixModalBtns) closeFixModalBtns.forEach(btn => btn.addEventListener('click', closeFixModal));

if (fixForm) {
    fixForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(fixForm);
    
    // FormData doesn't handle multiple checkboxes well with Object.fromEntries if they have the same name.
    const fixes = formData.getAll('fixes');
    const tool = formData.get('tool') || 'agy';
    const projectPath = formData.get('projectPath') || (document.getElementById('fix-proj-path') ? document.getElementById('fix-proj-path').value : '');
    
    if (window.isFixAllMode) {
        window.fixAllTool = tool;
        
        const newQueue = [];
        window.fixAllOriginalQueue.forEach((proj, idx) => {
            const checkedFixes = formData.getAll(`fixes_${idx}`);
            if (checkedFixes.length > 0) {
                newQueue.push({
                    path: proj.path,
                    name: proj.name,
                    fixes: checkedFixes
                });
            }
        });
        
        if (newQueue.length === 0) {
            showFlashMessage("Please select at least one fix from any project.", 'error');
            return;
        }
        
        window.fixAllQueue = newQueue;
        
        fixSubmitBtn.classList.add('hidden');
        fixProgressContainer.classList.remove('hidden');
        const term = document.getElementById('fix-terminal-log');
        term.classList.remove('hidden');
        term.textContent = 'Starting Fix All sequence...\n';
        
        window.isFixAllRunning = true;
        if (fixCheckboxesContainer) fixCheckboxesContainer.classList.add('hidden');
        
        window.runNextFixAll();
        return;
    }
    
    if (fixes.length === 0) {
        showFlashMessage("Please select at least one fix.", 'error');
        return;
    }

    fixSubmitBtn.disabled = true;
    fixSubmitBtn.textContent = 'Fixing... ⏳';
    fixProgressContainer.classList.remove('hidden');
    
    // Setup terminal log
    const term = document.getElementById('fix-terminal-log');
    term.classList.remove('hidden');
    term.textContent = '';
    
    document.getElementById('fix-progress-text').textContent = 'Initializing...';
    
    // Disable checkboxes during processing
    fixForm.querySelectorAll('input[type="checkbox"], select').forEach(el => el.disabled = true);

    try {
        const res = await fetch('/api/fix-with-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath, tool, fixes })
        });

        if (!res.ok) {
            const data = await res.json();
            showFlashMessage('Error starting fixes: ' + (data.error || 'Unknown error', 'error'));
            fixSubmitBtn.disabled = false;
            fixSubmitBtn.textContent = 'Fix Selected 🪄';
            fixForm.querySelectorAll('input[type="checkbox"], select').forEach(el => el.disabled = false);
        }
        // If ok, the background process is running and will broadcast SSE updates!
    } catch (err) {
        showFlashMessage('Network error during fixes', 'error');
        fixSubmitBtn.disabled = false;
        fixSubmitBtn.textContent = 'Fix Selected 🪄';
        fixForm.querySelectorAll('input[type="checkbox"], select').forEach(el => el.disabled = false);
    }
});
}

/* =========================================
   SPA Routing & Kanban Logic 
   ========================================= */

const addTaskForm = document.getElementById('add-task-form');

function renderDashboardTasksPreview(tasks) {
    if (!tasks || tasks.length === 0) return '';
    
    // Filter out Done and Nope, sort by priority descending
    const activeTasks = tasks
        .filter(t => t.status !== 'done' && t.status !== 'nope' && t.status !== 'completed')
        .sort((a, b) => (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0))
        .slice(0, 2);
        
    if (activeTasks.length === 0) return '<div class="empty-state">No active tasks.</div>';
    
    return activeTasks.map(t => {
        const statusId = t.status;
        const kanbanStatus = KANBAN_STATUSES.find(s => s.id === statusId);
        const displayStatus = kanbanStatus ? kanbanStatus.label : t.status;
        const idDisplay = t.id ? `[${t.id}] ` : '';
        return `
        <div class="preview-task-item">
            <span class="status-badge status-${statusId}">${displayStatus}</span>
            <span class="preview-task-title" title="${idDisplay}${t.title.replace(/"/g, '&quot;')}"><span class="task-id-code">${idDisplay}</span>${t.title}</span>
        </div>
        `;
    }).join('');
}

function handleUrlRouting() {
    const route = resolveRoute(window.location.pathname, currentProjectsData);
    switch (route.view) {
        case 'dashboard':
            showDashboard(false);
            break;
        case 'global':
            showGlobalTicketsView(false);
            break;
        case 'settings':
            showSettingsView(false);
            break;
        case 'project':
            showProjectView(route.path, false);
            break;
        default:
            // Nothing lives here: say so, and do not leave a dead URL in the bar.
            showDashboard(false);
            showFlashMessage(`No project at /${route.slug}`, 'error');
            history.replaceState(null, '', '/');
    }

    const taskParam = new URLSearchParams(window.location.search).get('task');
    if (taskParam) {
        openTaskModal(taskParam);
    } else if (taskModal && !taskModal.classList.contains('hidden')) {
        closeTaskModal(false);
    }
}

// Swaps the visible view. The first call removes the cold-load placeholder;
// nothing is shown before the first SSE message has picked a route, so a deep
// link never flashes the dashboard. The leaving view hides at once; the
// entering one replays the view-enter animation.
// Three screens now share one slot, so this switches over a map rather than
// the two-way ternary it used to be: adding a fourth must not mean rewriting
// the condition again.
function activateView(name) {
    if (viewLoading) viewLoading.remove();
    const settingsView = document.getElementById('settings-view');
    const views = {
        dashboard: dashboardView,
        global: projectView,
        project: projectView,
        settings: settingsView
    };
    const entering = views[name] || dashboardView;
    for (const el of new Set(Object.values(views))) {
        if (!el || el === entering) continue;
        el.classList.add('hidden');
        el.classList.remove('view--active');
    }
    entering.classList.remove('hidden');
    entering.classList.add('view--active');
    document.body.dataset.view = name;
}

// Breadcrumb: hidden on the dashboard; "Meridian › <current>" elsewhere.
function setBreadcrumb(current) {
    if (!breadcrumb) return;
    if (!current) {
        breadcrumb.classList.add('hidden');
        breadcrumb.innerHTML = '';
        return;
    }
    breadcrumb.innerHTML = `<a href="/" data-nav="dashboard">Meridian</a>`
        + `<span class="breadcrumb-sep" aria-hidden="true">›</span>`
        + `<span class="breadcrumb-current"></span>`;
    breadcrumb.querySelector('.breadcrumb-current').textContent = current;
    breadcrumb.classList.remove('hidden');
}

if (breadcrumb) {
    breadcrumb.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-nav="dashboard"]');
        if (!link) return;
        e.preventDefault();
        showDashboard(true);
    });
}

window.addEventListener('popstate', () => {
    handleUrlRouting();
});

function showDashboard(pushState = true) {
    currentProjectViewPath = null;
    cardSearchQuery = '';
    const searchInput = document.getElementById('card-search-input');
    if (searchInput) searchInput.value = '';
    activateView('dashboard');
    setBreadcrumb(null);
    document.title = 'Meridian Dashboard';
    if (pushState && window.location.pathname !== '/') {
        history.pushState(null, '', '/');
    }
}

window.showProjectView = function(projPath, pushState = true, initialTab = 'board') {
    if (currentProjectViewPath !== projPath) {
        cardSearchQuery = '';
        const searchInput = document.getElementById('card-search-input');
        if (searchInput) searchInput.value = '';
    }
    currentProjectViewPath = projPath;
    activateView('project');
    refreshProjectView();
    if (tabStatsBtn) tabStatsBtn.classList.remove('hidden');
    if (initialTab === 'stats') {
        showStatsTab();
    } else {
        showBoardTab();
    }

    if (pushState && currentProjectsData.length > 0) {
        const proj = currentProjectsData.find(p => p.path === projPath);
        const relPath = proj ? (proj.relativePath || proj.path.split('/').pop()) : projPath.split('/').pop();
        const targetUrl = '/' + relPath;
        if (window.location.pathname !== targetUrl) {
            history.pushState({ projPath }, '', targetUrl);
        }
    }
};

window.showGlobalTicketsView = function(pushState = true) {
    showBoardTab();
    if (currentProjectViewPath !== '__GLOBAL__') {
        cardSearchQuery = '';
        const searchInput = document.getElementById('card-search-input');
        if (searchInput) searchInput.value = '';
    }
    currentProjectViewPath = '__GLOBAL__';
    activateView('global');
    setBreadcrumb('All Tickets');
    document.title = 'All Tickets · Meridian';
    refreshProjectView();
    if (tabStatsBtn) tabStatsBtn.classList.remove('hidden');

    if (pushState && window.location.pathname !== '/tickets') {
        history.pushState(null, '', '/tickets');
    }
};

const globalTicketsBtn = document.getElementById('global-tickets-btn');
if (globalTicketsBtn) {
    globalTicketsBtn.addEventListener('click', () => showGlobalTicketsView(true));
}

window.showSettingsView = function(pushState = true) {
    activateView('settings');
    setBreadcrumb('Settings');
    document.title = 'Settings · Meridian';
    loadTooling();
    if (pushState && window.location.pathname !== '/settings') {
        history.pushState(null, '', '/settings');
    }
};

// Syntax highlighting for the settings screen's one-line commands.
// lib/command-highlight.js is the source of truth — change both. Not a shell
// parser: these come from a fixed table, so four token classes cover them.
function highlightCommand(text) {
    if (typeof text !== 'string') return '';
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    return tokens.map((tok, i) => {
        const cls = i === 0 ? 'tok-bin'
            : tok.startsWith('-') ? 'tok-flag'
            : tok.includes('/') ? 'tok-path'
            : 'tok-sub';
        return `<span class="${cls}">${escapeHtml(tok)}</span>`;
    }).join(' ');
}

const ICON_RUN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.5v9l7-4.5-7-4.5z" fill="currentColor"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

// --- Settings: the CLIs that can run the pipeline ---------------------------
//
// Every action shows the exact command before it runs. The command text comes
// from the server, built from the same table the server executes, so the two
// cannot drift; the client posts an action name and never a command.

const ACTION_LABELS = { install: 'Install plugin', uninstall: 'Uninstall plugin', update: 'Update plugin', login: 'Login' };

async function loadTooling() {
    const list = document.getElementById('tooling-list');
    if (!list) return;
    list.innerHTML = '<div class="tooling-loading">Checking your CLIs…</div>';
    try {
        const res = await fetch('/api/tooling');
        const data = await res.json();
        renderTooling(data.tools || []);
    } catch (err) {
        list.innerHTML = '<div class="tooling-loading">Could not reach the Meridian server.</div>';
    }
}

function renderTooling(tools) {
    const list = document.getElementById('tooling-list');
    if (!list) return;

    // The lede promises a command to copy or run. With no CLI on the machine
    // there is no command on the screen at all, so the promise is false and
    // the sentence goes away. One CLI present is enough to keep it true.
    const lede = document.getElementById('settings-lede');
    if (lede) {
        const noneRunnable = tools.length > 0 && tools.every(t => t.present === false);
        lede.classList.toggle('hidden', noneRunnable);
    }
    list.innerHTML = tools.map(t => {
        // A CLI that is not on this machine gets no action and no command:
        // installing one is a platform-specific `curl | sh`, which Meridian
        // has no business running. The card links to the vendor's own page
        // and shows the destination in full, so the operator sees where the
        // link goes before clicking it.
        if (t.present === false) {
            return `
        <div class="tooling-card" data-cli="${escapeHtml(t.cli)}">
            <img class="tooling-icon tooling-icon--off" src="${escapeHtml(t.icon)}" alt="" width="40" height="40">
            <div class="tooling-body">
                <div class="tooling-name">${escapeHtml(t.label)}</div>
                <div class="tooling-pills">
                    <span class="tooling-pill tooling-pill--off">CLI not installed</span>
                </div>
            </div>
            <a class="secondary-btn tooling-install-link" href="${escapeHtml(t.installUrl)}"
               target="_blank" rel="noopener noreferrer">Install guide ↗</a>
        </div>
        <p class="tooling-link-target">Opens <code>${escapeHtml(t.installUrl)}</code></p>`;
        }

        // Installed and current are separate facts: a copy can be installed and
        // still be the version from before this morning's edit, which is the
        // failure the operator cannot otherwise see.
        const pluginBadge = t.installed
            ? (t.current === false
                ? `<span class="tooling-pill tooling-pill--warn">Outdated · ${t.drifted} file${t.drifted === 1 ? '' : 's'} differ from this repo</span>`
                : `<span class="tooling-pill tooling-pill--on">Plugin installed${t.version ? ` · ${escapeHtml(t.version)}` : ''}</span>`)
            : '<span class="tooling-pill tooling-pill--off">Plugin not installed</span>';
        // Readiness and the plugin are separate facts: Antigravity has no login
        // action at all, so its state is reported rather than actioned.
        const readyBadge = t.ready
            ? '<span class="tooling-pill tooling-pill--on">Ready to run</span>'
            : `<span class="tooling-pill tooling-pill--warn">${escapeHtml(t.reason || 'Not ready')}</span>`;
        return `
        <div class="tooling-card" data-cli="${escapeHtml(t.cli)}">
            <img class="tooling-icon" src="${escapeHtml(t.icon)}" alt="" width="40" height="40">
            <div class="tooling-body">
                <div class="tooling-name">${escapeHtml(t.label)}</div>
                <div class="tooling-pills">${pluginBadge}${readyBadge}</div>
            </div>
            <button type="button" class="secondary-btn tooling-action-btn"
                data-cli="${escapeHtml(t.cli)}" data-action="${escapeHtml(t.action)}">
                ${escapeHtml(ACTION_LABELS[t.action] || t.action)}
            </button>
        </div>
        <div class="tooling-command hidden" id="tooling-cmd-${escapeHtml(t.cli)}">
            <div class="cmd-block">
                <code class="cmd-text" data-raw="${escapeHtml(t.command || '')}">${highlightCommand(t.command || '')}</code>
                <div class="cmd-actions">
                    <button type="button" class="cmd-icon-btn" data-run="${escapeHtml(t.cli)}" data-action="${escapeHtml(t.action)}" title="Run here" aria-label="Run here">${ICON_RUN}</button>
                    <button type="button" class="cmd-icon-btn" data-copy="${escapeHtml(t.cli)}" title="Copy" aria-label="Copy command">${ICON_COPY}</button>
                </div>
            </div>
            ${t.action === 'login' ? '<p class="tooling-note">Running it opens your browser to sign in. Meridian never sees the credential — the CLI stores its own.</p>' : ''}
            <pre class="tooling-output hidden" id="tooling-out-${escapeHtml(t.cli)}"></pre>
        </div>`;
    }).join('');
}

// Registered on the capture phase: a dispatch button lives inside a
// `.task-card` that itself opens the task modal on click. Capturing here and
// stopping propagation keeps the click from also bubbling into the card's
// own handler and popping the modal open behind the request.
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-dispatch-action]');
    if (!btn) return;
    event.stopPropagation();
    const { dispatchAction: action, taskId, taskTitle, project } = btn.dataset;

    // Task 14: starting a run is not undoable, and a misclick during this
    // plan's own execution started a real one against a live repository.
    // `Stop` and `Remove from queue` reduce activity and are recoverable, so
    // only `dispatch` confirms here — `Dispatch all` confirms separately,
    // through confirmDispatchAll, before this handler is ever reached.
    if (action === 'dispatch' && !suppressDispatchConfirm) {
        const title = taskTitle ? ` — ${taskTitle}` : '';
        const ok = await confirmDispatch(
            `Start a real agent run on ${taskId}${title} in ${project}?`
        );
        if (!ok) return;
    }

    btn.disabled = true;
    try {
        if (action === 'dispatch') {
            const res = await fetch('/api/projects/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: project, taskId, tool: 'claude' })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data.error) showFlashMessage(data.error, 'error');
            }
        } else if (action === 'unqueue') {
            const res = await fetch(`/api/projects/dispatch/${encodeURIComponent(taskId)}?project=${encodeURIComponent(project)}`,
                { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data.error) showFlashMessage(data.error, 'error');
            }
        } else if (action === 'stop') {
            const res = await fetch('/api/projects/dispatch/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: project, taskId })
            });
            const data = await res.json().catch(() => ({}));
            // stopped: false with a reason means a session is running in that
            // repo that Meridian did not start — the operator has to stop it
            // where they started it. Say so; when it did stop, the SSE
            // re-render is the feedback and nothing more is needed here.
            if (res.ok && data.stopped === false && data.reason) {
                showFlashMessage(data.reason, 'error');
            }
        }
    } catch (err) {
        showFlashMessage('Could not reach the server', 'error');
    } finally {
        btn.disabled = false;
    }
    // The SSE broadcast re-renders; no optimistic update, so the board never
    // shows a queue position the server does not have.
}, true);

document.addEventListener('click', async (event) => {
    const toggle = event.target.closest('.tooling-action-btn');
    if (toggle) {
        const box = document.getElementById(`tooling-cmd-${toggle.dataset.cli}`);
        if (box) box.classList.toggle('hidden');
        return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
        const box = document.getElementById(`tooling-cmd-${copyBtn.dataset.copy}`);
        // The rendered text carries the highlight spans; the raw command is
        // kept on the element so a copy never ships markup or lost spacing.
        const text = box ? (box.querySelector('.cmd-text').dataset.raw || '') : '';
        try {
            await navigator.clipboard.writeText(text);
            showFlashMessage('Command copied', 'success');
        } catch (err) {
            showFlashMessage('Could not copy — select the text instead', 'error');
        }
        return;
    }

    const runBtn = event.target.closest('[data-run]');
    if (!runBtn) return;
    const cli = runBtn.dataset.run;
    const out = document.getElementById(`tooling-out-${cli}`);
    const isLogin = runBtn.dataset.action === 'login';
    runBtn.disabled = true;
    runBtn.classList.add('is-running');
    if (out) {
        out.classList.remove('hidden');
        // Login streams over SSE while it waits for the browser callback, so
        // the box starts empty and fills; the others only speak at the end.
        out.textContent = isLogin ? 'Waiting for you to finish signing in…\n' : 'Running…';
    }
    try {
        const res = await fetch(`/api/tooling/${cli}/${runBtn.dataset.action}`, { method: 'POST' });
        const data = await res.json();
        if (out && !isLogin) out.textContent = data.output || data.error || '(no output)';
        if (out && isLogin && data.error) out.textContent += `\n${data.error}`;
        showFlashMessage(data.ok ? 'Done' : (data.error || 'Command failed'), data.ok ? 'success' : 'error');
        // The state the screen shows was read before this ran, so re-read it.
        loadTooling();
    } catch (err) {
        if (out) out.textContent = String(err);
        showFlashMessage('Network error', 'error');
    } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('is-running');
    }
});

const settingsBtn = document.getElementById('settings-btn');
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => showSettingsView(true));
}

const headerTitle = document.querySelector('header h1');
if (headerTitle) {
    headerTitle.style.cursor = 'pointer';
    headerTitle.addEventListener('click', () => showDashboard(true));
}

btnEdit.addEventListener('click', () => {
    if (currentProjectViewPath) {
        openEditModal(currentProjectViewPath);
    }
});

// Writes a starting-point `.claude/settings.json` for `projectPath`, then
// lets the SSE broadcast re-render the button away (canCreateAllowlist goes
// false once the file exists). This writes the file and stops there — it
// never stages or commits it, and never claims to the operator that it has
// been committed; that step is theirs.
async function createAllowlist(projectPath) {
    try {
        const res = await fetch('/api/projects/allowlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showFlashMessage(data.error || 'Could not create the allowlist', 'error');
            return;
        }
        // This is a starting point, not a security audit of the target
        // project — say so, and say plainly when the test command could not
        // be guessed and needs to be added by hand.
        const runnerNote = data.runner
            ? `runs \`${data.runner}\``
            : 'the test command could not be detected — add it by hand';
        showFlashMessage(
            `Created .claude/settings.json (starting point only, review it) — ${runnerNote}`,
            'success'
        );
    } catch (err) {
        showFlashMessage('Could not reach the server', 'error');
    }
}

// `Stop queue` is named for what it does: it discards the queue rather than
// suspending it. A button labelled "Pause" that threw away queued work would
// be a trap.
async function setAutoDispatch(projectPath, enabled) {
    try {
        await fetch('/api/projects/dispatch/auto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath, enabled })
        });
    } catch (err) {
        showFlashMessage('Could not reach the server', 'error');
    }
    // The SSE broadcast re-renders both the header controls and any per-row
    // controls in the global view; no optimistic update here.
}

// Renders exactly one of `Dispatch all` / `Stop queue` in the project view's
// header, from the project's own status fields — never invented client-side
// state. A blocked `Dispatch all` states its reason in the title rather than
// swallowing the click.
// public/index.html carries no markup for this button — it exists only when
// a repository needs it — so it is created once on first use and reused
// after that, the same way the flash-message nodes in showFlashMessage are.
function allowlistHeaderBtn() {
    let btn = document.getElementById('allowlist-header-btn');
    if (!btn) {
        const stopBtn = document.getElementById('stop-queue-btn');
        if (!stopBtn || !stopBtn.parentNode) return null;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'allowlist-header-btn';
        btn.className = 'secondary-btn allowlist-btn hidden';
        btn.textContent = 'Create allowlist';
        btn.title = 'Write a starting .claude/settings.json for this repository';
        stopBtn.parentNode.insertBefore(btn, stopBtn.nextSibling);
    }
    return btn;
}

function updateDispatchHeaderControls(proj) {
    const dispatchBtn = document.getElementById('dispatch-all-btn');
    const stopBtn = document.getElementById('stop-queue-btn');
    const allowlistBtn = allowlistHeaderBtn();
    if (!dispatchBtn || !stopBtn) return;

    if (!proj) {
        dispatchBtn.classList.add('hidden');
        stopBtn.classList.add('hidden');
        if (allowlistBtn) allowlistBtn.classList.add('hidden');
        return;
    }

    // Offered only when the repository has no `.claude/settings.json` at
    // all — never over a file the operator wrote themselves, even one whose
    // `permissions.allow` is empty or missing.
    if (allowlistBtn) {
        allowlistBtn.classList.toggle('hidden', !proj.canCreateAllowlist);
        allowlistBtn.onclick = () => createAllowlist(proj.path);
    }

    if (proj.autoDispatch) {
        dispatchBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        const queueLen = (proj.queue || []).length;
        stopBtn.textContent = queueLen > 0 ? `Stop queue (${queueLen})` : 'Stop queue';
        stopBtn.title = 'Disarm auto-dispatch and discard the queue';
        stopBtn.onclick = () => setAutoDispatch(proj.path, false);
    } else {
        dispatchBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        dispatchBtn.disabled = Boolean(proj.dispatchBlockedReason);
        dispatchBtn.title = proj.dispatchBlockedReason || 'Arm automatic dispatch for this project';
        dispatchBtn.onclick = () => confirmDispatchAll(proj.path, proj.name);
    }
}

function refreshProjectView() {
    if (!currentProjectViewPath) return;

    if (currentProjectViewPath === '__GLOBAL__') {
        document.getElementById('pv-title').textContent = 'Global Tickets View 🌐';
        document.getElementById('pv-desc').textContent = 'Aggregated Kanban view of tasks across all monitored workspace projects.';
        document.getElementById('pv-stack').innerHTML = `<span class="stack-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.4);">All ${currentProjectsData.length} Projects</span>`;

        btnEdit.classList.add('hidden');
        addTaskForm.classList.add('hidden');
        // `Dispatch all` in the header arms one project; the global view has
        // none of its own, so it disappears here — the per-project controls
        // live in each project's dashboard card instead.
        updateDispatchHeaderControls(null);

        let allTasks = [];
        currentProjectsData.forEach(proj => {
            (proj.tasks || []).forEach(t => {
                allTasks.push({
                    ...t,
                    projectName: proj.name,
                    projectPath: proj.path
                });
            });
        });

        renderKanbanBoard(allTasks);
        return;
    }
    
    btnEdit.classList.remove('hidden');
    addTaskForm.classList.remove('hidden');
    
    const proj = currentProjectsData.find(p => p.path === currentProjectViewPath);
    if (!proj) {
        showDashboard();
        return;
    }
    
    // Update Header
    document.title = `${proj.name} · Meridian`;
    setBreadcrumb(proj.name);
    document.getElementById('pv-title').textContent = proj.name;
    document.getElementById('pv-desc').textContent = proj.description || 'No description provided.';
    
    const stackArray = Array.isArray(proj.stack) ? proj.stack : (proj.stack ? proj.stack.split(',').map(s => s.trim()).filter(Boolean) : []);
    document.getElementById('pv-stack').innerHTML = stackArray.map(tech => `<span class="stack-badge">${tech}</span>`).join('');

    updateDispatchHeaderControls(proj);

    // Render Kanban
    renderKanbanBoard(proj.tasks || []);
}

function isStandardTId(id) {
    return typeof id === 'string' && /^T\d+$/i.test(id.trim());
}

function parseTIdNumber(id) {
    if (!isStandardTId(id)) return Infinity;
    return parseInt(id.trim().substring(1), 10);
}

function sortColumnTasks(tasks) {
    return [...tasks].sort((a, b) => {
        const isStdA = isStandardTId(a.id);
        const isStdB = isStandardTId(b.id);

        if (isStdA && !isStdB) return -1;
        if (!isStdA && isStdB) return 1;

        if (isStdA && isStdB) {
            const numA = parseTIdNumber(a.id);
            const numB = parseTIdNumber(b.id);
            return numA - numB;
        }

        return 0;
    });
}

function interleavedByProject(tasks) {
    const buckets = new Map();
    for (const task of tasks) {
        const key = task.projectName || '__none__';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(task);
    }
    const groups = [...buckets.values()];
    if (groups.length <= 1) return tasks;

    const result = [];
    const maxLen = Math.max(...groups.map(g => g.length));
    for (let i = 0; i < maxLen; i++) {
        for (const group of groups) {
            if (i < group.length) result.push(group[i]);
        }
    }
    return result;
}

function renderRunningTickets(tasks) {
    const section = document.getElementById('running-tickets-section');
    const list = document.getElementById('running-tickets-list');
    const countEl = document.getElementById('running-tickets-count');
    if (!section || !list) return;

    const running = tasks.filter(t => t.running);

    if (running.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    if (countEl) countEl.textContent = running.length;

    const statusLabel = id => {
        const s = KANBAN_STATUSES.find(k => k.id === id);
        return s ? s.label : id;
    };

    list.innerHTML = running.map(task => {
        const projBadge = task.projectName
            ? `<span class="running-ticket-proj">· ${task.projectName}</span>`
            : '';
        const projPathAttr = task.projectPath ? task.projectPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
        return `
            <div class="running-ticket-card" title="${escapeHtml(task.title)}" onclick="openTaskModal('${task.id}', '${projPathAttr}')" style="cursor: pointer;">
                <div class="running-ticket-id">${task.id || ''}</div>
                <div class="running-ticket-title">${renderInlineCode(task.title)}</div>
                <div class="running-ticket-meta">
                    <span class="running-ticket-status">${statusLabel(task.status)}</span>
                    ${projBadge}
                </div>
            </div>
        `;
    }).join('');
}

function renderTaskCardHtml(task, allTasks) {
    const taskIdDisplay = task.id ? `[${task.id}] ` : '';
    const projPathAttr = task.projectPath ? task.projectPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
    const projectBadge = task.projectName ? `<span class="project-tag-badge" title="${task.projectName}">${task.projectName}</span>` : '';
    const runningClass = task.running ? ' task-card--running' : '';
    const runningBadge = task.running ? '<span class="running-inline-dot" title="Agent is working on this task"></span>' : '';
    const parentBadgeLabel = parentBadge(task);
    const progress = subtaskProgress(allTasks, task);
    const parentBadgeHtml = parentBadgeLabel !== null
        ? `<span class="task-parent-badge" title="Parent task ${task.parent}">${parentBadgeLabel}</span>` : '';
    const progressChipHtml = progress !== null
        ? `<span class="task-progress-chip" title="Sub-tasks done">${progress.done}/${progress.total}</span>` : '';

    let questionsBadge = '';
    if (task.questions && task.questions.length > 0) {
        const unanswered = task.questions.filter(q => !q.answer || !q.answer.trim()).length;
        if (unanswered > 0) {
            questionsBadge = `<span class="task-questions-pill" title="${unanswered} AI question(s) awaiting answer">❓ ${unanswered}</span>`;
        } else {
            questionsBadge = `<span class="task-questions-pill" style="color: #34d399; background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.35);" title="All questions answered">💬 ${task.questions.length}</span>`;
        }
    }

    const hasMock = Boolean(task.mock_path || task.has_mock);
    const mockBadge = hasMock ? '<span class="task-mock-pill" title="Interactive HTML mockup available">🖥️ Mock</span>' : '';

    // Terminal cards show when they got there: completed_at for done, moved_at
    // for nope — the same timestamps their columns sort and window by.
    const stampRaw = task.status === 'done' ? task.completed_at
        : task.status === 'nope' ? task.moved_at : null;
    let stampHtml = '';
    if (stampRaw) {
        const d = new Date(stampRaw);
        if (!Number.isNaN(d.getTime())) {
            const label = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
                + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            stampHtml = `<div class="task-stamp" title="${task.status === 'done' ? 'Completed' : 'Dismissed'} ${d.toLocaleString()}">${label}</div>`;
        }
    }

    // Dispatch context is looked up by the project that owns this task, not
    // by whatever view is currently open — the global board tags every task
    // with its own projectPath, and a single-project board falls back to it.
    const dispatchProjectPath = task.projectPath || currentProjectViewPath;
    const dispatchCtx = dispatchContextFor(dispatchProjectPath);
    const btn = dispatchButton(task, dispatchCtx);
    let dispatchBtnHtml = '';
    let queueBadgeHtml = '';
    if (btn) {
        dispatchBtnHtml = `<button type="button" class="card-dispatch-btn card-dispatch-btn--${btn.action}"
            data-dispatch-action="${btn.action}" data-task-id="${escapeHtml(task.id)}"
            data-task-title="${escapeHtml(task.title || '')}"
            data-project="${escapeHtml(dispatchProjectPath || '')}" title="${escapeHtml(btn.title)}">${btn.label}</button>`;
    }
    // A queued task can sit idle — auth is missing, or another session holds
    // the repo — and the queue is deliberately kept rather than discarded.
    // The card says so, with the blocked reason when the server has one,
    // instead of just looking stuck.
    if (btn && btn.action === 'unqueue') {
        const position = dispatchCtx.queue.indexOf(task.id) + 1;
        const waiting = dispatchCtx.dispatchBlockedReason
            ? ` — waiting: ${dispatchCtx.dispatchBlockedReason}` : '';
        queueBadgeHtml = `<span class="task-queue-badge" title="${escapeHtml(`Queued at position ${position}, waiting to run${waiting}`)}">Queued #${position}</span>`;
    }

    return `
        <div class="task-card${runningClass}" onclick="handleTaskCardClick(event, '${task.id}', '${projPathAttr}')">
            <div class="task-title">${runningBadge}${projectBadge}${parentBadgeHtml}${progressChipHtml}${mockBadge}${questionsBadge}<span class="task-id-code">${taskIdDisplay}</span>${renderInlineCode(task.title)}</div>
            ${queueBadgeHtml ? `<div class="task-queue-row">${queueBadgeHtml}</div>` : ''}
            ${(() => {
                const move = manualTransition(task.status);
                const moveBtnHtml = move
                    ? `<button class="task-move-btn task-move-${move.to}" onclick="changeTaskStatus('${task.id}', '${move.to}', '${projPathAttr}')" title="Move this task to ${move.to}">${move.label}</button>`
                    : '';
                if (!moveBtnHtml && !dispatchBtnHtml) return '';
                return `<div class="task-actions">${moveBtnHtml}${dispatchBtnHtml}</div>`;
            })()}
            ${stampHtml}
        </div>
    `;
}

// What the operator has done to the board that a rebuild would otherwise
// throw away: scroll positions, opened details, revealed hidden-done groups,
// and the rails expanded this session. Every SSE message rebuilds the board's
// innerHTML, so this is captured before and restored after.
function captureBoardState(board) {
    const state = {
        boardScrollLeft: board.scrollLeft,
        columnScrollTop: {},
        revealedHidden: new Set(),
        expandedRails: new Set(expandedRails)
    };
    board.querySelectorAll('.kanban-column[data-status-id]').forEach(col => {
        const id = col.dataset.statusId;
        const tasksEl = col.querySelector('.kanban-tasks');
        if (tasksEl) state.columnScrollTop[id] = tasksEl.scrollTop;
        const group = col.querySelector('.done-hidden-tasks');
        if (group && !group.classList.contains('hidden')) state.revealedHidden.add(id);
    });
    return state;
}

// Restores what captureBoardState took. Anything that no longer exists (a task
// that moved column, a column now collapsed) is skipped, never thrown on.
// Hidden groups are revealed before scroll offsets are set, since revealing
// changes the column's scrollHeight.
function restoreBoardState(board, state) {
    if (!state) return;
    state.revealedHidden.forEach(id => {
        const col = board.querySelector(`.kanban-column[data-status-id="${id}"]`);
        if (!col) return;
        const group = col.querySelector('.done-hidden-tasks');
        const chip = col.querySelector('.done-hidden-chip');
        if (group) group.classList.remove('hidden');
        if (chip) chip.remove();
    });
    Object.entries(state.columnScrollTop).forEach(([id, top]) => {
        const tasksEl = board.querySelector(`.kanban-column[data-status-id="${id}"] .kanban-tasks`);
        if (tasksEl) tasksEl.scrollTop = top;
    });
    board.scrollLeft = state.boardScrollLeft;
}

window.expandRail = function(statusId) {
    expandedRails.add(statusId);
    refreshProjectView();
};

window.railKeydown = function(event, statusId) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    expandRail(statusId);
};

function renderKanbanBoard(tasks) {
    const board = document.getElementById('kanban-board');
    const isGlobal = currentProjectViewPath === '__GLOBAL__';

    const doneWindowSelect = document.getElementById('done-window');
    if (doneWindowSelect) {
        doneWindowSelect.value = doneWindowDays === null ? '' : String(doneWindowDays);
        doneWindowSelect.onchange = (e) => {
            localStorage.setItem('meridian_done_window', e.target.value);
            doneWindowDays = e.target.value === '' ? null : Number(e.target.value);
            refreshProjectView();
        };
    }

    currentKanbanTasks = tasks || [];

    const searchInput = document.getElementById('card-search-input');
    const searchClear = document.getElementById('card-search-clear');
    const searchCount = document.getElementById('card-search-count');

    if (searchInput) {
        if (searchInput.value !== cardSearchQuery) {
            searchInput.value = cardSearchQuery;
        }
        searchInput.oninput = (e) => {
            cardSearchQuery = e.target.value;
            renderKanbanBoard(currentKanbanTasks);
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                cardSearchQuery = '';
                searchInput.value = '';
                renderKanbanBoard(currentKanbanTasks);
                searchInput.blur();
            }
        };
    }

    if (searchClear) {
        searchClear.onclick = () => {
            cardSearchQuery = '';
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            renderKanbanBoard(currentKanbanTasks);
        };
    }

    const q = cardSearchQuery.trim().toLowerCase();
    let displayTasks = tasks;
    if (q) {
        displayTasks = tasks.filter(t => {
            const titleMatch = Boolean(t.title && t.title.toLowerCase().includes(q));
            const idMatch = Boolean(t.id && t.id.toLowerCase().includes(q));
            const bodyMatch = Boolean(t.justification && t.justification.toLowerCase().includes(q));
            const resultsMatch = Boolean(Array.isArray(t.expected_results) && t.expected_results.some(r => r && r.toLowerCase().includes(q)));
            const projMatch = Boolean(isGlobal && t.projectName && t.projectName.toLowerCase().includes(q));
            return titleMatch || idMatch || bodyMatch || resultsMatch || projMatch;
        });

        if (searchCount) {
            searchCount.textContent = `${displayTasks.length}`;
            searchCount.title = `${displayTasks.length} matching cards out of ${tasks.length}`;
            searchCount.classList.remove('hidden');
        }
        if (searchClear) searchClear.classList.remove('hidden');
    } else {
        if (searchCount) searchCount.classList.add('hidden');
        if (searchClear) searchClear.classList.add('hidden');
    }

    renderRunningTickets(displayTasks);

    // Rails are decided on the total per status — never on the done/nope windowed count.
    const tasksForCollapse = q ? displayTasks : tasks;
    const collapsed = collapsedColumns(
        KANBAN_STATUSES.map(s => ({ id: s.id, count: tasksForCollapse.filter(t => t.status === s.id).length })),
        expandedRails
    );

    const boardState = captureBoardState(board);
    board.innerHTML = '';

    KANBAN_STATUSES.forEach(statusCol => {
        let colTasks = displayTasks.filter(t => t.status === statusCol.id);
        if (statusCol.id === 'done') {
            colTasks = [...colTasks].sort(byRecencyDesc('completed_at'));
        } else if (statusCol.id === 'nope') {
            colTasks = [...colTasks].sort(byRecencyDesc('moved_at'));
        } else {
            colTasks = sortColumnTasks(colTasks);
        }
        if (isGlobal) colTasks = interleavedByProject(colTasks);

        if (collapsed.has(statusCol.id)) {
            board.insertAdjacentHTML('beforeend', `
            <div class="kanban-column kanban-column--collapsed" data-status-id="${statusCol.id}" role="button" tabindex="0" title="Expand ${statusCol.label}" onclick="expandRail('${statusCol.id}')" onkeydown="railKeydown(event, '${statusCol.id}')">
                <span class="kanban-rail-label">${statusCol.label}</span>
                <span class="kanban-column-count">${colTasks.length}</span>
            </div>
            `);
            return;
        }

        let visibleTasks = colTasks;
        let hiddenTasks = [];
        if (!q) {
            if (statusCol.id === 'done') {
                visibleTasks = colTasks.filter(t => isRecentlyCompleted(t, doneWindowDays));
                hiddenTasks = colTasks.filter(t => !isRecentlyCompleted(t, doneWindowDays));
            } else if (statusCol.id === 'nope') {
                visibleTasks = colTasks.filter(t => isRecentlyDismissed(t, doneWindowDays));
                hiddenTasks = colTasks.filter(t => !isRecentlyDismissed(t, doneWindowDays));
            }
        }

        const hiddenChipHtml = hiddenTasks.length > 0 ? `
            <div class="done-hidden-chip" onclick="this.nextElementSibling.classList.remove('hidden'); this.remove();">+${hiddenTasks.length} ${statusCol.id === 'nope' ? 'dismissed' : 'completed'}</div>
            <div class="done-hidden-tasks hidden">
                ${hiddenTasks.map(task => renderTaskCardHtml(task, tasks)).join('')}
            </div>
        ` : '';

        // Only an expanded rail is truly empty; a windowed done/nope column
        // with nothing visible still has its chip, never this placeholder.
        const emptyHtml = colTasks.length === 0 ? `<div class="kanban-empty">${q ? 'No matches' : 'Empty'}</div>` : '';

        const colHtml = `
            <div class="kanban-column" data-status-id="${statusCol.id}">
                <div class="kanban-column-header">
                    <span>${statusCol.label}</span>
                    <span class="kanban-column-count">${visibleTasks.length}</span>
                </div>
                <div class="kanban-tasks">
                    ${visibleTasks.map(task => renderTaskCardHtml(task, tasks)).join('')}
                    ${hiddenChipHtml}
                    ${emptyHtml}
                </div>
            </div>
        `;

        board.insertAdjacentHTML('beforeend', colHtml);
    });

    restoreBoardState(board, boardState);
}

window.scrollToKanbanColumn = function(statusId) {
    const col = document.querySelector(`.kanban-column[data-status-id="${statusId}"]`);
    if (col) {
        col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        col.classList.add('column-highlight');
        setTimeout(() => col.classList.remove('column-highlight'), 1200);
    }
};

addTaskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProjectViewPath || currentProjectViewPath === '__GLOBAL__') return;
    
    const input = document.getElementById('new-task-input');
    const title = input.value.trim();
    if (!title) return;
    
    input.disabled = true;
    try {
        const res = await fetch('/api/projects/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: currentProjectViewPath, title })
        });
        if (res.ok) {
            input.value = '';
        } else {
            const data = await res.json();
            showFlashMessage('Error adding task: ' + data.error);
        }
    } catch (err) {
        showFlashMessage('Network error adding task', 'error', 'error');
    } finally {
        input.disabled = false;
        input.focus();
    }
});

window.changeTaskStatus = async function(taskId, newStatusId, targetProjPath) {
    const projPath = targetProjPath || currentProjectViewPath;
    if (!projPath || projPath === '__GLOBAL__') return;

    // The board offers exactly two moves (manualTransition): nope, and reopen.
    // Only dismissal asks for a why — it is shown on the card afterwards.
    let justification = '';
    if (newStatusId === 'nope') {
        justification = prompt(`Please provide a justification for moving this task to ${newStatusId.toUpperCase()}:`);
        if (justification === null) {
            refreshProjectView(); // Revert UI
            return; 
        }
        if (justification.trim() === '') {
            showFlashMessage('Justification is required for this status.', 'error');
            refreshProjectView(); // Revert UI
            return;
        }
    }
    
    // Persist the canonical status id (e.g. 'qa_review'), never the column label.
    // The server rejects anything outside the nine canonical statuses.
    if (!KANBAN_STATUSES.some(s => s.id === newStatusId)) {
        showFlashMessage(`Unknown status '${newStatusId}'`, 'error');
        refreshProjectView(); // Revert UI
        return;
    }

    try {
        const res = await fetch(`/api/projects/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: projPath, status: newStatusId, justification })
        });
        
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showFlashMessage(data.error || 'Failed to update task', 'error');
            refreshProjectView(); // Revert UI
        }
    } catch (err) {
        showFlashMessage('Network error updating task', 'error');
        refreshProjectView(); // Revert UI
    }
};

/* =========================================
   Task Detail Modal Logic (Centered Modal)
   ========================================= */

let currentModalTask = null;
let currentModalProjPath = null;

const taskModal = document.getElementById('task-modal');
const closeTaskModalBtn = document.getElementById('close-task-modal-btn');
const closeTaskModalFooterBtn = document.getElementById('tm-close-footer-btn');
const tmSaveAnswersBtn = document.getElementById('tm-save-answers-btn');
const tmRequestChangesBtn = document.getElementById('tm-request-changes-btn');
const tmApproveSpecBtn = document.getElementById('tm-approve-spec-btn');
const revisionModal = document.getElementById('revision-modal');
const closeRevisionModalBtn = document.getElementById('close-revision-modal-btn');
const cancelRevisionModalBtn = document.getElementById('cancel-revision-modal-btn');
const confirmRevisionBtn = document.getElementById('confirm-revision-btn');
const tmRevisionFeedbackInput = document.getElementById('tm-revision-feedback-input');
const tmAskAiBtn = document.getElementById('tm-ask-ai-btn');
const tmAskAiBox = document.getElementById('tm-ask-ai-box');
const tmAskAiInput = document.getElementById('tm-ask-ai-input');
const tmCancelAskAiBtn = document.getElementById('tm-cancel-ask-ai-btn');
const tmSubmitAskAiBtn = document.getElementById('tm-submit-ask-ai-btn');

function statusBadgeText(status) {
    const s = KANBAN_STATUSES.find(st => st.id === status);
    return s ? s.label : (status || '');
}

window.handleTaskCardClick = function(event, taskId, projectPath) {
    if (event.target.closest('.task-actions') || event.target.closest('button') || event.target.closest('a')) {
        return;
    }
    openTaskModal(taskId, projectPath);
};

window.openTaskModal = async function(taskId, projectPath) {
    let projPath = projectPath || currentProjectViewPath;
    let task = null;

    // Search task in memory across registered projects
    if (currentProjectsData && currentProjectsData.length > 0) {
        for (const p of currentProjectsData) {
            if (!projPath || p.path === projPath) {
                const found = (p.tasks || []).find(t => t.id === taskId);
                if (found) {
                    task = found;
                    if (!projPath) projPath = p.path;
                    break;
                }
            }
        }
    }

    currentModalTask = task ? { ...task } : { id: taskId, title: 'Loading...', status: 'backlog' };
    currentModalProjPath = projPath || (task && task.projectPath) || '';

    // Update URL with ?task=<id>
    try {
        const url = new URL(window.location);
        url.searchParams.set('task', taskId);
        window.history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
    } catch (e) {}

    switchTaskModalTab('spec');
    // Stale runs from whatever task was open before must not flash while the
    // new task's own data loads.
    const runsListEl = document.getElementById('tm-runs-list');
    const runsEmptyEl = document.getElementById('tm-runs-empty');
    if (runsListEl) runsListEl.innerHTML = '';
    if (runsEmptyEl) runsEmptyEl.classList.add('hidden');
    renderTaskModalData(currentModalTask, null, currentModalTask.mock_path, currentModalTask.has_mock);
    if (taskModal) taskModal.classList.remove('hidden');

    // Fetch hydrated task details (and spec_content, mock_path) from backend
    if (currentModalProjPath && currentModalProjPath !== '__GLOBAL__') {
        try {
            const loadingEl = document.getElementById('tm-spec-loading');
            if (loadingEl) loadingEl.classList.remove('hidden');
            const res = await fetch(`/api/projects/tasks/${taskId}?project=${encodeURIComponent(currentModalProjPath)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.task) {
                    currentModalTask = data.task;
                    renderTaskModalData(data.task, data.spec_content, data.mock_path, data.has_mock);
                }
            }
        } catch (err) {
            console.error('Error fetching task details:', err);
        } finally {
            const loadingEl = document.getElementById('tm-spec-loading');
            if (loadingEl) loadingEl.classList.add('hidden');
        }
    }
};

// Two states over the same text: the rendered box for reading (which is what
// gives `code` spans their formatting) and a textarea for writing. The Edit
// button swaps to the second; `Save` in the footer swaps back.
function renderTaskDescription(text, editing) {
    const box = document.getElementById('tm-desc');
    const input = document.getElementById('tm-desc-input');
    const editBtn = document.getElementById('tm-edit-desc-btn');
    if (!box || !input) return;

    if (editing) {
        input.value = text;
        input.classList.remove('hidden');
        box.classList.add('hidden');
        if (editBtn) editBtn.classList.add('hidden');
        return;
    }

    input.classList.add('hidden');
    box.classList.remove('hidden');
    if (editBtn) editBtn.classList.remove('hidden');
    if (text.trim()) {
        box.innerHTML = renderInlineCode(text);
        box.classList.remove('task-modal-desc-empty');
    } else {
        box.textContent = 'No context recorded for this task.';
        box.classList.add('task-modal-desc-empty');
    }
}

// True only while the textarea is open, so Save knows whether the operator
// actually edited the text or was just reading it.
function isEditingDescription() {
    const input = document.getElementById('tm-desc-input');
    return Boolean(input && !input.classList.contains('hidden'));
}

function formatSpecMarkdown(content, projectPath) {
    if (!content) return '';
    let html = '';
    if (window.marked && typeof window.marked.parse === 'function') {
        html = window.marked.parse(content);
    } else {
        html = `<pre><code>${escapeHtml(content)}</code></pre>`;
    }

    // Rewrite relative image src attributes so they load via /api/projects/asset
    if (projectPath && html.includes('<img ')) {
        const div = document.createElement('div');
        div.innerHTML = html;
        div.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src');
            if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:') && !src.startsWith('/')) {
                img.src = `/api/projects/asset?projectPath=${encodeURIComponent(projectPath)}&assetPath=${encodeURIComponent(src)}`;
                img.style.maxWidth = '100%';
                img.style.borderRadius = '6px';
                img.style.marginTop = '0.5rem';
                img.style.marginBottom = '0.5rem';
            }
        });
        html = div.innerHTML;
    }
    return html;
}

function renderTaskModalData(task, specContent, mockPath, hasMock) {
    const idEl = document.getElementById('tm-id');
    if (idEl) idEl.textContent = task.id ? `[${task.id}]` : '';

    const statusEl = document.getElementById('tm-status');
    if (statusEl) {
        statusEl.textContent = statusBadgeText(task.status);
        statusEl.className = `task-status-badge status-${task.status}`;
    }

    const priorityEl = document.getElementById('tm-priority');
    if (priorityEl) {
        priorityEl.value = task.priority || 'medium';
        priorityEl.className = `task-priority-badge task-priority-select priority-${task.priority || 'medium'}`;
    }

    const projectEl = document.getElementById('tm-project');
    if (projectEl) {
        if (task.projectName) {
            projectEl.textContent = task.projectName;
            projectEl.classList.remove('hidden');
        } else {
            projectEl.classList.add('hidden');
        }
    }

    const titleEl = document.getElementById('tm-title');
    if (titleEl) titleEl.innerHTML = renderInlineCode(task.title || '');

    // Context & Description. The section is always present: a task with no
    // context is exactly the one that needs somewhere to type it, and hiding
    // the field left a freshly created task with no way in and no hint the
    // field existed. Empty opens straight into the editor.
    renderTaskDescription(task.justification || '', !(task.justification || '').trim());

    // Expected Results
    const resultsSection = document.getElementById('tm-results-section');
    const resultsList = document.getElementById('tm-results-list');
    if (resultsSection && resultsList) {
        if (task.expected_results && task.expected_results.length > 0) {
            resultsList.innerHTML = task.expected_results.map(r => `<li>${renderInlineCode(r)}</li>`).join('');
            resultsSection.classList.remove('hidden');
        } else {
            resultsSection.classList.add('hidden');
        }
    }

    // Questions & Answers
    renderTaskQuestions(task.questions || []);

    // Spec document
    const specPathEl = document.getElementById('tm-spec-path');
    const specViewerEl = document.getElementById('tm-spec-viewer');
    if (specPathEl) {
        specPathEl.textContent = task.spec_path || 'No spec path registered';
    }

    if (specViewerEl) {
        if (specContent) {
            specViewerEl.innerHTML = formatSpecMarkdown(specContent, currentModalProjPath);
            specViewerEl.classList.remove('empty');
        } else if (task.spec_path) {
            specViewerEl.innerHTML = `<div class="tm-spec-viewer empty">Specification document (${escapeHtml(task.spec_path)}) not found or empty.</div>`;
            specViewerEl.classList.add('empty');
        } else {
            specViewerEl.innerHTML = `<div class="tm-spec-viewer empty">No specification document generated for this task yet.</div>`;
            specViewerEl.classList.add('empty');
        }
    }

    // Interactive Mockup setup
    const mockBadge = document.getElementById('tm-mock-badge');
    const mockIframe = document.getElementById('tm-mock-iframe');
    const mockExternalLink = document.getElementById('tm-mock-external-link');
    const mockEmpty = document.getElementById('tm-mock-empty');
    const mockFrameWrapper = document.getElementById('tm-mock-frame-wrapper');

    const effectiveMockPath = mockPath || task.mock_path;
    const effectiveHasMock = Boolean(hasMock || effectiveMockPath);

    if (mockBadge) {
        if (effectiveHasMock) {
            mockBadge.classList.remove('hidden');
        } else {
            mockBadge.classList.add('hidden');
        }
    }

    if (mockIframe && mockExternalLink && mockEmpty && mockFrameWrapper) {
        if (effectiveHasMock && effectiveMockPath && currentModalProjPath) {
            const mockUrl = `/api/projects/mock?projectPath=${encodeURIComponent(currentModalProjPath)}&mockPath=${encodeURIComponent(effectiveMockPath)}`;
            mockIframe.src = mockUrl;
            mockExternalLink.href = mockUrl;
            mockEmpty.classList.add('hidden');
            mockFrameWrapper.classList.remove('hidden');
        } else {
            mockIframe.src = 'about:blank';
            mockExternalLink.href = '#';
            mockEmpty.classList.remove('hidden');
            mockFrameWrapper.classList.add('hidden');
        }
    }

    // Run tab: the failure badge/reason are derived from status data already
    // in memory, independent of whether the tab's log has been fetched yet.
    updateRunsTabHeader(task, currentModalProjPath);

    // Status action buttons
    const isApproval = task.status === 'spec_approval';
    const isSpecReview = task.status === 'spec_review';

    if (tmRequestChangesBtn && tmApproveSpecBtn) {
        if (isApproval || isSpecReview) {
            tmRequestChangesBtn.classList.remove('hidden');
            tmApproveSpecBtn.classList.remove('hidden');
            if (isApproval) {
                tmRequestChangesBtn.textContent = 'Request AI Revision ↩';
                tmApproveSpecBtn.textContent = 'Approve Spec ✅';
            } else {
                tmRequestChangesBtn.textContent = 'Edit Questions';
                tmApproveSpecBtn.textContent = 'Direct Approve Spec ✅';
            }
        } else {
            tmRequestChangesBtn.classList.add('hidden');
            tmApproveSpecBtn.classList.add('hidden');
        }
    }
}

function renderTaskQuestions(questions) {
    const list = document.getElementById('tm-questions-list');
    const countEl = document.getElementById('tm-questions-count');
    if (countEl) countEl.textContent = questions.length;
    if (!list) return;

    if (!questions || questions.length === 0) {
        list.innerHTML = '<div class="task-question-empty">No questions recorded for this task.</div>';
        return;
    }

    list.innerHTML = questions.map((q, idx) => {
        const qid = q.id || `q-${idx}`;
        const by = q.by || 'IA';
        const isFromOperator = String(by).toLowerCase() === 'operator';
        const hasAnswer = Boolean(q.answer && q.answer.trim());
        const hasUnanswered = !hasAnswer;
        const dateStr = q.created_at ? new Date(q.created_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

        let answerHtml = '';
        if (isFromOperator) {
            if (hasAnswer) {
                answerHtml = `
                    <div class="task-answer-area">
                        <label>AI Answer:</label>
                        <div class="task-ai-answer-box">${escapeHtml(q.answer)}</div>
                    </div>
                `;
            } else {
                answerHtml = `
                    <div class="task-answer-area">
                        <div class="task-pending-ai-notice">⏳ Awaiting AI answer...</div>
                    </div>
                `;
            }
        } else {
            answerHtml = `
                <div class="task-answer-area">
                    <label>Your answer / guidance:</label>
                    <textarea class="task-answer-textarea" data-qid="${escapeHtml(qid)}" placeholder="Type your answer for the AI...">${escapeHtml(q.answer || '')}</textarea>
                </div>
            `;
        }

        return `
            <div class="task-question-card ${hasUnanswered ? 'has-unanswered' : ''}">
                <div class="task-question-meta">
                    <span class="task-question-by">From: ${escapeHtml(by)}</span>
                    <span class="task-question-date">${dateStr}</span>
                </div>
                <div class="task-question-text">${escapeHtml(q.question)}</div>
                ${answerHtml}
            </div>
        `;
    }).join('');
}

function collectQuestionsFromModal() {
    if (!currentModalTask) return [];
    const questions = currentModalTask.questions ? [...currentModalTask.questions] : [];
    const textareas = document.querySelectorAll('#tm-questions-list .task-answer-textarea');
    textareas.forEach((ta, idx) => {
        const qid = ta.dataset.qid;
        const ans = ta.value.trim();
        const existing = questions.find(q => (q.id && q.id === qid) || (!q.id && `q-${idx}` === qid));
        if (existing) {
            existing.answer = ans;
            if (ans && !existing.answered_at) existing.answered_at = new Date().toISOString();
        }
    });
    return questions;
}

window.closeTaskModal = function(updateUrl = true) {
    if (taskModal) taskModal.classList.add('hidden');
    currentModalTask = null;
    currentModalProjPath = null;
    if (updateUrl) {
        try {
            const url = new URL(window.location);
            url.searchParams.delete('task');
            window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
        } catch (e) {}
    }
};

// Event listeners for task modal
const tmEditDescBtn = document.getElementById('tm-edit-desc-btn');
if (tmEditDescBtn) {
    tmEditDescBtn.addEventListener('click', () => {
        renderTaskDescription((currentModalTask && currentModalTask.justification) || '', true);
        const input = document.getElementById('tm-desc-input');
        if (input) input.focus();
    });
}

// Priority is a single discrete value, so it saves on change rather than
// waiting for Save — the same immediacy as dragging a card to a new column.
const tmPrioritySelect = document.getElementById('tm-priority');
if (tmPrioritySelect) {
    tmPrioritySelect.addEventListener('change', async () => {
        if (!currentModalTask || !currentModalProjPath) return;
        const previous = currentModalTask.priority || 'medium';
        const next = tmPrioritySelect.value;
        if (next === previous) return;
        tmPrioritySelect.disabled = true;
        try {
            const res = await fetch(`/api/projects/tasks/${currentModalTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: currentModalProjPath, priority: next })
            });
            if (res.ok) {
                currentModalTask.priority = next;
                tmPrioritySelect.className = `task-priority-badge task-priority-select priority-${next}`;
                showFlashMessage(`Priority set to ${next}`, 'success');
                refreshProjectView();
            } else {
                const errData = await res.json().catch(() => ({}));
                tmPrioritySelect.value = previous;
                showFlashMessage(errData.error || 'Error saving priority', 'error');
            }
        } catch (err) {
            tmPrioritySelect.value = previous;
            showFlashMessage('Network error saving priority', 'error');
        } finally {
            tmPrioritySelect.disabled = false;
        }
    });
}

if (tmSaveAnswersBtn) {
    tmSaveAnswersBtn.addEventListener('click', async () => {
        if (!currentModalTask || !currentModalProjPath) return;
        const updatedQuestions = collectQuestionsFromModal();
        currentModalTask.questions = updatedQuestions;

        // Only send the description when the editor is open: a PUT that always
        // carried it would rewrite the field every time somebody saved an
        // answer, and `justification` is also written by the agents.
        const editingDesc = isEditingDescription();
        const descInput = document.getElementById('tm-desc-input');
        const payload = { projectPath: currentModalProjPath, questions: updatedQuestions };
        if (editingDesc && descInput) payload.justification = descInput.value.trim();

        try {
            tmSaveAnswersBtn.disabled = true;
            tmSaveAnswersBtn.textContent = 'Saving...';
            const res = await fetch(`/api/projects/tasks/${currentModalTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                showFlashMessage('Saved successfully!', 'success');
                renderTaskQuestions(updatedQuestions);
                if (editingDesc) {
                    currentModalTask.justification = payload.justification;
                    renderTaskDescription(payload.justification, false);
                }
                refreshProjectView();
            } else {
                const errData = await res.json().catch(() => ({}));
                showFlashMessage(errData.error || 'Error saving task', 'error');
            }
        } catch (err) {
            showFlashMessage('Network error saving task', 'error');
        } finally {
            tmSaveAnswersBtn.disabled = false;
            tmSaveAnswersBtn.textContent = 'Save';
        }
    });
}

function closeRevisionModal() {
    if (revisionModal) revisionModal.classList.add('hidden');
    if (tmRevisionFeedbackInput) tmRevisionFeedbackInput.value = '';
}

if (closeRevisionModalBtn) closeRevisionModalBtn.addEventListener('click', closeRevisionModal);
if (cancelRevisionModalBtn) cancelRevisionModalBtn.addEventListener('click', closeRevisionModal);

if (tmRequestChangesBtn) {
    tmRequestChangesBtn.addEventListener('click', () => {
        if (!currentModalTask || !currentModalProjPath) return;
        if (tmRevisionFeedbackInput) tmRevisionFeedbackInput.value = '';
        if (revisionModal) revisionModal.classList.remove('hidden');
        if (tmRevisionFeedbackInput) tmRevisionFeedbackInput.focus();
    });
}

if (confirmRevisionBtn) {
    confirmRevisionBtn.addEventListener('click', async () => {
        if (!currentModalTask || !currentModalProjPath) return;
        const updatedQuestions = collectQuestionsFromModal();
        const feedbackText = tmRevisionFeedbackInput ? tmRevisionFeedbackInput.value.trim() : '';

        if (feedbackText) {
            // `question` is always what the author wrote and `answer` is always
            // the other side's reply. A revision request is the operator
            // writing, so it is the question, and the AI's reply fills the
            // answer later. Putting the feedback in `answer` labelled the
            // operator's own words "AI Answer:" and left `question` showing a
            // constant string.
            updatedQuestions.push({
                id: 'rev-' + Date.now(),
                question: feedbackText,
                answer: '',
                by: 'Operator',
                created_at: new Date().toISOString()
            });
        }
        currentModalTask.questions = updatedQuestions;

        try {
            confirmRevisionBtn.disabled = true;
            confirmRevisionBtn.textContent = 'Sending...';
            const payload = {
                projectPath: currentModalProjPath,
                status: 'spec_review',
                questions: updatedQuestions
            };
            if (feedbackText) {
                payload.operator_feedback = feedbackText;
                payload.resume_context = `Operator revision requested: ${feedbackText}`;
            }
            const res = await fetch(`/api/projects/tasks/${currentModalTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                showFlashMessage('Sent for AI revision!', 'success');
                closeRevisionModal();
                closeTaskModal();
                refreshProjectView();
            } else {
                const errData = await res.json().catch(() => ({}));
                showFlashMessage(errData.error || 'Error updating task', 'error');
            }
        } catch (err) {
            showFlashMessage('Network error updating task status', 'error');
        } finally {
            confirmRevisionBtn.disabled = false;
            confirmRevisionBtn.textContent = 'Send to AI ↩';
        }
    });
}

if (tmApproveSpecBtn) {
    tmApproveSpecBtn.addEventListener('click', async () => {
        if (!currentModalTask || !currentModalProjPath) return;
        const updatedQuestions = collectQuestionsFromModal();
        currentModalTask.questions = updatedQuestions;
        try {
            tmApproveSpecBtn.disabled = true;
            const res = await fetch(`/api/projects/tasks/${currentModalTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: currentModalProjPath,
                    status: 'ready_todo',
                    questions: updatedQuestions
                })
            });
            if (res.ok) {
                showFlashMessage('Spec approved! Ready to Do 🚀', 'success');
                closeTaskModal();
                refreshProjectView();
            } else {
                const errData = await res.json().catch(() => ({}));
                showFlashMessage(errData.error || 'Error approving spec', 'error');
            }
        } catch (err) {
            showFlashMessage('Network error approving spec', 'error');
        } finally {
            tmApproveSpecBtn.disabled = false;
        }
    });
}

if (tmAskAiBtn) {
    tmAskAiBtn.addEventListener('click', () => {
        if (tmAskAiBox) {
            tmAskAiBox.classList.toggle('hidden');
            if (!tmAskAiBox.classList.contains('hidden') && tmAskAiInput) {
                tmAskAiInput.focus();
            }
        }
    });
}

if (tmCancelAskAiBtn) {
    tmCancelAskAiBtn.addEventListener('click', () => {
        if (tmAskAiBox) tmAskAiBox.classList.add('hidden');
        if (tmAskAiInput) tmAskAiInput.value = '';
    });
}

if (tmSubmitAskAiBtn) {
    tmSubmitAskAiBtn.addEventListener('click', async () => {
        if (!tmAskAiInput) return;
        const text = tmAskAiInput.value.trim();
        if (!text) return;
        if (!currentModalTask || !currentModalProjPath) return;

        const currentQuestions = collectQuestionsFromModal();
        const newQ = {
            id: 'q-' + Date.now(),
            question: text,
            answer: '',
            by: 'Operator',
            created_at: new Date().toISOString()
        };
        currentQuestions.push(newQ);
        currentModalTask.questions = currentQuestions;
        tmAskAiInput.value = '';
        if (tmAskAiBox) tmAskAiBox.classList.add('hidden');
        renderTaskQuestions(currentQuestions);

        try {
            tmSubmitAskAiBtn.disabled = true;
            const res = await fetch(`/api/projects/tasks/${currentModalTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: currentModalProjPath,
                    questions: currentQuestions
                })
            });
            if (res.ok) {
                showFlashMessage('Question submitted for AI!', 'success');
                refreshProjectView();
            } else {
                showFlashMessage('Error saving question', 'error');
            }
        } catch (err) {
            showFlashMessage('Network error saving question', 'error');
        } finally {
            tmSubmitAskAiBtn.disabled = false;
        }
    });
}

if (closeTaskModalBtn) closeTaskModalBtn.addEventListener('click', () => closeTaskModal());
if (closeTaskModalFooterBtn) closeTaskModalFooterBtn.addEventListener('click', () => closeTaskModal());
if (taskModal) {
    taskModal.addEventListener('click', (e) => {
        if (e.target === taskModal) closeTaskModal();
    });
}
// Spec vs Mockup vs Runs tab switching. A run tab is loaded from the server
// the moment it is opened rather than up front — a task might never have its
// runs tab looked at, and the log can be large enough that fetching it
// unconditionally on every modal open would be wasted work.
function switchTaskModalTab(tabName) {
    const tabs = [
        [document.getElementById('tm-tab-spec'), document.getElementById('tm-spec-container'), 'spec'],
        [document.getElementById('tm-tab-mock'), document.getElementById('tm-mock-container'), 'mock'],
        [document.getElementById('tm-tab-runs'), document.getElementById('tm-runs-container'), 'runs']
    ];
    tabs.forEach(([tabBtn, container, name]) => {
        const active = name === tabName;
        if (tabBtn) tabBtn.classList.toggle('tm-tab--active', active);
        if (container) container.classList.toggle('hidden', !active);
    });

    if (tabName === 'runs') {
        loadRunsTab();
    }
}

const tabSpecBtn = document.getElementById('tm-tab-spec');
const tabMockBtn = document.getElementById('tm-tab-mock');
const tabRunsBtn = document.getElementById('tm-tab-runs');
if (tabSpecBtn) tabSpecBtn.addEventListener('click', () => switchTaskModalTab('spec'));
if (tabMockBtn) tabMockBtn.addEventListener('click', () => switchTaskModalTab('mock'));
if (tabRunsBtn) tabRunsBtn.addEventListener('click', () => switchTaskModalTab('runs'));

// Bumped on every fetch so a stale response for a task the operator has since
// navigated away from cannot overwrite the tab with the wrong task's runs.
let runsRequestToken = 0;

// A run log can carry a single field of unbounded size (a long assistant
// message, a huge tool result). Truncating any one field keeps the tab from
// having to lay out an enormous text node, independent of how many events
// the log has in total.
const RUN_LOG_FIELD_LIMIT = 20000;

function truncateRunText(text) {
    if (text.length <= RUN_LOG_FIELD_LIMIT) return text;
    return text.slice(0, RUN_LOG_FIELD_LIMIT) + `\n… [truncated, ${text.length - RUN_LOG_FIELD_LIMIT} more characters]`;
}

// The run log is stream-json from the CLI: one JSON object per line, plus a
// couple of plain-text lines the runner itself writes (the invoked command,
// and a final "[failed] ..." line on failure). Rendering that raw would put
// 100+ nested tool-call/hook objects in front of the operator for a run that
// really has one thing worth reading — the assistant's narration and the
// final report. So each line is reduced to a short, labelled summary instead
// of being pretty-printed in full; hook bookkeeping (`type: "system"`) is
// dropped entirely as noise once the run is over.
function summarizeRunEvent(obj) {
    if (obj.type === 'assistant' || obj.type === 'user') {
        const blocks = (obj.message && obj.message.content) || [];
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (obj.type === 'assistant') {
            if (text) return { cls: 'assistant', label: 'assistant', text };
            const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name || 'tool');
            if (tools.length) return { cls: 'tool-use', label: 'tool call', text: tools.join(', ') };
            return null;
        }
        // user messages in a CLI transcript are tool results being fed back in
        const resultText = blocks
            .filter(b => b.type === 'tool_result')
            .map(b => Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : (b.content || ''))
            .join('\n').trim();
        return resultText ? { cls: 'tool-result', label: 'tool result', text: resultText } : null;
    }
    if (obj.type === 'result') {
        return { cls: 'final', label: 'final report', text: (obj.result || '').trim() || '(no summary text)' };
    }
    return null; // system events, rate_limit_event, etc. — bookkeeping, not narration
}

function renderRunLine(cls, label, text) {
    return `<div class="tm-run-line tm-run-line--${cls}">` +
        `<span class="tm-run-line-label">${escapeHtml(label)}</span>` +
        `<pre class="tm-run-line-text">${escapeHtml(truncateRunText(text))}</pre>` +
        `</div>`;
}

function formatRunLogBody(body) {
    const parts = [];
    // Consecutive non-JSON lines (the shell command header, or a multi-line
    // "[failed] ..." footer the runner writes itself) are one unit of plain
    // text to the operator, not one fragment per line — so they are
    // accumulated and flushed together rather than each getting its own box.
    let rawBuffer = [];
    const flushRaw = () => {
        if (rawBuffer.length) {
            parts.push(renderRunLine('raw', 'log', rawBuffer.join('\n')));
            rawBuffer = [];
        }
    };
    for (const raw of String(body || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line); } catch (e) { /* not a JSON line */ }
        if (obj && typeof obj === 'object') {
            const event = summarizeRunEvent(obj);
            if (!event) continue;
            flushRaw();
            parts.push(renderRunLine(event.cls, event.label, event.text));
        } else {
            rawBuffer.push(line);
        }
    }
    flushRaw();
    return parts.length ? parts.join('') : renderRunLine('raw', 'log', '(empty log)');
}

function renderRunEntry(run, idx) {
    return `<details class="tm-run-entry"${idx === 0 ? ' open' : ''}>` +
        `<summary class="tm-run-entry-summary">${escapeHtml(run.name)}</summary>` +
        `<div class="tm-run-entry-body">${formatRunLogBody(run.body)}</div>` +
        `</details>`;
}

// The failure reason comes from /api/status's per-project lastRun (already
// in memory as currentProjectsData), not from the runs endpoint — it must
// show up the instant the tab opens, and it must keep showing until this
// task's *own* next run, which is exactly what matching lastRun.taskId does.
function updateRunsTabHeader(task, projPath) {
    const badge = document.getElementById('tm-runs-badge');
    const reasonEl = document.getElementById('tm-runs-reason');
    if (!badge || !reasonEl || !task) return;

    const proj = currentProjectsData.find(p => p.path === projPath);
    const lastRun = proj && proj.lastRun;
    const failed = Boolean(lastRun && lastRun.taskId === task.id && lastRun.ok === false);

    badge.classList.toggle('hidden', !failed);
    if (failed) {
        reasonEl.textContent = lastRun.reason || 'The last run for this task failed.';
        reasonEl.classList.remove('hidden');
    } else {
        reasonEl.textContent = '';
        reasonEl.classList.add('hidden');
    }
}

async function loadRunsTab() {
    const listEl = document.getElementById('tm-runs-list');
    const loadingEl = document.getElementById('tm-runs-loading');
    const emptyEl = document.getElementById('tm-runs-empty');
    if (!listEl || !loadingEl || !emptyEl || !currentModalTask || !currentModalProjPath) return;

    const token = ++runsRequestToken;
    listEl.innerHTML = '';
    emptyEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    try {
        const url = `/api/projects/runs/${encodeURIComponent(currentModalTask.id)}?project=${encodeURIComponent(currentModalProjPath)}`;
        const res = await fetch(url);
        if (token !== runsRequestToken) return; // operator moved on to another task
        if (!res.ok) {
            emptyEl.textContent = 'Could not load runs for this task.';
            emptyEl.classList.remove('hidden');
            return;
        }
        const data = await res.json();
        if (token !== runsRequestToken) return;
        const runs = data.runs || [];
        if (runs.length === 0) {
            emptyEl.textContent = 'No runs recorded for this task yet.';
            emptyEl.classList.remove('hidden');
            return;
        }
        listEl.innerHTML = runs.map((run, idx) => renderRunEntry(run, idx)).join('');
    } catch (err) {
        if (token !== runsRequestToken) return;
        emptyEl.textContent = 'Network error loading runs.';
        emptyEl.classList.remove('hidden');
    } finally {
        if (token === runsRequestToken) loadingEl.classList.add('hidden');
    }
}

// Viewport controls for Mockup viewer
document.querySelectorAll('.tm-viewport-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tm-viewport-btn').forEach(b => b.classList.remove('tm-viewport-btn--active'));
        btn.classList.add('tm-viewport-btn--active');
        const viewport = btn.dataset.viewport;
        const wrapper = document.getElementById('tm-mock-frame-wrapper');
        if (wrapper) {
            wrapper.className = `tm-mock-frame-wrapper viewport-${viewport}`;
        }
    });
});

// Mockup Reload Button
const mockReloadBtn = document.getElementById('tm-mock-reload-btn');
if (mockReloadBtn) {
    mockReloadBtn.addEventListener('click', () => {
        const iframe = document.getElementById('tm-mock-iframe');
        if (iframe && iframe.src && iframe.src !== 'about:blank') {
            iframe.src = iframe.src;
        }
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (revisionModal && !revisionModal.classList.contains('hidden')) {
            revisionModal.classList.add('hidden');
            return;
        }
        if (taskModal && !taskModal.classList.contains('hidden')) {
            closeTaskModal();
            return;
        }
        if (cardSearchQuery) {
            cardSearchQuery = '';
            const searchInput = document.getElementById('card-search-input');
            if (searchInput) {
                searchInput.value = '';
                searchInput.blur();
            }
            renderKanbanBoard(currentKanbanTasks);
            return;
        }
    }
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
        const projectView = document.getElementById('project-view');
        const searchInput = document.getElementById('card-search-input');
        if (projectView && !projectView.classList.contains('hidden') && searchInput) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    }
});



/* =========================================
   Fix All Logic
   ========================================= */

window.isFixAllMode = false;
window.isFixAllRunning = false;
window.fixAllQueue = [];

const fixAllBtn = document.getElementById('fix-all-btn');
if (fixAllBtn) {
    fixAllBtn.addEventListener('click', () => {
        const projectsWithIssues = currentProjectsData.filter(p => p.missingAgentsMd || p.missingMeridianRules || p.outdatedMeridianRules || p.missingStack || p.missingDescription);
        if (projectsWithIssues.length === 0) return;
        
        window.isFixAllMode = true;
        window.fixAllOriginalQueue = projectsWithIssues;
        
        fixModal.classList.remove('hidden');
        document.getElementById('fix-modal-title').textContent = 'Fixing All Projects';
        
        const checkboxesContainer = document.getElementById('fix-checkboxes-container');
        if (checkboxesContainer) checkboxesContainer.classList.remove('hidden');
        
        let html = '<div style="max-height: 250px; overflow-y: auto; padding-right: 0.5rem;">';
        projectsWithIssues.forEach((proj, idx) => {
            html += `<div style="margin-bottom: 1rem;">
                <div style="font-weight: 600; margin-bottom: 0.5rem; color: #fff;">${proj.name}</div>
                <div style="display: flex; flex-direction: column; gap: 0.4rem; padding-left: 0.5rem; border-left: 2px solid var(--border);">`;
            
            if (proj.missingAgentsMd) {
                html += `<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem;">
                    <input type="checkbox" name="fixes_${idx}" value="agents" checked> Generate AGENTS.md
                </label>`;
            }
            if (!proj.missingAgentsMd && (proj.missingMeridianRules || proj.outdatedMeridianRules)) {
                const labelText = proj.outdatedMeridianRules ? "Update Meridian Rules" : "Inject Meridian Rules";
                html += `<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem;">
                    <input type="checkbox" name="fixes_${idx}" value="meridian-rules" checked> ${labelText}
                </label>`;
            }
            if (proj.missingStack) {
                html += `<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem;">
                    <input type="checkbox" name="fixes_${idx}" value="stack" checked> Auto-generate Stack
                </label>`;
            }
            if (proj.missingDescription) {
                html += `<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem;">
                    <input type="checkbox" name="fixes_${idx}" value="description" checked> Auto-generate Description
                </label>`;
            }
            html += '</div></div>';
        });
        html += '</div>';
        
        checkboxesContainer.innerHTML = html;
        const fixToolEl = document.getElementById('fix-tool');
        if (fixToolEl && fixToolEl.parentElement) fixToolEl.parentElement.classList.remove('hidden');
        
        const term = document.getElementById('fix-terminal-log');
        term.classList.add('hidden');
        term.textContent = '';
        
        fixSubmitBtn.classList.remove('hidden');
        fixSubmitBtn.disabled = false;
        fixSubmitBtn.textContent = 'Fix Selected in All 🪄';
        
        const cancelBtn = document.querySelector('.close-fix-modal-btn');
        if (cancelBtn) cancelBtn.textContent = 'Cancel';
        
        fixProgressContainer.classList.add('hidden');
    });
}

window.runNextFixAll = function() {
    if (window.fixAllQueue.length === 0) {
        document.getElementById('fix-progress-text').textContent = 'All projects fixed!';
        document.getElementById('fix-progress-bar').style.width = '100%';
        document.getElementById('fix-progress-bar').style.background = '#10b981';
        const term = document.getElementById('fix-terminal-log');
        term.textContent += '\n\n✅ Fix All Completed!';
        window.isFixAllRunning = false;
        
        const fixSubmitBtn = document.getElementById('fix-submit-btn');
        if (fixSubmitBtn) fixSubmitBtn.classList.add('hidden');
        const fixDoneBtn = document.getElementById('fix-done-btn');
        if (fixDoneBtn) fixDoneBtn.classList.remove('hidden');
        const cancelBtn = document.querySelector('.close-fix-modal-btn');
        if (cancelBtn) cancelBtn.classList.add('hidden');
        return;
    }
    
    const proj = window.fixAllQueue.shift();
    const term = document.getElementById('fix-terminal-log');
    term.textContent += `\n\n=== Fixing Project: ${proj.name} ===\n`;
    term.scrollTop = term.scrollHeight;
    
    const fixes = proj.fixes;
    
    document.getElementById('fix-proj-path').value = proj.path;
    document.getElementById('fix-progress-text').textContent = `Fixing ${proj.name}...`;
    document.getElementById('fix-progress-bar').style.width = '0%';
    document.getElementById('fix-progress-bar').style.background = 'var(--accent)';
    
    const tool = window.fixAllTool || 'agy';
    
    fetch('/api/fix-with-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: proj.path, tool: tool, fixes })
    }).catch(err => {
        term.textContent += `\nError starting fix for ${proj.name}: ${err.message}\n`;
        setTimeout(window.runNextFixAll, 1000);
    });
};

// --- Stats tab -------------------------------------------------------------
// Fetches /api/stats fresh on every open of the Stats tab and on every click
// of its Refresh button. lastStatsData is only ever assigned inside
// loadStats() from a just-fetched response — sorting only re-renders what the
// most recent fetch returned, it never substitutes for a fresh fetch.
const tabBoardBtn = document.getElementById('tab-board-btn');
const tabStatsBtn = document.getElementById('tab-stats-btn');
const boardPanel = document.getElementById('board-panel');
const statsPanel = document.getElementById('stats-panel');

function showBoardTab() {
    if (!tabBoardBtn || !tabStatsBtn || !boardPanel || !statsPanel) return;
    tabBoardBtn.classList.add('view-tab--active');
    tabStatsBtn.classList.remove('view-tab--active');
    boardPanel.classList.remove('hidden');
    statsPanel.classList.add('hidden');
}

function showStatsTab() {
    if (!tabBoardBtn || !tabStatsBtn || !boardPanel || !statsPanel) return;
    tabBoardBtn.classList.remove('view-tab--active');
    tabStatsBtn.classList.add('view-tab--active');
    boardPanel.classList.add('hidden');
    statsPanel.classList.remove('hidden');
    loadStats();
}

if (tabBoardBtn) tabBoardBtn.addEventListener('click', showBoardTab);
if (tabStatsBtn) tabStatsBtn.addEventListener('click', showStatsTab);

const statsRefreshBtn = document.getElementById('stats-refresh-btn');
if (statsRefreshBtn) statsRefreshBtn.addEventListener('click', loadStats);

// Client-side sort state for the already-fetched rows only — never a
// substitute for re-fetching. Every open of the Stats tab and every click of
// Refresh calls loadStats(), which replaces lastStatsData wholesale; sorting
// only ever re-renders what the most recent fetch returned.
let lastStatsData = null;
let statsSort = { key: 'ms', dir: 'desc' };

async function loadStats() {
    if (!currentProjectViewPath) return;
    const isGlobal = currentProjectViewPath === '__GLOBAL__';
    const url = isGlobal ? '/api/stats' : `/api/stats?project=${encodeURIComponent(currentProjectViewPath)}`;
    const loading = document.getElementById('stats-loading');
    const errorBox = document.getElementById('stats-error');
    const content = document.getElementById('stats-content');
    loading.classList.remove('hidden');
    errorBox.classList.add('hidden');
    content.classList.add('hidden');
    lastStatsData = null;
    try {
        const res = await fetch(url);
        const data = await res.json();
        loading.classList.add('hidden');
        if (data.errors && data.errors.length > 0) {
            errorBox.textContent = data.errors.map(e => e.message).join('; ');
            errorBox.classList.remove('hidden');
            // Errors here are per-project read failures folded into the
            // response, not a hard failure — data.tasks/stages can still be
            // non-empty. Fall through and render whatever came back, same
            // as the single-project path already treats them as
            // non-fatal-but-shown.
        }
        lastStatsData = data;
        content.classList.remove('hidden');
        renderStatsPanel(data);
    } catch (err) {
        loading.classList.add('hidden');
        errorBox.textContent = 'Failed to load stats: ' + err.message;
        errorBox.classList.remove('hidden');
    }
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
}

// A duration-bearing cell (stage avgMs/maxMs, or a per-task "time in stage")
// renders the neutral placeholder instead of calling formatDuration when the
// value is absent — an untimed stage never
// carries a duration at all, and "undefined ms" must not be mistaken for
// "0m". Detected from the data itself (an absent/non-finite value), never
// from a hardcoded stage-name list — the frontend has no access to the
// backend's UNTIMED_STATUSES constant.
function formatDurationCell(ms) {
    if (!Number.isFinite(ms)) {
        return '<span class="stats-agent-placeholder">—</span>';
    }
    return formatDuration(ms);
}

// Agent names come from event data (posted via POST /api/projects/events)
// and are untrusted — escape before interpolating into innerHTML, both in
// the visible cell text and in the title attribute.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Inline `code` spans for task text. lib/inline-markdown.js is the source of
// truth and carries the reasoning — change both. Deliberately not `marked`:
// over raw text it would render HTML the task contains, and over escaped text
// it would escape a span's contents twice, printing `Array<T>` as the literal
// `Array&lt;T&gt;`.
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

// Every agent this codebase dispatches through the plugin is named
// "meridian:<role>" — the prefix is redundant once it's the only kind of
// name shown in this table, so it's stripped for display only (the raw
// value from the API is untouched).
function formatAgentName(agent) {
    if (!agent) return '(no agent)';
    return agent.startsWith('meridian:') ? agent.slice('meridian:'.length) : agent;
}

// `agents` is stages.<name>.agents from the API: already sorted by
// totalOutputTokens desc, one entry per distinct agent (a `null` agent
// groups dispatch_tokens events that carried no `agent` field). An empty
// array means the stage had zero dispatch_tokens attributed to it at all —
// that, and only that, is the placeholder case; a stage whose one and only
// contributor is the `null`/no-agent group still renders "(no agent)", not
// the placeholder. More than one agent renders the dominant one plus a
// compact "+N" suffix, with a title attribute listing every agent's token
// total for the full picture on hover.
function formatStageAgentCell(agents) {
    if (!agents || agents.length === 0) {
        return '<span class="stats-agent-placeholder">—</span>';
    }
    const label = escapeHtml(formatAgentName(agents[0].agent));
    const suffix = agents.length > 1 ? ` (+${agents.length - 1})` : '';
    const title = agents
        .map(a => `${formatAgentName(a.agent)}: ${Math.round(a.totalOutputTokens).toLocaleString()} tokens`)
        .join('\n');
    return `<span class="stats-agent-cell" title="${escapeHtml(title)}">${label}${suffix}</span>`;
}

function renderStatsPanel(data) {
    const stageTbody = document.getElementById('stats-stage-tbody');
    const stageNames = Object.keys(data.stages).sort();
    stageTbody.innerHTML = stageNames.map(name => {
        const s = data.stages[name];
        return `<tr>
            <td>${name}</td>
            <td>${formatStageAgentCell(s.agents)}</td>
            <td>${formatDurationCell(s.avgMs)}</td>
            <td>${formatDurationCell(s.maxMs)}</td>
            <td>${Math.round(s.avgTokens).toLocaleString()}</td>
            <td>${Math.round(s.maxTokens).toLocaleString()}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6">No stage data yet.</td></tr>';

    const showProject = currentProjectViewPath === '__GLOBAL__';
    const taskTable = document.getElementById('stats-task-table');
    taskTable.classList.toggle('stats-table--project-hidden', !showProject);

    // Flatten tasks x stages into one row per (task, stage) so outliers sort
    // to the top regardless of which task or stage they belong to.
    let rows = [];
    for (const [key, t] of Object.entries(data.tasks)) {
        // Workspace entries carry `task` + `project`; single-project
        // entries are keyed by the bare task id and carry neither.
        const taskId = t.task || key;
        const projectLabel = t.project ? (t.project.name || t.project.path) : '';
        const stageNamesForTask = Object.keys(t.stages);
        const base = {
            task: taskId, project: projectLabel,
            dispatches: t.dispatches.count,
            outputTokens: t.dispatches.totalOutputTokens,
            maxContextTokens: t.dispatches.maxContextTokens
        };
        if (stageNamesForTask.length === 0) {
            rows.push({ ...base, stage: '(no status events)', ms: 0, ongoing: false });
            continue;
        }
        for (const stageName of stageNamesForTask) {
            const s = t.stages[stageName];
            rows.push({ ...base, stage: stageName, ms: s.totalMs, ongoing: s.ongoing });
        }
    }

    const { key: sortKey, dir } = statsSort;
    rows.sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        // An absent `ms` (untimed stage, per MERID-11) sorts as the lowest
        // value rather than producing NaN from `undefined - undefined`.
        const cmp = typeof va === 'string'
            ? va.localeCompare(vb)
            : (va ?? -Infinity) - (vb ?? -Infinity);
        return dir === 'asc' ? cmp : -cmp;
    });

    const taskTbody = document.getElementById('stats-task-tbody');
    taskTbody.innerHTML = rows.map(r => `<tr>
        <td>${r.task}</td>
        <td class="stats-col-project">${r.project}</td>
        <td>${r.stage}${r.ongoing ? ' <span class="stats-ongoing-badge">ongoing</span>' : ''}</td>
        <td>${formatDurationCell(r.ms)}</td>
        <td>${r.dispatches}</td>
        <td>${r.outputTokens.toLocaleString()}</td>
        <td>${r.maxContextTokens.toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="7">No task data yet.</td></tr>';
}

document.querySelectorAll('#stats-task-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (statsSort.key === key) {
            statsSort.dir = statsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            statsSort = { key, dir: 'desc' };
        }
        if (lastStatsData) renderStatsPanel(lastStatsData);
    });
});
