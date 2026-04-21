---
name: code-quality-fixer
description: Identifies and fixes code quality issues from SonarCloud and DeepSource, and addresses PR review comments. Use when requested to improve code health, fix "code smells", bugs, or vulnerabilities reported by external analysis tools.
---

# Code Quality Fixer

## Overview

This skill provides a structured workflow for addressing technical debt and code quality issues identified by SonarCloud and DeepSource.

## Workflow

Follow these steps to systematically improve code quality:

### 1. Discovery & Assessment
- Check the current project health using `mcp_sonarcloud_get_quality_gate` or `mcp_deepsource_get_repo_health`.
- Retrieve the list of issues using `mcp_sonarcloud_list_issues` or `mcp_deepsource_list_repo_issues`.
- Group issues by file to maximize efficiency.
- For tool details, see [references/mcp-tools.md](references/mcp-tools.md).

### 2. Resolution Strategy
- Prioritize **Bugs** and **Vulnerabilities** over Code Smells.
- For each issue:
  1. Read the affected file and locate the specific lines.
  2. Research the project's coding standards to ensure the fix is idiomatic.
  3. Formulate a surgical fix that addresses the root cause without side effects.

### 3. Execution & Validation
- Apply the fix using the `replace` tool.
- Verify the change by running relevant tests (`npm test`, `pytest`, etc.).
- Ensure no new linting errors are introduced.

### 4. PR Review Comments
When addressing comments from a PR review:
- Use `mcp_github_pull_request_read` (method `get_review_comments`) to list all threads and their IDs.
- Address each thread one by one.
- Reply to the thread using `mcp_github_add_reply_to_pull_request_comment` once resolved.
- **Resolve the thread** using `mcp_github_pull_request_review_write` (method `resolve_thread`) to mark it as completed.

## Principles
- **Surgicality:** Only touch what is necessary to fix the reported issue.
- **Idiomaticity:** Always follow the existing style and patterns of the codebase.
- **Verification:** Every fix MUST be verified with tests if possible.
