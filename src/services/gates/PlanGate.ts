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

  const gateName = "PlanGate";
  const resultsMap: Record<string, ValidationResult> = {
    missingSections: {
      success: false,
      gateName,
      message: `plan.md is missing sections: ${missingSections.join(", ")}`,
    },
    missingSpecRef: {
      success: false,
      gateName,
      message: `plan.md is missing a reference to spec.md`,
    },
    success: {
      success: true,
      gateName,
      message: `plan.md for track ${trackId} passed all checks`,
    },
  };

  const outcomeKey = missingSections.length > 0
    ? "missingSections"
    : !hasSpecRef
    ? "missingSpecRef"
    : "success";

  return Promise.resolve(resultsMap[outcomeKey]);
}

  const errors: string[] = [];
  if (missingSections.length > 0) {
    errors.push(...missingSections.map((s) => `Section "${s}" is missing`));
  }
  if (!hasSpecRef) {
    errors.push('Reference to "spec.md" is missing');
  }

  if (errors.length > 0) {
    return Promise.resolve({
      success: false,
      gateName: "PlanGate",
      message: "Validation failed for plan.md",
      errors,
    });
  }

  return Promise.resolve({
    success: true,
    gateName: "PlanGate",
    message: "plan.md is valid",
  });
};
