import { ISDSComplianceScorer } from "../interfaces/ICoreServices";
import { QualityGateFn, ValidationResult } from "../ValidationEngine";

/**
 * Creates a quality gate function that evaluates SDS compliance for a given track ID using the provided scorer.
 * @param {ISDSComplianceScorer} scorer - The scorer used to calculate the SDS compliance score.
 * @returns {QualityGateFn} A function that takes a track ID and returns a ValidationResult indicating compliance.
 */
export const createCodeGate = (scorer: ISDSComplianceScorer): QualityGateFn => {
  return (trackId: string): Promise<ValidationResult> => {
    const score = scorer.calculateScore(trackId);

    if (score < 100) {
      return Promise.resolve({
        success: false,
        gateName: "CodeGate",
        message: `SDS Compliance Score is only ${score}%. It must be 100% (Full coverage and no lint errors) to proceed.`,
      });
    }

    return Promise.resolve({
      success: true,
      gateName: "CodeGate",
      message: "SDS Compliance Score is 100%. All quality standards met.",
    });
  };
};
