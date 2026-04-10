# Tasks: Markdown Viewer MVP

**Status:** `Ready for Execution`
**Track:** `02-markdown-viewer`
**Reference:** [Specification: Markdown Viewer MVP](./spec.md) | [Implementation Plan: Markdown Viewer MVP](./plan.md)

---

## Module 1: Library & Boilerplate [COMPLETED]

### Task 1.1: Project Setup and Library Installation [COMPLETED]
- **Description:** Install `react-markdown`, `remark-gfm`, and `react-syntax-highlighter` as project dependencies. Create the initial file structure for the `MarkdownViewer` component in `src/components/MarkdownViewer/`.
- **Requirement Link:** [GFM Support] (Spec 3)
- **DoD:**
  - `package.json` updated with new dependencies. [DONE]
  - Basic `MarkdownViewer.tsx` component exists and renders a hardcoded string. [DONE]
  - Unit test using `vitest`/`react-testing-library` confirms the component renders basic text. [DONE]

### Task 1.2: GFM and Basic Markdown Configuration [COMPLETED]
- **Description:** Integrate `remark-gfm` into the `react-markdown` configuration. Ensure that tables, task lists, and strikethroughs are correctly parsed and rendered.
- **Requirement Link:** [GFM Support] (Spec 3)
- **DoD:**
  - A test Markdown string containing a table and a task list is correctly rendered as HTML elements. [DONE]
  - Unit tests verify the presence of `<table>` and `<input type="checkbox">` for appropriate GFM inputs. [DONE]

---

## Module 2: Custom Components

### Task 2.1: Syntax Highlighting for Code Blocks
- **Description:** Implement the `CodeBlock` component using `react-syntax-highlighter` (Prism). Support syntax highlighting for TypeScript, JSON, and Markdown.
- **Requirement Link:** [Code Highlighting] (Spec 3)
- **DoD:**
  - Code blocks in Markdown are rendered with syntax-specific colors according to a theme (e.g., `oneLight` or custom).
  - Unit tests confirm that the `CodeBlock` component receives the correct `language` and `value` props.
  - Verify that the Prism styles are bundled locally and no external CDN is used.

### Task 2.2: Intercept Relative Links (LinkHandler)
- **Description:** Create a custom `LinkHandler` component to replace the default `<a>` tag in `react-markdown`. Intercept clicks on relative Markdown links (e.g., `./doc.md`) to trigger a file load within the app instead of a full page navigation.
- **Requirement Link:** [Navigation] (Spec 3)
- **DoD:**
  - Clicking a relative link calls a state-updating function in the parent `MarkdownViewer` with the resolved path.
  - External links (starting with `http` or `https`) open in a new tab with `rel="noopener noreferrer"`.
  - Unit tests simulate clicks on both relative and absolute links and verify the expected behavior.

---

## Module 3: Data Fetching

### Task 3.1: Backend: Secure File Fetching
- **Description:** Implement the `get-file-content` event handler on the Node.js/Vite server. Include path sanitization to prevent directory traversal attacks and restrict file types to `.md`, `.json`, and `.txt`.
- **Requirement Link:** [Performance] (Spec 3), [Security (Plan)]
- **DoD:**
  - The server correctly reads a file from the disk and sends its content via `file-content` socket event.
  - Attempts to read files outside the project root or with illegal extensions return a structured error message.
  - Server-side unit tests verify the sanitization logic and path resolution.

### Task 3.2: Frontend: Socket.io Integration in MarkdownViewer
- **Description:** Wire the `MarkdownViewer` state to the Socket.io client. Emit `get-file-content` on mount or when the `currentPath` changes, and update the content state when `file-content` is received.
- **Requirement Link:** [Performance] (Spec 3)
- **DoD:**
  - The component displays a loading indicator (spinner/skeleton) while fetching.
  - The component renders the content received from the backend.
  - Error messages from the backend (e.g., "File not found") are displayed to the user.

---

## Module 4: Integration & Styling

### Task 4.1: Design System & Styling
- **Description:** Apply vanilla CSS to the `MarkdownViewer` and its sub-components to match the Meridian Design System (SDS). Focus on typography (Inter/system fonts), spacing, and responsive layout.
- **Requirement Link:** [Vanilla CSS (Plan)]
- **DoD:**
  - Visual review confirms alignment with SDS guidelines for documentation viewing.
  - Markdown styles (headings, lists, blockquotes) are consistent with the app's overall theme.
  - Styles are defined in a local `MarkdownViewer.css` file and imported into the component.

### Task 4.2: Final Integration and End-to-End Test
- **Description:** Mount the `MarkdownViewer` in the main Dashboard. Verify the full flow: loading a specification document, clicking a relative link to a plan, and viewing highlighted code within that plan.
- **Requirement Link:** [Success Criteria (Technical)] (Spec 3)
- **DoD:**
  - E2E test confirms the "navigation between documents" use case works end-to-end.
  - Performance measurement confirms rendering time is within the < 200ms threshold for standard project files.
  - No errors in the browser console during the entire navigation flow.
