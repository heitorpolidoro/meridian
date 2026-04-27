import { IFileSystem } from "./interfaces/ICoreServices";
import { SDSPhase } from "./SDSStateMachine";

export interface ValidationResult {
  success: boolean;
  gateName: string;
  message: string;
  errors?: string[];
}

export interface ValidationReport {
  trackId: string;
  phase: SDSPhase;
  overallSuccess: boolean;
  results: ValidationResult[];
}

export type QualityGateFn = (trackId: string, fs: IFileSystem, meridianDir: string) => Promise<ValidationResult>;

export class ValidationEngine {
  private gates: Map<SDSPhase, QualityGateFn[]> = new Map();

  constructor(
    private fs: IFileSystem,
    private meridianDir: string
  ) {}

  /**
   * Registers a quality gate for a specific SDS phase.
   */
  registerGate(phase: SDSPhase, gate: QualityGateFn): void {
    const phaseGates = this.gates.get(phase) || [];
    phaseGates.push(gate);
    this.gates.set(phase, phaseGates);
  }

  /**
   * Runs all quality gates registered for the given phase.
   */
  async runValidation(trackId: string, phase: SDSPhase): Promise<ValidationReport> {
    const phaseGates = this.gates.get(phase) || [];
    const results: ValidationResult[] = [];

    for (const gate of phaseGates) {
      try {
        const result = await gate(trackId, this.fs, this.meridianDir);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          gateName: "Unknown Gate",
          message: `Unexpected error during validation: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const overallSuccess = results.every((r) => r.success);

    return {
      trackId,
      phase,
      overallSuccess,
      results,
    };
  }
}
