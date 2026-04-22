import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrationService } from './OrchestrationService';
import { TrackMetadataService } from './TrackMetadataService';
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
    it('successfully transitions when status is HandoffReady', async () => {
      // First set status to HandoffReady
      await orchestrationService.updateStatus('track-1', 'HandoffReady');
      
      const updated = await orchestrationService.requestTransition('track-1', '1.2', 'Moving to architecture');
      
      expect(updated.orchestration.currentPhase).toBe('1.2');
      expect(updated.orchestration.status).toBe('InProgress');
      
      // Verify audit log file
      const logPath = path.join(meridianDir, 'tracks/track-1/orchestration.log');
      expect(fs.exists(logPath)).toBe(true);
      
      // Check that trigger is preserved in metadata logs
      expect(updated.orchestration.logs[0].trigger).toBe('Manual');
    });

    it('blocks transition if status is not HandoffReady', async () => {
      await expect(orchestrationService.requestTransition('track-1', '1.2'))
        .rejects.toThrow(/must be in 'HandoffReady' status/);
    });

    it('allows transition with Override even if not HandoffReady', async () => {
      const updated = await orchestrationService.requestTransition('track-1', '1.2', 'Urgent bypass', 'Override');
      expect(updated.orchestration.currentPhase).toBe('1.2');
      expect(updated.orchestration.logs[0].trigger).toBe('Override');
    });

    it('throws error for non-existent track', async () => {
      await expect(orchestrationService.requestTransition('non-existent', '1.2'))
        .rejects.toThrow('Track non-existent not found.');
    });

    it('aborts transition if audit log write fails (transactional integrity)', async () => {
      // 1. Prepare status
      await orchestrationService.updateStatus('track-1', 'HandoffReady');
      
      // 2. Mock appendFile to throw AFTER successful setup
      fs.appendFile = () => { throw new Error('Disk Full'); };
      
      // 3. Attempt transition
      await expect(orchestrationService.requestTransition('track-1', '1.2'))
        .rejects.toThrow('Disk Full');
        
      // 4. Verify metadata was NOT updated (integrity check)
      const current = metadataService.getTrackMetadata('track-1');
      expect(current?.orchestration.currentPhase).toBe('1.1');
    });
  });

  describe('updateStatus', () => {
    it('updates status and appends to audit log', async () => {
      await orchestrationService.updateStatus('track-1', 'HandoffReady', 'Validation passed');
      await orchestrationService.updateStatus('track-1', 'InProgress', 'Back to work');
      
      const logPath = path.join(meridianDir, 'tracks/track-1/orchestration.log');
      const logContent = fs.readFile(logPath).trim().split('\n');
      expect(logContent).toHaveLength(2);
      
      const secondEntry = JSON.parse(logContent[1]);
      expect(secondEntry.status).toBe('InProgress');
    });
  });

  describe('getOrchestrationState', () => {
    it('returns null for non-existent track', () => {
      expect(orchestrationService.getOrchestrationState('none')).toBeNull();
    });

    it('returns orchestration state for valid track', () => {
      const state = orchestrationService.getOrchestrationState('track-1');
      expect(state?.currentPhase).toBe('1.1');
    });
  });
});
