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

export type QualityGateFn = (
  trackId: string,
  fs: IFileSystem,
  meridianDir: string,
) => Promise<ValidationResult>;

/**
 * ValidationEngine manages and executes quality gates for different SDS phases.
 * It maintains a registry of phase-specific validation functions and processes them.
 */
export class ValidationEngine {
  private gates: Map<SDSPhase, QualityGateFn[]> = new Map();

  /**
   * Creates a new ValidationEngine.
   *
   * @param fs - File system interface used by the engine.
   * @param meridianDir - Directory path for meridian resources.
   */
  constructor(
    private fs: IFileSystem,
    private meridianDir: string,
  ) {}

  /**
   * Registers a quality gate for a specific SDS phase.
   *
   * @param phase - The SDS phase to register the gate for.
   * @param gate - The quality gate function to execute during validation.
   */
  registerGate(phase: SDSPhase, gate: QualityGateFn): void {
    const phaseGates = this.gates.get(phase) || [];
    phaseGates.push(gate);
    this.gates.set(phase, phaseGates);
  }

  /**
   * Runs all quality gates registered for the given phase.
   *
   * @param trackId - Identifier for the current track.
   * @param phase - The SDS phase to validate.
   * @returns A ValidationReport containing the results of all gates.
   */
  async runValidation(
    trackId: string,
    phase: SDSPhase,
  ): Promise<ValidationReport> {
    const phaseGates = this.gates.get(phase) || [];

    const results: ValidationResult[] = await Promise.all(
      phaseGates.map(async (gate) => {
        try {
          return await gate(trackId, this.fs, this.meridianDir);
        } catch (error) {
          return {
            success: false,
            gateName: gate.name || "Quality Gate",
            message: `Unexpected error during validation: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    );

    const overallSuccess = results.every((r) => r.success);

    return {
      trackId,
      phase,
      overallSuccess,
      results,
    };
  }
}
