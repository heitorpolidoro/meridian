# Tasks: Automated SDS Orchestration (Track 03)

**Status:** `Draft`
**Owner:** Engineer Agent
**Date:** May 22, 2026

## 1. Core State Machine (HSM Logic)

### T1.1: Update Track Metadata Schema
- **Description:** Update `TrackMetadataSchema` in `src/services/TrackMetadataService.ts` to include the `orchestration` object as defined in the Implementation Plan.
- **DoD:** 
  - `TrackMetadataSchema` includes `orchestration` field with `currentPhase`, `status`, `assignedAgent`, `handoffTimestamp`, and `logs`.
  - Zod schemas for `SDSPhase` and `OrchestrationStatus` are implemented.
  - Existing tests for `TrackMetadataService` pass.
- **Test Coverage:** 100%

### T1.2: Implement HSM Logic for SDS Phases
- **Description:** Create a robust Hierarchical State Machine logic that defines valid transitions between SDS phases (1.1 -> 1.2 -> 2.1 -> 3.1 -> 4.2 -> 5.0) and handling of sub-phases.
- **DoD:**
  - Logic correctly identifies valid and invalid transitions.
  - Supports 'Idle', 'InProgress', 'HandoffReady', and 'Failed' statuses.
  - Unit tests cover all transition paths, including edge cases.
- **Test Coverage:** 100%

### T1.3: Create OrchestrationService
- **Description:** Implement `OrchestrationService` to manage the lifecycle of SDS orchestration across tracks. It should centralize the state machine and coordinate between validation and agent activation.
- **DoD:**
  - Service is registered in the DI/Service container.
  - Provides methods to query current phase, request transition, and record logs.
  - Maintains state consistency for multiple tracks.
- **Test Coverage:** 100%

### T1.4: Implement Orchestration Audit Logging
- **Description:** Implement the logic to write detailed handoff events to `orchestration.log` (JSONL format) within the track's directory.
- **DoD:**
  - Logs are appended to `.meridian/tracks/<track_id>/orchestration.log` on every phase transition or status change.
  - Log entries include timestamp, source phase, target phase, trigger type (Auto/Manual/Override), and agent attribution.
  - Handles concurrent writes or file access errors gracefully.
- **Test Coverage:** 100%

---

## 2. Validation Engine (Quality Gates)

### T2.1: Implement Modular ValidationEngine Core
- **Description:** Create a `ValidationEngine` service that runs a registry of "Quality Gates" for a given track and phase.
- **DoD:**
  - Support for registering and executing validation rules based on the current SDS phase.
  - Returns a detailed report of which gates passed and which failed.
  - Integrated into `OrchestrationService`.
- **Test Coverage:** 100%

### T2.2: Implement "Spec Gate" (Phase 1.1)
- **Description:** Implement validation logic for `spec.md` to ensure it contains mandatory sections: "Problem Statement", "Audience", and "Success Criteria".
- **DoD:**
  - Correctly parses `spec.md` using Markdown AST or regex.
  - Fails if sections are missing or empty.
- **Test Coverage:** 100%

### T2.3: Implement "Plan Gate" (Phase 1.2)
- **Description:** Implement validation logic for `plan.md` to ensure it references a Spec and contains "Proposed Architecture" and "Requirements Mapping".
- **DoD:**
  - Correctly parses `plan.md`.
  - Verifies the link/reference to `spec.md`.
  - Fails if mandatory sections are missing.
- **Test Coverage:** 100%

### T2.4: Implement "Tasks Gate" (Phase 2.1)
- **Description:** Implement validation logic for `tasks.md` to ensure it has at least one task and each task has a "Definition of Done".
- **DoD:**
  - Correctly parses `tasks.md`.
  - Validates the presence of tasks and their structure.
- **Test Coverage:** 100%

### T2.5: Implement "Code Gate" Integration (Phase 3.1/4.2)
- **Description:** Integrate `SDSComplianceScorer` and existing telemetry logic to verify linting status and 100% test coverage before allowing handoff to QA or Completion.
- **DoD:**
  - Logic fetches coverage and linting metrics for the track.
  - Fails the gate if metrics are below SDS standards.
