import { IFileSystem } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";
import path from "node:path";

export const SpecGate: QualityGateFn = async (trackId: string, fs: IFileSystem, meridianDir: string): Promise<ValidationResult> => {
  const specPath = path.join(meridianDir, "tracks", trackId, "spec.md");
  
  if (!fs.exists(specPath)) {
    return {
      success: false,
      gateName: "SpecGate",
      message: `spec.md not found for track ${trackId}`,
    };
  }

  const content = fs.readFile(specPath);
  const mandatorySections = ["Problem Statement", "Audience", "Success Criteria"];
  const missingSections: string[] = [];

  for (const section of mandatorySections) {
    // Regex matches Markdown headers (level 1-6) containing the section name
    const sectionRegex = new RegExp(`^#+\\s+.*${section}.*`, "mi");
    if (!sectionRegex.test(content)) {
      missingSections.push(section);
    }
  }

  if (missingSections.length > 0) {
    return {
      success: false,
      gateName: "SpecGate",
      message: "Missing mandatory sections in spec.md",
      errors: missingSections.map(s => `Section "${s}" is missing`),
    };
  }

  return {
    success: true,
    gateName: "SpecGate",
    message: "spec.md contains all mandatory sections",
  };
};
