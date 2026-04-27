import { describe, it, expect, beforeEach } from "vitest";
import { SpecGate } from "./SpecGate";
import { MockFileSystem } from "../mocks/MockFileSystem";
import path from "node:path";

describe("SpecGate", () => {
  let fs: MockFileSystem;
  const meridianDir = "/test/.meridian";
  const trackId = "track-1";
  const specPath = path.join(meridianDir, "tracks", trackId, "spec.md");

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("fails if spec.md does not exist", async () => {
    const result = await SpecGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.message).toContain("spec.md not found");
  });

  it("fails if mandatory sections are missing", async () => {
    const content = "# Specification\n\n## Problem Statement\nSome text here.";
    fs.writeFile(specPath, content);

    const result = await SpecGate(trackId, fs, meridianDir);
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Section "Audience" is missing');
    expect(result.errors).toContain('Section "Success Criteria" is missing');
  });

  it("succeeds if all mandatory sections are present", async () => {
    const content = `
# Specification
## Problem Statement
The problem.
## Target Audience
The users.
## Success Criteria
It works.
    `;
    fs.writeFile(specPath, content);

    const result = await SpecGate(trackId, fs, meridianDir);
    expect(result.success).toBe(true);
  });
});
