# Software Development Standard (SDS) - Meridian

This document defines the standard Software Development Life Cycle (SDLC) for projects within the Meridian ecosystem, aiming for technical excellence, security, and maintainability.

---

## 🚀 General Philosophy
- **Iterative:** Frequent and incremental deliveries.
- **Secure by Design:** Constant audits and validations.
- **Documented:** Code and architecture must be understandable.

---

## 📑 Life Cycle Phases

### 1. Conception & Technical Design
#### 1.1 Specification / PRD (Product Requirements Document)
Focused on the **problem** and **business requirements**. A project may have multiple specifications focused on specific features to ensure incremental deliveries.
- **Vision Document (Product Definition):** For complex projects, a master document that defines the macro objective and connects the different specifications.
- **Single Focus:** Each specification must solve a core problem or a set of problems with the same root, avoiding *Scope Creep*.
- **Essential Content:**
    - **Problem:** What specific pain point are we solving?
    - **Audience:** Who are the end users?
    - **Success Criteria:** How will we measure impact (e.g., time reduction, accuracy increase)?
    - **Constraints:** Technical or business limits (e.g., budget, specific tech stack).

#### 1.2 Implementation Plan / RFC (Request for Comments)
Focused on the **technical solution**. This document details the "how" before and during implementation.
- **Link to Specification (Mandatory):** Every plan must reference which requirements from the Specification/PRD it resolves.
- **Evolutionary Nature:** The plan is not a static document; it must be updated as new technical obstacles arise or the specification evolves.
- **Essential Content:**
    - **Proposed Architecture:** How do the components communicate?
    - **Data Schema:** Database structure or message formats.
    - **Security:** How will we protect data and access?
    - **Requirements Mapping (Justification):** Detailed explanation of how the technical decisions above solve the problems and meet the requirements listed in the Specification/PRD.
    - **Trade-offs:** Why did we choose Solution A over B? What are the pros and cons?

### 2. Planning & Granularity
#### 2.1 Task Breakdown (Implementation Checklist)
Breaking down the technical plan into smaller tasks (1-3 days) to facilitate tracking and review.
- **Hierarchy:** Tasks must be linked to a functionality (Story/Feature) defined in the Specification/PRD.
#### 2.2 Definition of Done (DoD)
Universal criteria for completing any task:
- **Functional Code:** Logic implemented according to the Task.
- **Unit Tests:** Automated test scripts validating isolated logic (base of the pyramid).
- **Manual Tests:** Functional validation performed by **QA**, ensuring the final behavior meets business requirements and user expectations.
- **Clean Code:** Formatting and Linting (e.g., Ruff/Prettier) applied.
- **Updated Documentation:** Specification or Plan documents updated if there is a structural or behavioral change.

### 3. Development & Quality
#### 3.1 Trunk-based Development (via Pull Requests)
Continuous integration into the main branch through short, focused **Pull Requests (PRs)**.
- **Advantage:** Formalizes code review, ensures DoD compliance, and keeps the `master` branch always stable and ready for deployment.
- **Frequency:** PR branches should be short-lived (maximum 2-3 days) to avoid complex merge divergences.
#### 3.2 Conventional Commits
Semantic commit history (`feat:`, `fix:`, `refactor:`) for automated changelogs and versioning.
#### 3.3 Local Automation (Pre-commit Hooks)
Every repository must contain a **Pre-commit Hooks** configuration (`.pre-commit-config.yaml`) with Linters and Formatters that support **Autofix**.
- **Directive:** The hook should attempt to automatically fix simple formatting and linting errors (e.g., `ruff --fix`, `prettier --write`) before blocking the commit for review.
- **Workflow:** If the hook makes changes, the developer must review, re-stage the changes (`git add`), and repeat the commit.
- **Recommendations by Language:**
    - **Python:** Ruff (extremely fast Linter and Formatter with autofix support).
    - **JS/TS:** ESLint and Prettier.
    - **Markdown/Documents:** Prettier or Markdownlint.
    - **Shell:** ShellCheck.

