import { ISDSComplianceScorer, IFileSystem } from './interfaces/ICoreServices';
import { SDSCompliance } from './IPCSchemas';
import path from 'node:path';

export class SDSComplianceScorer implements ISDSComplianceScorer {
  constructor(private fileSystem: IFileSystem, private tracksDir: string) {}

  calculateScore(trackId: string): number {
    const compliance = this.getCompliance(trackId);
    return compliance.score;
  }

  getCompliance(trackId: string): SDSCompliance {
    const trackPath = path.join(this.tracksDir, trackId);
    
    const hasSpec = this.fileSystem.exists(path.join(trackPath, 'spec.md'));
    const hasPlan = this.fileSystem.exists(path.join(trackPath, 'plan.md'));
    const hasTasks = this.fileSystem.exists(path.join(trackPath, 'tasks.md'));

    const components = [hasSpec, hasPlan, hasTasks];
    const presentCount = components.filter(Boolean).length;
    const score = Math.round((presentCount / components.length) * 100);

    return {
      trackId,
      score,
      details: {
        hasSpec,
        hasPlan,
        hasTasks,
      },
    };
  }

  getAllCompliance(trackIds: string[]): SDSCompliance[] {
    return trackIds.map((id) => this.getCompliance(id));
  }
}
