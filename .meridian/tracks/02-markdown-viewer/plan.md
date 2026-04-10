# Implementation Plan: Markdown Viewer MVP (Draft RFC)

**Status:** `Draft RFC`
**Track:** `02-markdown-viewer`
**Reference:** [Specification: Markdown Viewer MVP](./spec.md)
**Author:** Architect Agent
**Date:** April 9, 2026

---

## 1. Proposed Architecture

The Markdown Viewer will be implemented as a modular React component suite integrated into the Meridian Frontend. It will leverage a "Local-First" data flow where the frontend requests document contents from the Backend via the existing Socket.io bridge.

### Component Structure

- **`MarkdownViewer` (Container):** The top-level component that manages the state of the currently viewed file, handles history (back/forward), and orchestrates data fetching from the backend.
- **`MarkdownRenderer` (Main):** A wrapper around `react-markdown`. It configures the parser with `remark-gfm` and maps standard HTML elements to custom Meridian components.
- **`CodeBlock` (Sub-component):** Uses `react-syntax-highlighter` (with Prism) to provide themed syntax highlighting for code blocks. It supports language detection and a "Copy to Clipboard" feature (future enhancement).
- **`LinkHandler` (Sub-component):** A custom implementation for the `<a>` tag. It intercepts clicks to relative paths (e.g., `./plan.md`) and instructs the `MarkdownViewer` to load the new path instead of triggering a browser navigation.

### Component Hierarchy (ASCII)

```text
+------------------------------------------+
|          MarkdownViewer (Container)      |
|    [State: content, currentPath, history] |
+---------------------+--------------------+
                      |
            +---------v-----------+
            |  MarkdownRenderer   |
            |   (react-markdown)  |
            +---------+-----------+
                      |
            +---------+-------------------+
            |                             |
    +-------v-------+             +-------v-------+
    |  LinkHandler  |             |   CodeBlock   |
    |  (Custom <a>) |             | (Prism-based) |
    +---------------+             +---------------+
```

---

## 2. Technical Stack

- **React 19:** Utilizing latest Hooks for state management.
- **TypeScript:** Full type safety for props and backend messages.
- **Vanilla CSS:** Custom styles defined in `MarkdownViewer.css`, following the Meridian Design System (SDS). No external CSS frameworks.
- **Libraries:**
  - `react-markdown`: Core parser.
  - `remark-gfm`: Support for GitHub Flavored Markdown (tables, task lists).
  - `react-syntax-highlighter`: For syntax highlighting.

---

## 3. Data Flow

1. **Request:** The `MarkdownViewer` component is mounted with an initial path (e.g., `.meridian/tracks/02-markdown-viewer/spec.md`).
2. **Fetch:** It emits a `get-file-content` event via Socket.io with the target path.
3. **Resolve:** The Backend (Node.js/Vite server) reads the file from the disk, ensuring it stays within the project's root directory.
4. **Push:** The Backend emits `file-content` containing the raw string and metadata.
5. **Render:** `MarkdownViewer` updates its internal state. `MarkdownRenderer` processes the string and renders the virtual DOM.
6. **Navigation:** When a user clicks a link handled by `LinkHandler`:
   - If the link is **relative** (starts with `./` or `../`), it calculates the absolute-relative path based on the `currentPath` and repeats step 2.
   - If the link is **absolute/external**, it opens in a new browser tab.

---

## 4. Security

- **Path Sanitization:** The Backend MUST sanitize all incoming paths to prevent "Directory Traversal" attacks (e.g., preventing `../../../../etc/passwd`).
- **Restricted Access:** The file fetcher will be restricted to reading files with `.md`, `.json`, and `.txt` extensions within the project root.
- **XSS Prevention:** `react-markdown` by default escapes HTML. We will keep this behavior enabled to prevent malicious Markdown from executing scripts.

---

## 5. Requirements Mapping

| Requirement (from Spec) | Technical Decision |
| :--- | :--- |
| **GFM Support** | Integration of `remark-gfm` plugin. |
| **Navigation** | Implementation of `LinkHandler` for path resolution. |
| **Code Highlighting** | Use of `react-syntax-highlighter` with Prism. |
| **Performance** | Local state management and optimized re-renders in React 19. |
| **Vanilla CSS** | Strict adherence to the provided tech stack constraints. |

---

## 6. Trade-offs

### Chosen: `react-markdown` + `remark-gfm`
- **Pros:** Native React integration, easy to override specific elements (like links and code) with custom components, huge ecosystem of plugins.
- **Cons:** Slightly larger bundle size due to the dependency tree.

### Alternative: `marked` or `markdown-it`
- **Pros:** Extremely fast and lightweight.
- **Cons:** They output raw HTML strings. Integrating custom React logic for relative links would require using `dangerouslySetInnerHTML` and manual DOM event delegation, which is error-prone and less "React-way".
- **Reason for Rejection:** The need for deep integration with React for link handling and syntax highlighting outweighs the minor performance gains of a non-React parser.

---

## 7. Data Schema (Socket.io Messages)

**Client to Server:**
```typescript
{
  "event": "get-file-content",
  "data": { "path": "string" }
}
```

**Server to Client:**
```typescript
{
  "event": "file-content",
  "data": {
    "path": "string",
    "content": "string",
    "error": "string | null"
  }
}
```
