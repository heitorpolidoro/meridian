export const SDS_PHASES = ['1.1', '1.2', '2.1', '3.1', '4.2', '5.0'] as const;
export type SDSPhase = (typeof SDS_PHASES)[number];

export const ORCHESTRATION_STATUS = ['Idle', 'InProgress', 'HandoffReady', 'Failed'] as const;
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUS)[number];

export interface TransitionResult {
  valid: boolean;
  error?: string;
}

/**
 * Hierarchical State Machine (HSM) logic for the 
 * Software Development Standard (SDS) phases.
 */
export const SDSStateMachine = {
  /**
   * Defines the linear progression of SDS phases.
   */
  PHASE_ORDER: [...SDS_PHASES] as SDSPhase[],

  /**
   * Validates if a transition from one phase to another is allowed.
   * Standard SDS flow is linear, but we allow jumping back to any previous phase (re-work)
   * or moving to the immediate next phase.
   */
  validateTransition(from: SDSPhase, to: SDSPhase): TransitionResult {
    const fromIndex = this.PHASE_ORDER.indexOf(from);
    const toIndex = this.PHASE_ORDER.indexOf(to);

    if (fromIndex === -1 || toIndex === -1) {
      return { valid: false, error: 'Invalid phase detected.' };
    }

    // Allow moving backwards (re-work/re-planning) or staying in the same phase
    if (toIndex <= fromIndex) {
      return { valid: true };
    }

    // Allow moving to the immediate next phase
    if (toIndex === fromIndex + 1) {
      return { valid: true };
    }

    // Disallow skipping phases
    return { 
      valid: false, 
      error: `Cannot skip phases. Must transition from ${from} to ${this.PHASE_ORDER[fromIndex + 1]} before reaching ${to}.` 
    };
  },

  /**
   * Gets the next logical phase in the SDS process.
   */
  getNextPhase(current: SDSPhase): SDSPhase | null {
    const currentIndex = this.PHASE_ORDER.indexOf(current);
    if (currentIndex === -1 || currentIndex === this.PHASE_ORDER.length - 1) {
      return null;
    }
    return this.PHASE_ORDER[currentIndex + 1];
  },

  /**
   * Determines the assigned agent role based on the SDS phase.
   */
  getAssignedRole(phase: SDSPhase): string {
    switch (phase) {
      case '1.1': return 'product-manager';
      case '1.2': return 'software-architect';
      case '2.1': return 'software-architect';
      case '3.1': return 'software-engineer';
      case '4.2': return 'quality-assurance';
      case '5.0': return 'engineering-manager';
      default: return 'software-engineer';
    }
  }
};
