import { describe, it, expect, beforeEach } from "vitest";
import { TasksGate } from "./TasksGate";
import { MockFileSystem } from "../mocks/MockFileSystem";
import path from "node:path";

describe("TasksGate", () => {
  let fs: MockFileSystem;
  const meridianDir = "/test/.meridian";
  const trackId = "track-1";
  const tasksPathMd = path.join(meridianDir, "tracks", trackId, "tasks.md");
  const tasksPathYaml = path.join(meridianDir, "tracks", trackId, "tasks.yaml");

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("fails if neither tasks.md nor tasks.yaml exist", async () => {
    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Neither tasks.yaml nor tasks.md found");
  });

  describe("YAML support", () => {
    it("succeeds with a valid tasks.yaml", async () => {
      const content = `
trackId: "track-1"
tasks:
  - id: "1.1"
    title: "Test Task"
    dod: "Tested"
    status: "todo"
      `;
      fs.writeFile(tasksPathYaml, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(true);
      expect(result.message).toBe("tasks.yaml is valid");
    });

    it("fails with invalid schema in tasks.yaml", async () => {
      const content = `
trackId: "track-1"
tasks:
  - id: "1.1"
    title: "Test Task"
    # missing dod and status
      `;
      fs.writeFile(tasksPathYaml, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.message).toContain("tasks.yaml has invalid schema");
    });

    it("fails if tasks.yaml list is empty", async () => {
      const content = `
trackId: "track-1"
tasks: []
      `;
      fs.writeFile(tasksPathYaml, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.message).toContain("must contain at least one task");
    });
  });

  describe("Legacy Markdown support", () => {
    it("fails if no tasks are defined in .md", async () => {
      const content = "# Tasks\n\nNo tasks yet.";
      fs.writeFile(tasksPathMd, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.message).toContain("at least one [Task X.X]");
    });

    it("fails if a task is missing DoD in .md", async () => {
      const content = `
# Tasks
## [Task 1.1] Setup
Description here. No criteria defined.
## [Task 1.2] Implementation
Definition of Done: Code written.
      `;
      fs.writeFile(tasksPathMd, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.errors).toContain("1 task(s) are missing DoD");
    });

    it("succeeds if all tasks have DoD in .md", async () => {
      const content = `
# Tasks
## [Task 1.1] Setup
DoD: Workspace ready.
## [Task 1.2] Implementation
Definition of Done: Tests pass.
      `;
      fs.writeFile(tasksPathMd, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(true);
      expect(result.message).toContain("Legacy tasks.md is valid");
    });
  });
});
