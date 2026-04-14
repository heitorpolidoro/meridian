import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TrackMetadataService } from './TrackMetadataService';
import { MockFileSystem } from './mocks/MockServices';
import path from 'node:path';

describe('TrackMetadataService', () => {
  let fs: MockFileSystem;
  let service: TrackMetadataService;
  const meridianDir = '/test/.meridian';

  beforeEach(() => {
    fs = new MockFileSystem();
    service = new TrackMetadataService(fs, meridianDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getTrackMetadata', () => {
    it('returns null if metadata does not exist', () => {
      expect(service.getTrackMetadata('track-1')).toBeNull();
    });

    it('returns parsed metadata if valid', () => {
      const metadataPath = path.join(meridianDir, 'tracks/track-1/metadata.json');
      const validData = {
        id: 'track-1',
        name: 'Track 1',
        status: 'Active',
        progress: 50,
        dates: { created: '2024-01-01T12:00:00.000Z', updated: '2024-01-01T12:00:00.000Z' }
      };
      fs.mkdir(path.dirname(metadataPath));
      fs.writeFile(metadataPath, JSON.stringify(validData));
      expect(service.getTrackMetadata('track-1')).toEqual(validData);
    });

    it('returns null if JSON is invalid', () => {
      const metadataPath = path.join(meridianDir, 'tracks/track-1/metadata.json');
      fs.mkdir(path.dirname(metadataPath));
      fs.writeFile(metadataPath, 'invalid json');
      expect(service.getTrackMetadata('track-1')).toBeNull();
    });

    it('returns null if schema validation fails', () => {
      const metadataPath = path.join(meridianDir, 'tracks/track-1/metadata.json');
      fs.mkdir(path.dirname(metadataPath));
      fs.writeFile(metadataPath, JSON.stringify({ invalid: 'data' }));
      expect(service.getTrackMetadata('track-1')).toBeNull();
    });
  });

  describe('updateTrackMetadata', () => {
    it('creates new metadata if it does not exist', () => {
      const result = service.updateTrackMetadata('track-1', { name: 'Track 1' });
      expect(result.id).toBe('track-1');
      expect(result.status).toBe('Draft');
      expect(result.progress).toBe(0);
      expect(fs.exists(path.join(meridianDir, 'tracks/track-1/metadata.json'))).toBe(true);
    });

    it('sets completed date when status changes to Completed', () => {
      service.updateTrackMetadata('track-1', { name: 'Track 1' });
      const result = service.updateTrackMetadata('track-1', { status: 'Completed' });
      expect(result.dates.completed).toBe('2024-01-01T12:00:00.000Z');
    });
  });

  describe('listTracksWithMetadata', () => {
    it('returns tracks and initializes missing metadata', () => {
      const tracksPath = path.join(meridianDir, 'tracks');
      fs.mkdir(tracksPath);
      fs.mkdir(path.join(tracksPath, 'track-1'));
      fs.mkdir(path.join(tracksPath, 'track-2'));
      
      const result = service.listTracksWithMetadata();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('track-1');
      expect(result[1].id).toBe('track-2');
    });
  });
});
