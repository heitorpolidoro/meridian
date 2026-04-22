import path from 'node:path';
import { z } from 'zod';
import { IFileSystem } from './interfaces/ICoreServices';

export const TrackStatusSchema = z.enum(['Draft', 'Active', 'Completed', 'Archived']);

export const SDSPhaseSchema = z.enum(['1.1', '1.2', '2.1', '3.1', '4.2', '5.0']);
export const OrchestrationStatusSchema = z.enum(['Idle', 'InProgress', 'HandoffReady', 'Failed']);

export const OrchestrationSchema = z.object({
  currentPhase: SDSPhaseSchema.default('1.1'),
  status: OrchestrationStatusSchema.default('Idle'),
  assignedAgent: z.string().optional(),
  handoffTimestamp: z.string().optional(),
  logs: z.array(z.object({
    timestamp: z.string(),
    fromPhase: SDSPhaseSchema.optional(),
    toPhase: SDSPhaseSchema,
    status: OrchestrationStatusSchema,
    agent: z.string().optional(),
    message: z.string().optional(),
    trigger: z.enum(['Auto', 'Manual', 'Override']).optional()
  })).default([])
});

export const TrackMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: TrackStatusSchema.default('Draft'),
  owner: z.string().optional(),
  progress: z.number().min(0).max(100).default(0),
  dates: z.object({
    created: z.string(),
    updated: z.string(),
    completed: z.string().optional()
  }).default({
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  }),
  orchestration: OrchestrationSchema.default({
    currentPhase: '1.1',
    status: 'Idle',
    logs: []
  })
});

export type TrackMetadata = z.infer<typeof TrackMetadataSchema>;

export class TrackMetadataService {
  private readonly TRACKS_DIR = 'tracks';

  constructor(private fs: IFileSystem, private meridianDir: string) {}

  private getTracksPath(): string {
    return path.join(this.meridianDir, this.TRACKS_DIR);
  }

  private getTrackPath(trackId: string): string {
    return path.join(this.getTracksPath(), trackId);
  }

  private getMetadataPath(trackId: string): string {
    return path.join(this.getTrackPath(trackId), 'metadata.json');
  }

  getTrackMetadata(trackId: string): TrackMetadata | null {
    const metadataPath = this.getMetadataPath(trackId);
    if (!this.fs.exists(metadataPath)) return null;

    try {
      const content = this.fs.readFile(metadataPath);
      const parsed = JSON.parse(content);
      const result = TrackMetadataSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  updateTrackMetadata(trackId: string, data: Partial<TrackMetadata>): TrackMetadata {
    const trackPath = this.getTrackPath(trackId);
    if (!this.fs.exists(trackPath)) {
      this.fs.mkdir(trackPath);
    }

    const currentMetadata = this.getTrackMetadata(trackId) || {
      id: trackId,
      name: trackId,
      status: 'Draft' as const,
      progress: 0,
      dates: {
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      }
    };

    const updatedMetadata = {
      ...currentMetadata,
      ...data,
      id: trackId,
      dates: {
        ...currentMetadata.dates,
        ...(data.dates || {}),
        updated: new Date().toISOString()
      }
    };

    if (updatedMetadata.status === 'Completed' && currentMetadata.status !== 'Completed') {
      updatedMetadata.dates.completed = new Date().toISOString();
    } else if (updatedMetadata.status !== 'Completed') {
      const { completed: _, ...remainingDates } = updatedMetadata.dates;
      updatedMetadata.dates = remainingDates;
    }

    const parsed = TrackMetadataSchema.parse(updatedMetadata);
    this.fs.writeFile(this.getMetadataPath(trackId), JSON.stringify(parsed, null, 2));

    return parsed;
  }

  listTracksWithMetadata(): TrackMetadata[] {
    const tracksPath = this.getTracksPath();
    if (!this.fs.exists(tracksPath)) return [];

    const directories = this.fs.readDirectory(tracksPath).filter(file => {
      return this.fs.isDirectory(path.join(tracksPath, file)) && !file.startsWith('.');
    });

    return directories.reduce((acc: TrackMetadata[], trackId) => {
      const metadata = this.getTrackMetadata(trackId);
      if (metadata) {
        acc.push(metadata);
      } else {
        const created = this.updateTrackMetadata(trackId, {
          name: trackId,
          status: 'Draft',
          progress: 0
        });
        acc.push(created);
      }
      return acc;
    }, []);
  }
}
