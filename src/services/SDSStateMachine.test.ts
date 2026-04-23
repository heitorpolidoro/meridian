import { describe, it, expect } from 'vitest';
import { SDSStateMachine } from './SDSStateMachine';

describe('SDSStateMachine', () => {
  describe('validateTransition', () => {
    it.each([
      ['1.1', '1.2', true],
      ['3.1', '1.2', true],
      ['2.1', '2.1', true],
      ['1.1', '2.1', false, 'Cannot skip phases'],
      ['1.1', '5.0', false],
    ])('transition from %s to %s should be valid: %s', (from, to, expected, errorMsg?) => {
      const result = SDSStateMachine.validateTransition(from as any, to as any);
      expect(result.valid).toBe(expected);
      if (errorMsg) {
        expect(result.error).toContain(errorMsg);
      }
    });

    it('handles invalid phase strings gracefully', () => {
      // @ts-expect-error Testing runtime invalid input
      const result = SDSStateMachine.validateTransition('invalid' as SDSPhase, '1.1');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid phase detected.');
    });
  });

  describe('getNextPhase', () => {
    it.each([
      ['1.1', '1.2'],
      ['5.0', null],
    ])('getNextPhase(%s) -> %s', (current, expected) => {
      expect(SDSStateMachine.getNextPhase(current as any)).toBe(expected);
    });
  });

  describe('getAssignedRole', () => {
    it.each([
      ['1.1', 'product-manager'],
      ['1.2', 'software-architect'],
      ['2.1', 'software-architect'],
      ['3.1', 'software-engineer'],
      ['4.2', 'quality-assurance'],
      ['5.0', 'engineering-manager'],
      ['9.9', 'software-engineer'], // Fallback test
    ])('role for phase %s should be %s', (phase, role) => {
      expect(SDSStateMachine.getAssignedRole(phase as any)).toBe(role);
    });
  });
});
