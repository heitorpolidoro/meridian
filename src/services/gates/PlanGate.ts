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

  // Declarative validation checks
  const checks = [
    {
      condition: !(
        /\[.*spec\.md\]\(.*\)/i.test(content) ||
        content.toLowerCase().includes("spec.md")
      ),
      error: 'Reference to "spec.md" is missing',
    },
    ...["Proposed Architecture", "Requirements Mapping"].map((section) => ({
      condition: !new RegExp(`^#+\\s+.*${section}.*`, "mi").test(content),
      error: `Section "${section}" is missing`,
    })),
  ];

  const errors = checks.filter((c) => c.condition).map((c) => c.error);

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
