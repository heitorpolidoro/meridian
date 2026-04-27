import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

export const PlanGate: QualityGateFn = async (trackId: string, fs: IFileSystem, meridianDir: string): Promise<ValidationResult> => {
  const planPath = path.join(meridianDir, "tracks", trackId, "plan.md");
  
  if (!fs.exists(planPath)) {
    return {
      success: false,
      gateName: "PlanGate",
      message: `plan.md not found for track ${trackId}`,
    };
  }

  const content = fs.readFile(planPath);
  const mandatorySections = ["Proposed Architecture", "Requirements Mapping"];
  const missingSections: string[] = [];

  // 1. Check for mandatory sections
  for (const section of mandatorySections) {
    const sectionRegex = new RegExp(`^#+\\s+.*${section}.*`, "mi");
    if (!sectionRegex.test(content)) {
      missingSections.push(section);
    }
  }

  // 2. Check for reference to spec.md
  const specRefRegex = /\[.*spec\.md\]\(.*\)/i;
  const hasSpecRef = specRefRegex.test(content) || content.toLowerCase().includes("spec.md");

  const errors: string[] = [];
  if (missingSections.length > 0) {
    errors.push(...missingSections.map(s => `Section "${s}" is missing`));
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
