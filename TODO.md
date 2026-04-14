# Meridian Project TODO

## Agent Management
- [x] Standardize Agent Installation:
    - [x] Move `core` and `roles` to a `.meridian/` directory in the project root.
    - [x] Use relative paths (e.g., `@../../.meridian/roles/`) in `.gemini/agents/*.md` bootstrapping.
    - [x] Use relative paths (e.g., `@../core/`) for internal role inheritance.
- [ ] Implement a script or automated workflow to "install" and sync these agents/roles across all projects in `~/workspace/` to avoid symbolic link and permission issues.
