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

  it('calculates 100% score using tasks.yaml instead of tasks.md', () => {
    const trackId = 'track-yaml';
    const trackPath = path.join(tracksDir, trackId);
    mockFileSystem.writeFile(path.join(trackPath, 'spec.md'), 'content');
    mockFileSystem.writeFile(path.join(trackPath, 'plan.md'), 'content');
    mockFileSystem.writeFile(path.join(trackPath, 'tasks.yaml'), 'content');

    const compliance = service.getCompliance(trackId);
    expect(compliance.score).toBe(100);
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

  it('provides the score via calculateScore', () => {
    const trackId = 'track-1';
    const trackPath = path.join(tracksDir, trackId);
    mockFileSystem.writeFile(path.join(trackPath, 'spec.md'), 'content');
    
    expect(service.calculateScore(trackId)).toBe(33);
  });

  it('returns all compliance data via getAllCompliance', () => {
    const trackIds = ['t1', 't2'];
    mockFileSystem.writeFile(path.join(tracksDir, 't1', 'spec.md'), 'content');
    
    const results = service.getAllCompliance(trackIds);
    expect(results).toHaveLength(2);
    expect(results[0].trackId).toBe('t1');
    expect(results[0].score).toBe(33);
    expect(results[1].trackId).toBe('t2');
    expect(results[1].score).toBe(0);
  });
});
