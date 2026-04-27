import { describe, it, expect, beforeEach } from "vitest";
import { PlanGate } from "./PlanGate";
import { MockFileSystem } from "../mocks/MockFileSystem";
import path from "node:path";

describe("PlanGate", () => {
  let fs: MockFileSystem;
  const meridianDir = "/test/.meridian";
  const trackId = "track-1";
  const planPath = path.join(meridianDir, "tracks", trackId, "plan.md");

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("fails if plan.md does not exist", async () => {
    const result = await PlanGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("plan.md not found");
  });

  it("fails if mandatory sections are missing", async () => {
    const content = "# Plan\n\nReference: spec.md";
    fs.writeFile(planPath, content);

    const result = await PlanGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.errors).toContain(
      'Section "Proposed Architecture" is missing',
    );
    expect(result.errors).toContain(
      'Section "Requirements Mapping" is missing',
    );
  });

  it("fails if spec.md reference is missing", async () => {
    const content = "# Proposed Architecture\n# Requirements Mapping";
    fs.writeFile(planPath, content);

    const result = await PlanGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Reference to "spec.md" is missing');
  });

  it("succeeds if all criteria are met", async () => {
    const content = `
# Plan
Reference: [Specification](./spec.md)
## Proposed Architecture
Logic here.
## Requirements Mapping
Table here.
    `;
    fs.writeFile(planPath, content);

    const result = await PlanGate(trackId, fs, meridianDir);
    expect(result.success).toBe(true);
  });
});