### 4. Test Strategy
#### 4.1 Test Pyramid
Testing effort should follow the pyramid proportion to ensure speed and low maintenance costs:
- **Unit Tests (Base):** Test isolated functions and classes. Should be fast and cover most of the business logic.
    - **Coverage Directive (Target):** The target should be **100% code coverage (Line and Branch coverage)** across all business logic and core components.
    - **Complexity Signal:** If achieving 100% coverage is excessively difficult in a specific branch, it should be interpreted as a sign that the code needs **refactoring**.
    - **Justified Exceptions:** If 100% is not achieved due to external technical limitations, the gap must be documented and justified in the PR.
- **Integration Tests (Middle):** Validate communication between modules, databases, and external APIs.
- **E2E / End-to-End Tests (Top):** Simulate the complete end-user flow. Should be focused on critical paths.

#### 4.2 Hybrid Validation (As per DoD 2.2)
Every feature must pass through two quality filters:
- **Automated:** Guaranteed by unit and integration tests running in the CI pipeline.
- **Manual (Evidence):** A round of manual tests must be performed by **QA (or the person responsible for sign-off)**, attaching a brief summary of the tested scenarios as a **comment on the Pull Request**. The merge into the `master` branch should only occur after this positive validation.

#### 4.3 Security & Audit (DevSecOps)
- **SAST (Static Analysis):** Use tools to detect insecure code patterns (e.g., `bandit` for Python).
- **Dependency Audit:** Automatic verification of known vulnerabilities in third-party libraries (e.g., `pip-audit` or `npm audit`).
- **Secrets Detection:** Blocking via pre-commit any attempt to commit API keys or secrets (e.g., `detect-secrets`).

### 5. CI/CD & Deployment
#### 5.1 Automation Pipelines (CI)
Execution of tests, lint, and automatic build on every commit in PR branches.
#### 5.2 Environment Promotion
Staging flow for technical validation before reaching the Production environment.
#### 5.3 Deployment Strategies (Continuous Deployment)
Deployment to the Production environment must be **automatic** after the Pull Request is approved on the main branch (`master`).
- **Deployment Condition:** Automatic deployment is only triggered if all CI tests (Linter, Unit, Security) pass and manual validation (4.2) is recorded in the PR.
- **Rollback:** The system must allow for a quick rollback (reverting to the previous version) if anomalies are detected in Production immediately after deployment.

### 6. Observability & Operation
#### 6.1 Monitoring & Telemetry
Structured logs, health metrics, and distributed tracing.
#### 6.2 Post-mortem
Technical and blameless analysis of real failures to prevent recurrence and improve the system.

### 7. Project Lifecycle & Status Management
To ensure efficient resource allocation and avoid "ghost projects", every Specification/PRD and Plan/RFC must have a clear status.

#### 7.1 PRD Statuses
- **Draft:** The problem/opportunity is being explored.
- **Active:** The problem is verified, and a solution is being implemented.
- **Completed:** The problem was solved, and success criteria were met.
- **Pivoted:** The problem was redefined; this PRD is closed in favor of a new successor.
- **On Hold:** The problem exists, but implementation is paused (e.g., cost/complexity too high).
- **Cancelled / Terminated:** The problem no longer exists, or it was decided not to pursue a solution.

#### 7.2 Fail Fast & Pivot Procedures
- **Complexity Spike:** If a solution is found to be too complex/expensive during RFC or Implementation, the project must stop immediately for a "Go/No-Go" review.
- **Validation Failure:** If a solution fails manual QA validation (does not solve the problem), the RFC must be deprecated and revisited.
- **Discovery of New Core Problem:** If implementation reveals a different root cause, the current PRD must be **Pivoted**, and a new PRD/RFC cycle must begin.
- **False Positive:** If a problem is found to be non-existent or low-impact, the project must be **Terminated** and archived with a justification note to prevent future "resurrections".

---
*Last update: April 2026*
