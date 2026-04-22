import { describe, it, expect } from 'vitest';
import { SDSStateMachine } from './SDSStateMachine';

describe('SDSStateMachine', () => {
  describe('validateTransition', () => {
    it('allows linear transition (1.1 -> 1.2)', () => {
      const result = SDSStateMachine.validateTransition('1.1', '1.2');
      expect(result.valid).toBe(true);
    });

    it('allows jumping back for re-work (3.1 -> 1.2)', () => {
      const result = SDSStateMachine.validateTransition('3.1', '1.2');
      expect(result.valid).toBe(true);
    });

    it('allows same-phase transition (2.1 -> 2.1)', () => {
      const result = SDSStateMachine.validateTransition('2.1', '2.1');
      expect(result.valid).toBe(true);
    });

    it('prevents skipping phases (1.1 -> 2.1)', () => {
      const result = SDSStateMachine.validateTransition('1.1', '2.1');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Cannot skip phases');
    });

    it('prevents skipping to the end (1.1 -> 5.0)', () => {
      const result = SDSStateMachine.validateTransition('1.1', '5.0');
      expect(result.valid).toBe(false);
    });

    it('handles invalid phase strings gracefully', () => {
      // @ts-expect-error Testing runtime invalid input
      const result = SDSStateMachine.validateTransition('invalid' as SDSPhase, '1.1');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid phase detected.');
    });
  });

  describe('getNextPhase', () => {
    it('returns 1.2 for 1.1', () => {
      expect(SDSStateMachine.getNextPhase('1.1')).toBe('1.2');
    });

    it('returns null for the final phase 5.0', () => {
      expect(SDSStateMachine.getNextPhase('5.0')).toBeNull();
    });
  });

  describe('getAssignedRole', () => {
    it('returns product-manager for phase 1.1', () => {
      expect(SDSStateMachine.getAssignedRole('1.1')).toBe('product-manager');
    });

    it('returns software-architect for phase 1.2', () => {
      expect(SDSStateMachine.getAssignedRole('1.2')).toBe('software-architect');
    });

    it('returns software-engineer for phase 3.1', () => {
      expect(SDSStateMachine.getAssignedRole('3.1')).toBe('software-engineer');
    });

    it('returns quality-assurance for phase 4.2', () => {
      expect(SDSStateMachine.getAssignedRole('4.2')).toBe('quality-assurance');
    });

    it('returns engineering-manager for phase 5.0', () => {
      expect(SDSStateMachine.getAssignedRole('5.0')).toBe('engineering-manager');
    });

    it('returns software-engineer for unknown/default phases', () => {
      // @ts-expect-error Testing fallback
      expect(SDSStateMachine.getAssignedRole('9.9' as SDSPhase)).toBe('software-engineer');
    });
  });
});
