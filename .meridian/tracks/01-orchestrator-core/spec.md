# Specification: Meridian Project Orchestrator (Core)

**Status:** `Active`
**Owner:** PM Agent
**Date:** April 7, 2026

## 1. Problem Statement
Managing multiple complex projects across fragmented contexts leads to high cognitive load and inconsistent adherence to the **Software Development Standard (SDS)**.
- **Cost of Inaction:** Inconsistent SDS adherence results in technical debt, manual review overhead, and potential security vulnerabilities due to mismanaged agent context (Knowledge Leakage). Without a central orchestrator, the "Ghost Project" problem (SDS 7) persists, leading to wasted resources.

## 2. Audience
- **User:** Primary Orchestrator and human decision maker.
- **AI Agent Personas:** Consumers and producers of project metadata (PM, Architect, Engineer, QA).

## 3. Success Criteria (Measurable)
- **Automation:** Zero (0) manual effort required for context preparation (fully automated via the Bootstrapping System).
- **Speed of Sync:** Real-time metadata updates for SDS status changes (state propagation latency < 1s).
- **Visibility:** 100% traceability of agent actions in the logs (every tool call and file modification must be uniquely attributable to a specific agent and task).
- **Accuracy:** Zero (0) unauthorized file modifications outside the explicitly defined task scope (enforced via strict context isolation).
- **Telemetry Readiness:** 100% of the above metrics must be objectively verifiable through the telemetry system (including p95 latency, audit logs, and isolation breach attempts).

## 4. Constraints & Requirements
- **Tech Stack:**
    - **Frontend:** React 19 (TypeScript), Vite, Vanilla CSS (No CSS Frameworks).
    - **Backend:** Node.js (TypeScript), Express, Socket.io for real-time streaming.
    - **Storage:** Local Filesystem only (JSON for metadata, Markdown for docs). No external databases.
- **KISS Principle:** Avoid over-engineering (e.g., no complex state management or heavy libraries unless strictly necessary). Keep the architecture flat and simple.
- **Local First:** All metadata and project data must remain on the local filesystem.
- **Inter-Agent Communication:** Agents must be able to "hand off" tasks based on the SDS lifecycle.
- **Context Management:** Must implement a strict "Task-Level Context Injection" strategy so agents only see what they need for the current task.
- **Practical Security:**
    - **Secret Prevention:** Ensure `.env` and sensitive files are ignored by default.
    - **Minimal Privilege:** Agents only receive context for the specific task at hand.

## 5. Control Center (UI) Requirements
The Control Center is the primary human-in-the-loop interface for managing Meridian tracks and agents.

### Track Navigator
A central hub for navigating project documentation and track states.
- **Sidebar Entry:** 'Tracks' menu item in the main navigation sidebar.
- **Hierarchical View:** Real-time list of all track folders located in `.meridian/tracks/`.
- **File Explorer:** Upon selecting a specific track, the interface must list all Markdown (`.md`) files within that track folder.
- **Integrated Preview:** Selecting a file within the track explorer must render its content in the main view area using the `MarkdownViewer` component.
- **Dynamic Updates:** The navigator must automatically refresh its list when new tracks are initialized or when files are created/deleted within existing tracks (via the Filesystem Watcher).

## 6. Business Value & Lifecycle
- **ROI:** Centralized orchestration reduces the cost of context-switching and ensures 100% auditability of agent-driven changes.
- **Lifecycle & Pivot Triggers:**
    - **Pivot:** If the UI complexity prevents fast iteration (e.g., becomes harder to use than a CLI), pivot to a terminal-first orchestrator.
    - **Termination:** If the orchestrator metadata becomes corrupted or unmaintainable, terminate the track and restore from the last known good SDS state.

## 7. Technical Requirements & Quality
- **100% Coverage Target:** All core logic must achieve 100% branch/statement coverage (SDS 4.1).
- **Service Abstraction:** All filesystem and IDE interactions must be abstracted behind interfaces/services to allow 100% mocking.
- **Context Isolation Verification:** Automated tests must verify that an agent instance only has access to its designated context files.
- **Negative Testing:** Include tests that explicitly attempt to "leak" knowledge between roles and verify they are blocked.

---
*Linked to Product Vision: [Meridian Product Vision](../../product.md)*
