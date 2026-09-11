const KANBAN_STATUSES = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'spec_review', label: 'Spec Review' },
    { id: 'ready_todo', label: 'Ready to Do' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'code_review', label: 'Code Review' },
    { id: 'qa_review', label: 'QA / Review' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'done', label: 'Done' },
    { id: 'nope', label: 'Nope' }
];

const STATUS_PRIORITY = {
    'blocked': 7,
    'pending': 7,
    'qa_review': 6,
    'code_review': 5,
    'in_progress': 4,
    'ready_todo': 3,
    'todo': 3,
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
    'backlog', 'spec_review', 'ready_todo', 'in_progress',
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

// Rails the operator expanded this session. Not persisted: a reload collapses
// every empty column again.
const expandedRails = new Set();

// Mirrors lib/routes.js#resolveRoute — that file is the source of truth.
const GLOBAL_SLUGS = ['tickets', 'all-tickets', 'global'];

function resolveRoute(pathname, projects) {
    let slug = String(pathname || '').replace(/^\/+|\/+$/g, '');
    try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
    if (!slug) return { view: 'dashboard' };

    const lower = slug.toLowerCase();
    if (GLOBAL_SLUGS.includes(lower)) return { view: 'global' };

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
        case 'project':
            showProjectView(route.path, false);
            break;
        default:
            // Nothing lives here: say so, and do not leave a dead URL in the bar.
            showDashboard(false);
            showFlashMessage(`No project at /${route.slug}`, 'error');
            history.replaceState(null, '', '/');
    }
}

// Swaps the visible view. The first call removes the cold-load placeholder;
// nothing is shown before the first SSE message has picked a route, so a deep
// link never flashes the dashboard. The leaving view hides at once; the
// entering one replays the view-enter animation.
function activateView(name) {
    if (viewLoading) viewLoading.remove();
    const entering = name === 'dashboard' ? dashboardView : projectView;
    const leaving = name === 'dashboard' ? projectView : dashboardView;
    leaving.classList.add('hidden');
    leaving.classList.remove('view--active');
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
    activateView('dashboard');
    setBreadcrumb(null);
    document.title = 'Meridian Dashboard';
    if (pushState && window.location.pathname !== '/') {
        history.pushState(null, '', '/');
    }
}

window.showProjectView = function(projPath, pushState = true, initialTab = 'board') {
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

function refreshProjectView() {
    if (!currentProjectViewPath) return;

    if (currentProjectViewPath === '__GLOBAL__') {
        document.getElementById('pv-title').textContent = 'Global Tickets View 🌐';
        document.getElementById('pv-desc').textContent = 'Aggregated Kanban view of tasks across all monitored workspace projects.';
        document.getElementById('pv-stack').innerHTML = `<span class="stack-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.4);">All ${currentProjectsData.length} Projects</span>`;
        
        btnEdit.classList.add('hidden');
        addTaskForm.classList.add('hidden');

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
        return `
            <div class="running-ticket-card" title="${task.title}">
                <div class="running-ticket-id">${task.id || ''}</div>
                <div class="running-ticket-title">${task.title}</div>
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
    const uid = `j-${task.id}`.replace(/[^a-zA-Z0-9\-]/g, '_');
    const runningClass = task.running ? ' task-card--running' : '';
    const runningBadge = task.running ? '<span class="running-inline-dot" title="Agent is working on this task"></span>' : '';
    const parentBadgeLabel = parentBadge(task);
    const progress = subtaskProgress(allTasks, task);
    const parentBadgeHtml = parentBadgeLabel !== null
        ? `<span class="task-parent-badge" title="Parent task ${task.parent}">${parentBadgeLabel}</span>` : '';
    const progressChipHtml = progress !== null
        ? `<span class="task-progress-chip" title="Sub-tasks done">${progress.done}/${progress.total}</span>` : '';
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
    return `
        <div class="task-card${runningClass}">
            <div class="task-title">${runningBadge}${projectBadge}${parentBadgeHtml}${progressChipHtml}<span class="task-id-code">${taskIdDisplay}</span>${task.title}</div>
            ${task.justification ? `
            <div class="task-justification-toggle" onclick="toggleJustification('${uid}', this)" title="Show/hide details">
                <span class="toggle-arrow">▶</span> <em>details</em>
            </div>
            <div class="task-justification" id="${uid}">${task.justification}</div>
            ` : ''}
            ${(() => {
                const move = manualTransition(task.status);
                if (!move) return '';
                return `
            <div class="task-actions">
                <button class="task-move-btn task-move-${move.to}" onclick="changeTaskStatus('${task.id}', '${move.to}', '${projPathAttr}')" title="Move this task to ${move.to}">${move.label}</button>
            </div>`;
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
        openDetails: new Set(),
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
    board.querySelectorAll('.task-justification.visible').forEach(el => {
        if (el.id) state.openDetails.add(el.id);
    });
    return state;
}

// Restores what captureBoardState took. Anything that no longer exists (a task
// that moved column, a column now collapsed) is skipped, never thrown on.
// Hidden groups are revealed before scroll offsets are set, since revealing
// changes the column's scrollHeight.
function restoreBoardState(board, state) {
    if (!state) return;
    state.openDetails.forEach(uid => {
        const el = board.querySelector(`#${CSS.escape(uid)}`);
        if (!el) return;
        el.classList.add('visible');
        const toggle = el.previousElementSibling;
        if (toggle && toggle.classList.contains('task-justification-toggle')) toggle.classList.add('open');
    });
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

    renderRunningTickets(tasks);

    // Rails are decided on the total per status — never on the done/nope windowed count.
    const collapsed = collapsedColumns(
        KANBAN_STATUSES.map(s => ({ id: s.id, count: tasks.filter(t => t.status === s.id).length })),
        expandedRails
    );

    const boardState = captureBoardState(board);
    board.innerHTML = '';

    KANBAN_STATUSES.forEach(statusCol => {
        let colTasks = tasks.filter(t => t.status === statusCol.id);
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
                <span class="kanban-column-count">0</span>
            </div>
            `);
            return;
        }

        let visibleTasks = colTasks;
        let hiddenTasks = [];
        if (statusCol.id === 'done') {
            visibleTasks = colTasks.filter(t => isRecentlyCompleted(t, doneWindowDays));
            hiddenTasks = colTasks.filter(t => !isRecentlyCompleted(t, doneWindowDays));
        } else if (statusCol.id === 'nope') {
            visibleTasks = colTasks.filter(t => isRecentlyDismissed(t, doneWindowDays));
            hiddenTasks = colTasks.filter(t => !isRecentlyDismissed(t, doneWindowDays));
        }

        const hiddenChipHtml = hiddenTasks.length > 0 ? `
            <div class="done-hidden-chip" onclick="this.nextElementSibling.classList.remove('hidden'); this.remove();">+${hiddenTasks.length} ${statusCol.id === 'nope' ? 'descartadas' : 'concluídas'}</div>
            <div class="done-hidden-tasks hidden">
                ${hiddenTasks.map(task => renderTaskCardHtml(task, tasks)).join('')}
            </div>
        ` : '';

        // Only an expanded rail is truly empty; a windowed done/nope column
        // with nothing visible still has its chip, never this placeholder.
        const emptyHtml = colTasks.length === 0 ? '<div class="kanban-empty">Empty</div>' : '';

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

window.toggleJustification = function(uid, toggleEl) {
    const content = document.getElementById(uid);
    if (!content) return;
    const isOpen = content.classList.toggle('visible');
    toggleEl.classList.toggle('open', isOpen);
};

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
// value is absent — an untimed stage (backlog/done/nope, per MERID-11) never
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
