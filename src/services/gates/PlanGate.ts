import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

/**
 * Validates that the plan.md file for a given track contains mandatory sections.
 *
 * @param trackId - The identifier of the track to validate.
 * @param fs - The file system interface used to read and check files.
 * @param meridianDir - The base directory where track files are located.
 * @returns A promise that resolves to a ValidationResult indicating success or failure of the gate.
 */
export const PlanGate: QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
): Promise<ValidationResult> => {
  const planPath = path.join(meridianDir, "tracks", trackId, "plan.md");

  if (!fs.exists(planPath)) {
    return Promise.resolve({
      success: false,
      gateName: "PlanGate",
      message: `plan.md not found for track ${trackId}`,
    });
  }

  const content = fs.readFile(planPath);
  const mandatorySections = ["Proposed Architecture", "Requirements Mapping"];
  const missingSections = mandatorySections.filter((section) => {
    const sectionRegex = new RegExp(`^#+\\s+.*${section}.*`, "mi");
    return !sectionRegex.test(content);
  });

  // 2. Check for reference to spec.md
  const specRefRegex = /\[.*spec\.md\]\(.*\)/i;
  const hasSpecRef =
    specRefRegex.test(content) || content.toLowerCase().includes("spec.md");

  const errors: string[] = [];
  if (missingSections.length > 0) {
    errors.push(...missingSections.map((s) => `Section "${s}" is missing`));
  }
  if (!hasSpecRef) {
    errors.push('Reference to "spec.md" is missing');
  }

  if (errors.length > 0) {
    return {
      success: false,
      gateName: "PlanGate",
      message: "Validation failed for plan.md",
      errors,
    };
  }

  return {
    success: true,
    gateName: "PlanGate",
    message: "plan.md is valid",
  };
};
