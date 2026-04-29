import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ValidationEngine,
  QualityGateFn,
  ValidationResult,
} from "./ValidationEngine";
import { MockFileSystem } from "./mocks/MockFileSystem";

describe("ValidationEngine", () => {
  let fs: MockFileSystem;
  let engine: ValidationEngine;
  const meridianDir = "/test/.meridian";

  beforeEach(() => {
    fs = new MockFileSystem();
    engine = new ValidationEngine(fs, meridianDir);
  });

  it("registers and runs a success gate", async () => {
    const successGate: QualityGateFn = async () => ({
      success: true,
      gateName: "SuccessGate",
      message: "Passed",
    });

    engine.registerGate("1.1", successGate);
    const report = await engine.runValidation("track-1", "1.1");

    expect(report.overallSuccess).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].gateName).toBe("SuccessGate");
  });

  it("fails overall success if one gate fails", async () => {
    const successGate: QualityGateFn = async () => ({
      success: true,
      gateName: "SuccessGate",
      message: "Passed",
    });
    const failGate: QualityGateFn = async () => ({
      success: false,
      gateName: "FailGate",
      message: "Failed",
    });

    engine.registerGate("1.1", successGate);
    engine.registerGate("1.1", failGate);

    const report = await engine.runValidation("track-1", "1.1");

    expect(report.overallSuccess).toBe(false);
    expect(report.results).toHaveLength(2);
  });

  it("returns empty report if no gates are registered for the phase", async () => {
    const report = await engine.runValidation("track-1", "1.1");
    expect(report.overallSuccess).toBe(true);
    expect(report.results).toHaveLength(0);
  });

  it("handles errors within gates gracefully", async () => {
    const errorGate: QualityGateFn = () => {
      throw new Error("Boom");
    };

    engine.registerGate("1.1", errorGate);
    const report = await engine.runValidation("track-1", "1.1");

    expect(report.overallSuccess).toBe(false);
    expect(report.results[0].message).toContain(
      "Unexpected error during validation: Boom",
    );
  });

  it("handles non-Error objects thrown within gates", async () => {
    const stringErrorGate: QualityGateFn = () => {
      throw "Non-Error Object";
    };

    engine.registerGate("1.1", stringErrorGate);
    const report = await engine.runValidation("track-1", "1.1");

    expect(report.overallSuccess).toBe(false);
    expect(report.results[0].message).toContain(
      "Unexpected error during validation: Non-Error Object",
    );
  });

  it("uses gate name in error reports if available", async () => {
    const namedGate: QualityGateFn = () => {
      throw new Error("Fail");
    };
    Object.defineProperty(namedGate, "name", { value: "MyNamedGate" });

    engine.registerGate("1.1", namedGate);
    const report = await engine.runValidation("track-1", "1.1");

    expect(report.results[0].gateName).toBe("MyNamedGate");
  });

  it("uses 'Quality Gate' as fallback if gate function has no name", async () => {
    // We use an anonymous function and force its name to be empty if necessary,
    // though usually a lambda assigned to a variable has the variable name.
    // A direct anonymous function in registerGate might work.
    engine.registerGate("1.1", () => {
      throw new Error("Anonymous Fail");
    });
    const report = await engine.runValidation("track-1", "1.1");
    expect(report.results[0].gateName).toBe("Quality Gate");
  });

  it("passes necessary parameters to gates", async () => {
    const spyGate = vi
      .fn()
      .mockResolvedValue({ success: true, gateName: "Spy", message: "ok" });

    engine.registerGate("1.1", spyGate);
    await engine.runValidation("track-my-id", "1.1");

    expect(spyGate).toHaveBeenCalledWith("track-my-id", fs, meridianDir);
  });
});
