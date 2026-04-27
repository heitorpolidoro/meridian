import { describe, it, expect, beforeEach } from "vitest";
import { TasksGate } from "./TasksGate";
import { MockFileSystem } from "../mocks/MockFileSystem";
import path from "node:path";

describe("TasksGate", () => {
  let fs: MockFileSystem;
  const meridianDir = "/test/.meridian";
  const trackId = "track-1";
  const tasksPath = path.join(meridianDir, "tracks", trackId, "tasks.md");

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("fails if tasks.md does not exist", async () => {
    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("tasks.md not found");
  });

  it("fails if no tasks are defined", async () => {
    const content = "# Tasks\n\nNo tasks yet.";
    fs.writeFile(tasksPath, content);

    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("at least one task definition");
  });

  it("fails if a task is missing DoD", async () => {
    const content = `
# Tasks
## [Task 1.1] Setup
Description here. No criteria defined.
## [Task 1.2] Implementation
Definition of Done: Code written.
    `;
    fs.writeFile(tasksPath, content);

    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.errors).toContain("1 task(s) are missing DoD");
  });

  it("succeeds if all tasks have DoD", async () => {
    const content = `
# Tasks
## [Task 1.1] Setup
DoD: Workspace ready.
## [Task 1.2] Implementation
Definition of Done: Tests pass.
    `;
    fs.writeFile(tasksPath, content);

    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(true);
  });
});
