# 🗺️ Meridian Project Standards

## 🎯 Project Overview
Meridian is an **Intelligent Project Manager with Multi-Agent Orchestration**. It facilitates a standardized Software Development Life Cycle (SDLC) through automated quality gates, track-based planning, and collaborative agent simulation.

- **Frontend:** React 19 (TypeScript), Vite, Vanilla CSS.
- **Backend:** Node.js (Express), Socket.io for real-time IPC.
- **Data Integrity:** Zod schemas for validation, JSONL for audit logs.
- **Architecture:** Interface-driven Dependency Inversion (Service Pattern).

## 🛠️ Critical Commands
- `npm run dev`: Starts both Vite frontend (5174) and Express backend (3000) concurrently.
- `npm test`: Executes all Vitest suites (unit and integration).
- `npm run build`: Compiles production assets into the `dist/` directory.
- `npm run start`: Launches the production server.
- `bin/meridian-sync`: Synchronizes project standards and agent experts.

## 🏗️ Structure & Navigation
- `src/components/`: Modular React UI components (CSS + TSX + Test).
- `src/services/`: Core business logic organized by domain.
- `src/services/interfaces/`: Abstract definitions for platform services (FS, Shell, etc.).
- `src/services/implementations/`: Platform-specific code (Node, Browser).
- `src/services/gates/`: SDS quality gate implementations for phase validation.
- `conductor/`: Universal registry for project planning and tracks.
- `.meridian/`: Role definitions, project metadata, and track status.

## 📏 Golden Rules
- **Dependency Inversion:** Never instantiate platform logic directly in services; use `interfaces` and inject implementations.
- **SDS First:** No code enters `master` without passing through the SDS lifecycle (Spec -> Plan -> Tasks -> Dev -> QA).
- **Behavioral Isolation:** Unit tests MUST mock all external dependencies (FS, IO) using the `mocks/` layer.
- **Convention over Configuration:** Follow the naming pattern `ServiceName.ts` / `ServiceName.test.ts`.

## 🧪 Quality & Workflow
- **Coverage Mandatory:** 100% Line and Branch coverage target for all services and gates.
- **Semantic Integrity:** Conventional commits (`feat:`, `fix:`, `refactor:`) are required.
- **CI/CD:** Automated verification via GitHub Actions (Vitest), SonarCloud (Security/Reliability), and DeepSource (Coverage).
- **Validation Gates:** Phase transitions are blocked unless all automated quality gates pass.

---
*Initialized: May 2026*

### 🤖 Bot Identity & Agent Simulation (Required)

To maintain a consistent audit trail and simulate that actions (branches, commits, and Pull Requests) are performed by the **Meridian Agent**, you MUST use the automated helper script.

#### Using the meridian-agent Wrapper
The `meridian-agent` script acts as a transparent proxy for `git` and `gh` commands, automatically injecting the agent's identity and authentication token.

**Usage Example:**
```bash
# Any git or gh command can be prefixed with meridian-agent
meridian-agent git checkout -b feature/agent-task
meridian-agent git add src/
meridian-agent git commit -m "feat: simulate agent work"
meridian-agent gh pr create --title "..." --body "..."
```

### 🚀 Auto-Merge
To enable automatic merging for Pull Requests that pass all status checks, run the following command (this is a separate action from the agent simulation):
```bash
gh pr merge --auto --squash --delete-branch
```
