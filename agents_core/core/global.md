# Core Engineering Standards (Global)

These standards apply to ALL agents in the Meridian/JARVIS ecosystem (Code, Data, and DevOps).

## 🧱 Universal Design Principles
1. **Single Responsibility (SRP):** Each component (Function, Class, Table, or Module) must have one, and only one, reason to change.
2. **Open/Closed Principle:** Systems should be open for extension but closed for modification. Change behavior by adding new components, not by breaking existing contracts.
3. **Abstraction over Implementation:** Depend on stable contracts (Interfaces, APIs, Schemas) rather than concrete implementations.
4. **Clean Engineering:** 
    - **Meaningful Naming:** Names must reveal intent (e.g., `is_member_active` vs `m_act_flg`).
    - **Modularity:** Break complex logic into smaller, testable, and reusable pieces.
5. **DRY (Don't Repeat Yourself):** Avoid redundancy. In code, use abstractions; in data, use normalization.
6. **KISS (Keep It Simple, Stupid):** The most maintainable solution is usually the simplest one. Avoid premature optimization and over-engineering.

## 🛡️ Operational Security
1. **No Secrets:** Never hardcode credentials. Use environment variables or secure vaults.
2. **Least Privilege:** Components should only have the access strictly necessary to perform their duty.
3. **Fail Safely:** Design systems to handle errors gracefully without exposing sensitive information or crashing the entire environment.

## 🧪 Testing & Quality
1. **Verification by Design:** If a component is impossible to test or validate, its design is flawed. Refactor.
2. **Deterministic Behavior:** Outcomes should be predictable and independent of external, unmanaged state.
