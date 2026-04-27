import { ISDSComplianceScorer } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";

export const createCodeGate = (scorer: ISDSComplianceScorer): QualityGateFn => {
  return async (trackId: string): Promise<ValidationResult> => {
    const score = scorer.calculateScore(trackId);

    if (score < 100) {
      return {
        success: false,
        gateName: "CodeGate",
        message: `SDS Compliance Score is only ${score}%. It must be 100% (Full coverage and no lint errors) to proceed.`,
      };
    }

    return {
      success: true,
      gateName: "CodeGate",
      message: "SDS Compliance Score is 100%. All quality standards met.",
    };
  };
};
