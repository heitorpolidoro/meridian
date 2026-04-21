# MCP Tools for Code Quality

This reference documents the available MCP tools for SonarCloud and DeepSource and how to use them effectively.

## SonarCloud Tools

- `mcp_sonarcloud_get_quality_gate`: Gets the status of the Quality Gate for a project.
  - Required: `projectKey`
- `mcp_sonarcloud_list_issues`: Lists bugs, vulnerabilities, and code smells.
  - Required: `projectKey`
  - Optional: `severities`, `types`, `limit`

## DeepSource Tools

- `mcp_deepsource_get_repo_health`: Gets health status and metrics.
  - Required: `login`, `repoName`
- `mcp_deepsource_list_repo_issues`: Lists active issues found by DeepSource.
  - Required: `login`, `repoName`
  - Optional: `limit`

## Usage Patterns

### Full Assessment
1. Check Quality Gate/Repo Health.
2. List top issues (limit 10-20).
3. Group issues by file to minimize context switching.

### Issue Resolution
1. Read the file containing the issue.
2. Analyze the specific lines and surrounding context.
3. Apply the fix following project-specific standards.
4. Verify the fix (manually or via tests).