- **Test Coverage:** 100%

### T2.6: File Watcher Integration for Auto-Validation
- **Description:** Connect `NodeFilesystemWatcher` to the `OrchestrationService` to trigger the `ValidationEngine` whenever files in the track directory are modified.
- **DoD:**
  - `OrchestrationService` subscribes to watcher events.
  - Quality gates are re-evaluated on `FILE_SAVED` events.
  - Status updates to `HandoffReady` automatically when gates are met.
- **Test Coverage:** 100%

---

## 3. Agent Hand-off Logic (Bootstrapping Integration)

### T3.1: Implement Phase-to-Agent Mapping
- **Description:** Implement the mapping logic that selects the correct agent role based on the current SDS phase as defined in the Spec (1.1 -> PM, 1.2 -> Architect, etc.).
- **DoD:**
  - Mapping is configurable or follows the SDS standard precisely.
  - Used by the transition logic to determine the `assignedAgent`.
- **Test Coverage:** 100%

### T3.2: Integrate with BootstrappingService
- **Description:** Extend `OrchestrationService` to call `BootstrappingService.resolve(agent_role)` when a new phase starts.
- **DoD:**
  - Correctly fetches agent instructions from the trusted `.gemini/agents` or `.meridian/core` paths.
  - Fails if the agent role cannot be resolved.
- **Test Coverage:** 100%

### T3.3: Automated Session Initialization
- **Description:** Implement automatic session creation via `SessionManagerService` upon successful phase transition, passing the track's context and the resolved agent instructions.
- **DoD:**
  - A new session is started for the newly assigned agent.
  - The session context includes relevant track files and metadata.
- **Test Coverage:** 100%

### T3.4: Implement "Approve Handoff" Logic
- **Description:** Implement the service-level logic for the user to approve a pending handoff.
- **DoD:**
  - Transitions state from `HandoffReady` to the next phase.
  - Updates metadata and triggers the next agent.
- **Test Coverage:** 100%

### T3.5: Implement "Force Override" Logic
- **Description:** Implement the service-level logic for the user to bypass quality gates and force a transition to any valid SDS phase.
- **DoD:**
  - Updates state to `Overridden` in logs.
  - Transitions to the target phase regardless of gate status.
  - Restricted to user triggers only (not automated agents).
- **Test Coverage:** 100%

---

## 4. UI Panel (React Implementation)

### T4.1: Create OrchestrationPanel Component
- **Description:** Implement the base `OrchestrationPanel` React component in `src/components/TelemetryDashboard/` or a new directory.
- **DoD:**
  - Component renders correctly in the main UI layout.
  - Basic styling matches the Meridian design system.
- **Test Coverage:** 100%

### T4.2: Implement Phase Stepper UI
- **Description:** Create a visual stepper component that shows the current SDS phase progress and status indicators (Completed, In Progress, Locked, Error).
- **DoD:**
  - Accurately reflects the `orchestration.currentPhase` from track metadata.
  - Uses visual cues (colors/icons) to represent quality gate status.
- **Test Coverage:** 100%

### T4.3: Implement Handoff and Override Controls
- **Description:** Add "Approve Handoff" and "Force Override" buttons to the `OrchestrationPanel`.
- **DoD:**
  - "Approve Handoff" is enabled only when `status === 'HandoffReady'`.
  - "Force Override" opens a confirmation modal before proceeding.
  - Buttons trigger the respective methods in `OrchestrationService`.
- **Test Coverage:** 100%

### T4.4: Integrate OrchestrationPanel into TrackNavigator
- **Description:** Embed the `OrchestrationPanel` or a summary view into the `TrackNavigator` component for easy access.
- **DoD:**
  - Users can see the current phase status while navigating between tracks.
- **Test Coverage:** 100%

### T4.5: Implement Orchestration Log Viewer UI
- **Description:** Add a section to the UI to view the history of phase handoffs and overrides for the active track.
- **DoD:**
  - Renders a list of log entries from `metadata.json` or `orchestration.log`.
  - Displays timestamps, agents, and triggers clearly.
- **Test Coverage:** 100%
