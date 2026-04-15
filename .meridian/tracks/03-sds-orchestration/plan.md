# Implementation Plan: Automated SDS Orchestration

**Status:** `Draft`
**Owner:** Architect Agent
**Date:** May 22, 2026

## 1. Proposed Architecture

The 'Orchestration Engine' will be a central service in the Meridian ecosystem, responsible for managing the state of each track and automating the transitions between SDS phases.

### 1.1 Trigger Engine: Hierarchical State Machine (HSM)

We will use a **Hierarchical State Machine (HSM)** pattern to manage phase transitions.

- **Why HSM?** SDS phases are not purely linear; some phases have sub-phases (e.g., Phase 1 has 1.1 Specification and 1.2 Implementation Plan). An HSM allows for better organization of these nested states and their respective transitions.
- **Implementation:** A dedicated `OrchestrationService` will maintain the state of all tracks. It will listen for internal events (e.g., `FILE_SAVED`, `USER_ACTION`) and determine if a state transition is valid based on the current track's metadata.

### 1.2 Validation Engine: Quality Gates

A modular `ValidationEngine` will be responsible for checking if a phase is "DONE". It will perform:
- **Static Analysis:** Checking if required files (e.g., `spec.md`, `plan.md`) exist and contain mandatory sections using regex or Markdown AST parsing.
- **Structural Validation:** Ensuring `metadata.json` is correctly updated.
- **Compliance Scoring:** Leveraging the existing `SDSComplianceScorer` to verify quality metrics (e.g., test coverage, linting status).

### 1.3 Agent Activation: Bootstrapping Integration

The `OrchestrationService` will call the `BootstrappingService` to instantiate agents.
- When a transition to a new phase occurs, the engine identifies the required `agent_role` (PM, Architect, etc.) from the SDS mapping.
- It fetches the agent's full system instruction via `BootstrappingService.resolve(agent_role)`.
- It initializes a new session via `SessionManagerService`, passing the resolved instructions and the track's context.

### 1.4 Event-Driven Feedback Loop

- **Input:** `NodeFilesystemWatcher` emits events when files are modified.
- **Processing:** The `OrchestrationService` receives these events and re-evaluates the "Quality Gates" for the current phase.
- **Output:** If gates are met, the UI is updated to show "Ready for Handoff". If a mandatory automated transition is enabled, the next phase is triggered.

---

## 2. Data Schema

### 2.1 Extended `metadata.json`

We will update the `TrackMetadataSchema` in `TrackMetadataService.ts` to include orchestration-specific fields.

```typescript
export const OrchestrationStatusSchema = z.enum([
  'Idle', 
  'InProgress', 
  'WaitingForApproval', 
  'HandoffReady', 
  'Failed', 
  'Overridden'
]);

export const SDSPhaseSchema = z.enum([
  '1.1-spec',
  '1.2-plan',
  '2.1-tasks',
  '3.1-dev',
  '4.2-qa',
  '5.0-done'
]);

export const TrackMetadataSchema = z.object({
  // ... existing fields ...
  orchestration: z.object({
    currentPhase: SDSPhaseSchema.default('1.1-spec'),
    status: OrchestrationStatusSchema.default('Idle'),
    assignedAgent: z.string().optional(),
    handoffTimestamp: z.string().optional(),
    logs: z.array(z.object({
      timestamp: z.string(),
      fromPhase: SDSPhaseSchema,
      toPhase: SDSPhaseSchema,
      trigger: z.enum(['Auto', 'Manual', 'Override']),
      agent: z.string().optional()
    })).default([])
  }).optional()
});
```

### 2.2 `orchestration.log`

A separate `orchestration.log` file will be maintained within each track's directory (`.meridian/tracks/<track_id>/orchestration.log`) for detailed auditing, stored as JSONL (JSON Lines).

---

## 3. Security

- **Permission-based Overrides:** Only the primary user (Heitor) can trigger a "Force Override". Agents are restricted from modifying their own `orchestration.status` to `Overridden`.
- **Instruction Integrity:** The `BootstrappingService` ensures that agent instructions are resolved from trusted paths (`.meridian/core` and `.gemini/agents`), preventing prompt injection via track-local files.
- **State Immutability:** Previous phase logs in `metadata.json` are append-only to ensure traceability.

---

## 4. Requirements Mapping

| Component | PRD Requirement (Spec) | Justification |
| :--- | :--- | :--- |
| **HSM Pattern** | Trigger System | Provides a formal and robust way to manage complex phase transitions and sub-phases. |
| **ValidationEngine** | Quality Gates | Automates the enforcement of SDS standards (e.g., checking for "Problem Statement" in spec). |
| **Bootstrapping Integration** | Agent Selection | Ensures the correct agent role is invoked automatically based on the current phase. |
| **Extended Metadata** | Phase Tracking | Stores the source of truth for the current track state and provides a history for auditing. |
| **OrchestrationPanel (UI)** | User-in-the-loop | Gives the user visibility into the orchestration process and controls for approval/override. |

---

## 5. Trade-off Analysis

### Option A: Formal State Machine (Chosen)
- **Pros:** High predictability, easy to test, clear visualization of valid transitions, prevents "illegal" states.
- **Cons:** Slightly more boilerplate to define states and transitions; can be rigid if not designed carefully.
- **Verdict:** Necessary for SDS compliance, where strict adherence to phase order is a core requirement.

### Option B: Rule-based Engine (Rejected)
- **Pros:** Very flexible; transitions are determined by a set of "if-then" rules.
- **Cons:** Can lead to "spaghetti state" where it's hard to trace why a transition happened; prone to race conditions if multiple rules fire simultaneously.
- **Verdict:** Too risky for a system that needs to ensure 100% adherence to a specific lifecycle.

---

## 6. UI Requirements

### 6.1 `OrchestrationPanel` Component
A new component to be integrated into the `TrackNavigator` or as a sidebar in the main view.

- **Phase Indicator:** A progress stepper showing the current SDS phase and its status (e.g., 🟢 1.1 Spec, 🟡 1.2 Plan, ⚪ 2.1 Tasks).
- **Agent Status:** Displays the current `assignedAgent` and their activity status (e.g., "Architect is generating the plan...").
- **Approve Handoff Button:**
    - **Visible:** When `orchestration.status === 'HandoffReady'`.
    - **Action:** Updates `currentPhase` to the next state and triggers the next agent.
- **Force Override Button:**
    - **Visible:** Always (User only).
    - **Action:** Opens a confirmation dialog allowing the user to skip quality gates and move to any phase.
- **Orchestration Log Viewer:** A collapsible section showing the history of handoffs for the track.

---

## 7. Evolutionary Design

- **Module Decoupling:** The `ValidationEngine` will be separate from the `OrchestrationService`, allowing us to add or update quality gates (e.g., adding a new check for security audits) without touching the state machine logic.
- **Suggestion-only Mode:** The engine will support a `strictMode: boolean` flag. If `false`, it will suggest transitions but not block them, allowing for the "Pivot" scenario described in the specification.

---
*Linked Standard: [Meridian SDS](../../../standards/SDS.md)*
*Linked Specification: [03-sds-orchestration Spec](./spec.md)*
