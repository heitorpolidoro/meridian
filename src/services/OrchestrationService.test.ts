import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrationService } from './OrchestrationService';
import { TrackMetadataService } from './TrackMetadataService';
import { SDSStateMachine } from './SDSStateMachine';
import { MockFileSystem } from './mocks/MockServices';
import path from 'node:path';

describe('OrchestrationService', () => {
  let fs: MockFileSystem;
  let metadataService: TrackMetadataService;
  let orchestrationService: OrchestrationService;
  const meridianDir = '/test/.meridian';

  beforeEach(() => {
    fs = new MockFileSystem();
    metadataService = new TrackMetadataService(fs, meridianDir);
    orchestrationService = new OrchestrationService(metadataService, fs, meridianDir);
    
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

    // Initialize a track
    metadataService.updateTrackMetadata('track-1', { name: 'Test Track' });
  });

  describe('requestTransition', () => {
    it('successfully transitions when status is HandoffReady', () => {
      // First set status to HandoffReady
      orchestrationService.updateStatus('track-1', 'HandoffReady');
      
      const updated = orchestrationService.requestTransition('track-1', '1.2', 'Moving to architecture');
      
      expect(updated.orchestration.currentPhase).toBe('1.2');
      expect(updated.orchestration.status).toBe('InProgress');
      
      // Verify audit log file
      const logPath = path.join(meridianDir, 'tracks/track-1/orchestration.log');
      expect(fs.exists(logPath)).toBe(true);
      
      // Check that trigger is preserved in metadata logs
      expect(updated.orchestration.logs[0].trigger).toBe('Manual');
    });

    it('blocks transition if status is not HandoffReady', () => {
      expect(() => orchestrationService.requestTransition('track-1', '1.2'))
        .toThrow(/must be in 'HandoffReady' status/);
    });

    it('blocks transition if it is an invalid SDS skip', () => {
      orchestrationService.updateStatus('track-1', 'HandoffReady');
      expect(() => orchestrationService.requestTransition('track-1', '3.1'))
        .toThrow(/Cannot skip phases/);
    });

    it('allows transition with Override even if not HandoffReady', () => {
      const updated = orchestrationService.requestTransition('track-1', '1.2', 'Urgent bypass', 'Override');
      expect(updated.orchestration.currentPhase).toBe('1.2');
      expect(updated.orchestration.logs[0].trigger).toBe('Override');
    });

    it('throws error for non-existent track', () => {
      expect(() => orchestrationService.requestTransition('non-existent', '1.2'))
        .toThrow('Track non-existent not found.');
    });

    it('allows invalid transition with Override', () => {
      // Linear skip 1.1 -> 3.1 is invalid, but allowed with Override
      const updated = orchestrationService.requestTransition('track-1', '3.1', 'Manual skip', 'Override');
      expect(updated.orchestration.currentPhase).toBe('3.1');
    });

    it('uses default error message if validation error is missing', () => {
      orchestrationService.updateStatus('track-1', 'HandoffReady');
      // Mock SDSStateMachine.validateTransition to return valid: false without error message
      const spy = vi.spyOn(SDSStateMachine, 'validateTransition').mockReturnValue({ valid: false });
      
      expect(() => orchestrationService.requestTransition('track-1', '1.2'))
        .toThrow('Invalid transition');
      
      spy.mockRestore();
    });

    it('handles missing logs array when updating metadata', () => {
      // 1. Get real metadata
      const realMetadata = metadataService.getTrackMetadata('track-1')!;
      
      // 2. Create a modified version without logs (corrupt/incomplete state)
      const corruptedMetadata = {
        ...realMetadata,
        orchestration: { ...realMetadata.orchestration }
      };
      // @ts-expect-error simulating missing property
      delete corruptedMetadata.orchestration.logs;

      // 3. Spy on getTrackMetadata to return our corrupted version once
      const spy = vi.spyOn(metadataService, 'getTrackMetadata')
        .mockReturnValue(corruptedMetadata as any);
      
      // 4. Update status - this should hit the (logs || []) branch
      const updated = orchestrationService.updateStatus('track-1', 'HandoffReady');
      
      // 5. Verify it worked (it will have 1 log entry because OrchestrationService prepends one)
      expect(updated.orchestration.logs).toHaveLength(1);
      
      spy.mockRestore();
    });

    it('handles missing logs array in requestTransition', () => {
      orchestrationService.updateStatus('track-1', 'HandoffReady');
      const corruptedMetadata = {
        ...metadataService.getTrackMetadata('track-1')!,
        orchestration: { ...metadataService.getTrackMetadata('track-1')!.orchestration }
      };
      // @ts-expect-error simulating missing property
      delete corruptedMetadata.orchestration.logs;

      const spy = vi.spyOn(metadataService, 'getTrackMetadata').mockReturnValue(corruptedMetadata as any);
      
      const updated = orchestrationService.requestTransition('track-1', '1.2');
      // Should have 1 entry (the one we just added)
      expect(updated.orchestration.logs).toHaveLength(1);
      
      spy.mockRestore();
    });

    it('aborts transition if audit log write fails (transactional integrity)', () => {
      // 1. Prepare status
      orchestrationService.updateStatus('track-1', 'HandoffReady');
      
      // 2. Mock appendFile to throw AFTER successful setup
      fs.appendFile = () => { throw new Error('Disk Full'); };
      
      // 3. Attempt transition
      expect(() => orchestrationService.requestTransition('track-1', '1.2'))
        .toThrow('Disk Full');
        
      // 4. Verify metadata was NOT updated (integrity check)
      const current = metadataService.getTrackMetadata('track-1');
      expect(current?.orchestration.currentPhase).toBe('1.1');
      expect(current?.orchestration.status).toBe('HandoffReady');
    });

    it('performs rollback on updateStatus if audit log fails', () => {
      // 1. Get initial state
      const originalMetadata = metadataService.getTrackMetadata('track-1');
      expect(originalMetadata).not.toBeNull();
      
      // 2. Mock appendFile to throw
      fs.appendFile = () => { throw new Error('I/O Error on updateStatus'); };
      
      // 3. Attempt status update (should throw and rollback)
      try {
        orchestrationService.updateStatus('track-1', 'HandoffReady');
        // If it doesn't throw, fail the test
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe('I/O Error on updateStatus');
      }
        
      // 4. Verify deep equality of the rolled back metadata
      const afterFail = metadataService.getTrackMetadata('track-1');
      expect(afterFail).toEqual(originalMetadata);
    });
  });

  describe('updateStatus', () => {
    it('updates status and appends to audit log', () => {
      orchestrationService.updateStatus('track-1', 'HandoffReady', 'Validation passed');
      orchestrationService.updateStatus('track-1', 'InProgress', 'Back to work');
      
      const logPath = path.join(meridianDir, 'tracks/track-1/orchestration.log');
      const logContent = fs.readFile(logPath).trim().split('\n');
      expect(logContent).toHaveLength(2);
      
      const secondEntry = JSON.parse(logContent[1]);
      expect(secondEntry.status).toBe('InProgress');
    });

    it('throws error for non-existent track in updateStatus', () => {
      expect(() => orchestrationService.updateStatus('non-existent', 'HandoffReady'))
        .toThrow('Track non-existent not found.');
    });
  });

  describe('getOrchestrationState', () => {
    it('returns null for non-existent track', () => {
      expect(orchestrationService.getOrchestrationState('none')).toBeNull();
    });

    it('returns null if metadata is invalid or missing', () => {
      // Simulate file corruption by writing invalid JSON directly to the mock storage
      fs.writeFile(path.join(meridianDir, 'tracks/track-corrupt/metadata.json'), 'invalid-json');
      expect(orchestrationService.getOrchestrationState('track-corrupt')).toBeNull();
    });

    it('returns orchestration state for valid track', () => {
      const state = orchestrationService.getOrchestrationState('track-1');
      expect(state?.currentPhase).toBe('1.1');
    });
  });
});
