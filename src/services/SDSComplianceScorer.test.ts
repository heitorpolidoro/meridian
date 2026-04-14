import { describe, it, expect, beforeEach } from 'vitest';
import { SDSComplianceScorer } from './SDSComplianceScorer';
import { MockFileSystem } from './mocks/MockFileSystem';
import path from 'node:path';

describe('SDSComplianceScorer', () => {
  let service: SDSComplianceScorer;
  let mockFileSystem: MockFileSystem;
  const tracksDir = '/tracks';

  beforeEach(() => {
    mockFileSystem = new MockFileSystem();
    service = new SDSComplianceScorer(mockFileSystem, tracksDir);
  });

  it('calculates 100% score when all SDS files exist', () => {
    const trackId = 'track-1';
    const trackPath = path.join(tracksDir, trackId);
    mockFileSystem.writeFile(path.join(trackPath, 'spec.md'), 'content');
    mockFileSystem.writeFile(path.join(trackPath, 'plan.md'), 'content');
    mockFileSystem.writeFile(path.join(trackPath, 'tasks.md'), 'content');

    const compliance = service.getCompliance(trackId);
    expect(compliance.score).toBe(100);
    expect(compliance.details.hasSpec).toBe(true);
    expect(compliance.details.hasPlan).toBe(true);
    expect(compliance.details.hasTasks).toBe(true);
  });

  it('calculates 33% score when only one file exists', () => {
    const trackId = 'track-1';
    const trackPath = path.join(tracksDir, trackId);
    mockFileSystem.writeFile(path.join(trackPath, 'spec.md'), 'content');

    const compliance = service.getCompliance(trackId);
    expect(compliance.score).toBe(33);
    expect(compliance.details.hasSpec).toBe(true);
    expect(compliance.details.hasPlan).toBe(false);
  });

  it('calculates 0% score when no files exist', () => {
    const trackId = 'track-1';
    const compliance = service.getCompliance(trackId);
    expect(compliance.score).toBe(0);
  });
});
