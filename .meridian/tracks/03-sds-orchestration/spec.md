# Specification: Automated SDS Orchestration

**Status:** `Draft`
**Owner:** PM Agent
**Date:** May 22, 2026

## 1. Problem Statement
The transition between different phases of the **Software Development Standard (SDS)** currently relies on manual triggers and human oversight. This manual handoff process is error-prone, increases cognitive load, and can lead to SDS non-compliance if quality gates are overlooked.
- **Cost of Inaction:** Inefficient agent coordination, delayed project timelines, and potential "Ghost Projects" (SDS 7) due to lack of automated phase enforcement.

## 2. Audience
- **User (Heitor):** The primary orchestrator who oversees and approves phase transitions.
- **AI Agents:** The autonomous entities (PM, Architect, Engineer, QA) that perform tasks within each SDS phase.

## 3. Success Criteria (Measurable)
- **Efficiency:** 50% reduction in manual effort required to coordinate transitions between SDS phases.
- **Compliance:** 100% adherence to the defined SDS phase order and mandatory quality gates.
- **Traceability:** 100% of phase handoffs must be logged in the track's metadata with timestamps and agent attribution.
- **User Control:** The User must be able to override or force any handoff via the UI at any time.

## 4. Constraints & Requirements
- **Trigger System:** Define specific events that trigger the next phase in the SDS lifecycle.
    - `spec.md` (Status: `Completed`) -> Triggers `plan.md` creation (Invoke **Architect**).
    - `plan.md` (Status: `Completed`) -> Triggers `tasks.md` creation (Invoke **Engineer**/**PM**).
    - `tasks.md` (Status: `Active`) -> Triggers development (Invoke **Engineer**).
    - PR Creation -> Triggers validation (Invoke **QA**).
- **Autonomous Agent Selection:**
    - The system must automatically select the correct agent role based on the current SDS phase as defined in `SDS.md`.
    - Mapping:
        - Conception & Technical Design (1.1) -> **PM**
        - Implementation Plan (1.2) -> **Architect**
        - Planning & Granularity (2.1) -> **Engineer**/**PM**
        - Development (3.1) -> **Engineer**
        - Quality & Validation (4.2) -> **QA**
- **Quality Gates (Phase Enforcement):**
    - Mandatory validation checks before a phase is marked as 'Ready for Handoff'.
    - **Spec Gate:** Must contain "Problem Statement", "Audience", and "Success Criteria".
    - **Plan Gate:** Must reference a Spec and contain "Proposed Architecture" and "Requirements Mapping".
    - **Tasks Gate:** Must have at least one task and a "Definition of Done".
    - **Code Gate:** Must pass Linting and achieve the 100% coverage target (SDS 4.1).
- **User-in-the-loop (UI Requirements):**
    - The `TrackNavigator` or a dedicated `OrchestrationPanel` must display the current phase.
    - Provide an "Approve Handoff" button when quality gates are met.
    - Provide "Override" and "Force Handoff" options for the User.
- **Phase Tracking:**
    - Automatically update `metadata.json` when a handoff occurs (e.g., `current_phase`, `status`, `last_handoff`).
    - Maintain an `orchestration.log` within each track for auditing handoff events.

## 5. Technical Architecture
- **State Machine:** Implement a formal state machine to manage SDS phase transitions.
- **Event Bus:** Use an event-driven architecture to detect file changes (via `NodeFilesystemWatcher`) and trigger agent invocations.
- **Validation Engine:** A modular service that runs the quality gate checks for each phase.

## 6. Business Value & Lifecycle
- **ROI:** Automating the SDS "ceremony" allows the human orchestrator to focus on high-level strategy rather than low-level agent management.
- **Lifecycle & Pivot Triggers:**
    - **Pivot:** If the automated orchestration feels too restrictive and slows down development, pivot to a "Suggestion-only" mode where the agent suggests the next phase but doesn't block it.
    - **Termination:** If the state machine becomes too complex to maintain or frequently enters deadlock states, terminate the track and revert to manual handoffs.

## 7. Quality & Testing
- **100% Coverage:** The Orchestration Logic and State Machine must have 100% test coverage.
- **Scenario Testing:** Test various handoff scenarios, including successful transitions, failed quality gates, and user overrides.
- **Mocking:** Mock the agent invocation system to test the trigger logic in isolation.

---
*Linked Standard: [Meridian SDS](../../../standards/SDS.md)*
*Linked Product Vision: [Meridian Product Vision](../../product.md)*
