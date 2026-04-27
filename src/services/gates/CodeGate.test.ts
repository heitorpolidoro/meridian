import { describe, it, expect, vi } from "vitest";
import { createCodeGate } from "./CodeGate";
import { ISDSComplianceScorer } from "../interfaces/ICoreServices";

describe("CodeGate", () => {
  it("fails if score is less than 100", async () => {
    const mockScorer: ISDSComplianceScorer = {
      calculateScore: vi.fn().mockReturnValue(85),
    };
    const gate = createCodeGate(mockScorer);
    const result = await gate("track-1", {} as any, "");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Score is only 85%");
  });

  it("succeeds if score is 100", async () => {
    const mockScorer: ISDSComplianceScorer = {
      calculateScore: vi.fn().mockReturnValue(100),
    };
    const gate = createCodeGate(mockScorer);
    const result = await gate("track-1", {} as any, "");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Score is 100%");
  });
});
