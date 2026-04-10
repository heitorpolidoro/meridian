# Task Breakdown: Meridian Project Orchestrator (Core)

**Track:** `01-orchestrator-core`
**Status:** `Draft`
**Date:** April 7, 2026

## Module 1: Agent & Track Lifecycle (ARB/TLM)

### [Task 1.1] Core Service Abstractions & Mocking Strategy
- **Description:** Implement interfaces for Filesystem and Shell interactions to decouple core logic from the environment.
- **Link:** Spec §6 (Service Abstraction), Plan §1.3.
- **DoD:**
  - Interfaces defined for all I/O operations.
  - Mock implementations created for unit testing.
  - 100% test coverage for the abstraction layer.
- **Estimated Effort:** 2 days.

### [Task 1.2] Agent Registry Implementation (ARB)
- **Description:** Implement the CRUD logic for the Agent Registry (`.meridian/agents.json`) with strict schema validation.
- **Link:** Plan §2.1 (Agent Metadata).
- **DoD:**
  - Zod schema validation for agent registry.
  - CRUD operations implemented and tested.
  - File persistence verified on local filesystem.
- **Estimated Effort:** 1 day.

### [Task 1.3] Track Metadata Service (TLM)
- **Description:** Implement a service to manage the lifecycle of tracks (Active, Completed, Archived) within `.meridian/tracks/`.
- **Link:** Spec §4 (Context Management), Plan §1.2.
- **DoD:**
  - Track state transitions (Create -> Active -> Completed) functional.
  - Automated tests verify directory structure creation.
- **Estimated Effort:** 2 days.

### [Task 1.4] Session Manager Core
- **Description:** Implement the in-memory session manager to track active agent assignments to specific tasks and tracks.
- **Link:** Plan §7.1 (Session Management).
- **DoD:**
  - Session state accurately reflects active tasks.
  - 100% branch coverage for session logic.
- **Estimated Effort:** 2 days.

---

## Module 2: Intelligence & Context Injection (CIE)

### [Task 2.1] Bootstrapping Engine (Stub to Core)
- **Description:** Implement the logic to resolve an agent's full set of instructions by traversing Stub -> Role -> Core definitions.
- **Link:** Plan §1.1 (Agent Bootstrapping).
- **DoD:**
  - Full instruction resolution verified for Architect, Engineer, and PM personas.
  - Integration tests confirm shared standards are correctly inherited.
- **Estimated Effort:** 3 days.

### [Task 2.2] Task-Level Context Injector
- **Description:** Implement the logic to dynamically select and inject only the relevant files/metadata for a specific track into the agent's prompt.
- **Link:** Spec §4 (Context Management), Plan §1.2.
- **DoD:**
  - Context injection logic prioritizes "Minimum Viable Context".
  - Verified via unit tests that only track-specific files are included.
- **Estimated Effort:** 2 days.

### [Task 2.3] Secret Prevention & Isolation Enforcement
- **Description:** Implement strict exclusion of `.env` files and sensitive patterns from the injected context using a KISS approach.
- **Link:** Plan §3.1 (Secret Prevention).
- **DoD:**
  - Automated tests confirm that `.env` files are never injected into the context.
  - `.gitignore` patterns are respected by the injector.
- **Estimated Effort:** 1 day.

### [Task 2.4] Context Isolation Verification (Negative Testing)
- **Description:** Develop a suite of "Negative Tests" that explicitly attempt to leak context from one track into another.
- **Link:** Spec §6 (Negative Testing), Plan §7.2.
- **DoD:**
  - Test suite attempts to access Track B files from a Track A session.
  - All breach attempts are successfully blocked and logged.
- **Estimated Effort:** 2 days.

---

## Module 3: Governance UI & SRE Telemetry (UI/SRE)

### [Task 3.1] Telemetry Collector Service
- **Description:** Implement the internal service to collect latency (p50/p95), token consumption, and error rates.
- **Link:** Plan §4.1 (AI Reliability Metrics).
- **DoD:**
  - Metrics collected for simulated agent interactions.
  - Unit tests verify accurate p95 calculation.
- **Estimated Effort:** 2 days.

### [Task 3.2] Filesystem Watcher & State Sync
- **Description:** Implement a watcher service to detect manual changes in `.meridian/` and sync them with the in-memory state.
- **Link:** Plan §4.2 (Watcher Service).
- **DoD:**
  - Real-time detection of manual file edits (< 1s latency).
  - Conflict resolution alerts functional.
- **Estimated Effort:** 2 days.

### [Task 3.3] SDS Compliance Scorer
- **Description:** Implement the logic to calculate SDS compliance scores based on the presence and validity of `spec.md`, `plan.md`, and `qa_signoff.md`.
- **Link:** Plan §4.3 (SDS Visibility).
- **DoD:**
  - Compliance score accurately calculated for various mock project states.
- **Estimated Effort:** 1 day.

### [Task 3.4] Backend-to-Frontend Bridge (Schema Validated)
- **Description:** Implement the IPC layer between the Orchestrator Server and the React UI with Zod-validated messaging.
- **Link:** Plan §3.3 (IPC Security).
- **DoD:**
  - All IPC messages validated against Zod schemas.
  - End-to-end communication verified between backend and mock UI.
- **Estimated Effort:** 2 days.

### [Task 3.5] Telemetry Dashboard (UI)
- **Description:** Build the React-based dashboard to visualize telemetry metrics and SDS compliance scores.
- **Link:** Plan §7.3 (Telemetry Dashboard).
- **DoD:**
  - Functional dashboard showing real-time metrics.
  - Visual indicators for SDS compliance and track health.
- **Estimated Effort:** 3 days.
