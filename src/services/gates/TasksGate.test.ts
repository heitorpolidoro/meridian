import { describe, it, expect, beforeEach, vi } from "vitest";
import { TasksGate } from "./TasksGate";
import { MockFileSystem } from "../mocks/MockFileSystem";
import path from "node:path";
import YAML from "yaml";

describe("TasksGate", () => {
  let fs: MockFileSystem;
  const meridianDir = "/test/.meridian";
  const trackId = "track-1";
  const tasksPathYaml = path.join(meridianDir, "tracks", trackId, "tasks.yaml");

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("fails if tasks.yaml does not exist", async () => {
    const result = await TasksGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("tasks.yaml not found");
  });

  describe("YAML validation", () => {
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

    it("fails with a parsing error in tasks.yaml", async () => {
      const content = "tasks: [unclosed bracket";
      fs.writeFile(tasksPathYaml, content);

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Error parsing tasks.yaml");
    });

    it("handles non-Error objects thrown during YAML parsing", async () => {
      fs.writeFile(tasksPathYaml, "some: yaml");
      const spy = vi.spyOn(YAML, "parse").mockImplementationOnce(() => {
        throw "string error";
      });

      const result = await TasksGate(trackId, fs, meridianDir);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Error parsing tasks.yaml: string error");
      spy.mockRestore();
    });
  });
});
