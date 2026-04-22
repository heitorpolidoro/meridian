import path from 'node:path';
import { SDSStateMachine, SDSPhase, OrchestrationStatus } from './SDSStateMachine';
import { TrackMetadataService, TrackMetadata } from './TrackMetadataService';
import { IFileSystem } from './interfaces/ICoreServices';

export type OrchestrationTrigger = 'Auto' | 'Manual' | 'Override';

export interface OrchestrationLogEntry {
  timestamp: string;
  fromPhase?: SDSPhase;
  toPhase: SDSPhase;
  status: OrchestrationStatus;
  agent?: string;
  message?: string;
  trigger?: OrchestrationTrigger;
}

/**
 * Manages the SDS (Software Development Standard) orchestration flow for tracks.
 * Handles phase transitions, status updates, and transactional audit logging.
 */
export class OrchestrationService {
  constructor(
    private readonly trackMetadataService: TrackMetadataService,
    private readonly fs: IFileSystem,
    private readonly meridianDir: string
  ) {}

  /**
   * Returns the absolute path to the track directory.
   */
  private getTrackDir(trackId: string): string {
    return path.join(this.meridianDir, 'tracks', trackId);
  }

  /**
   * Appends an entry to the persistent orchestration log file.
   * This operation is synchronous and transactional.
   */
  private appendAuditLog(trackId: string, entry: OrchestrationLogEntry) {
    const logPath = path.join(this.getTrackDir(trackId), 'orchestration.log');
    const logLine = `${JSON.stringify(entry)}\n`;
    
    // We explicitly don't catch here so that a log failure blocks the transition (transactional integrity)
    this.fs.appendFile(logPath, logLine);
  }

  /**
   * Requests a phase transition for a specific track.
   * Ensures linear progression and transactional integrity.
   * 
   * @throws Error if track not found, transition invalid, or log fails.
   */
  requestTransition(
    trackId: string, 
    targetPhase: SDSPhase, 
    message?: string,
    trigger: OrchestrationTrigger = 'Manual'
  ): TrackMetadata {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    if (!metadata) {
      throw new Error(`Track ${trackId} not found.`);
    }

    const currentPhase = metadata.orchestration.currentPhase as SDSPhase;
    const currentStatus = metadata.orchestration.status as OrchestrationStatus;
    const validation = SDSStateMachine.validateTransition(currentPhase, targetPhase);

    // SDS Integrity Guard: Forward linear transitions MUST be in HandoffReady status
    // unless it is an explicit User Override.
    const isForward = SDSStateMachine.getNextPhase(currentPhase) === targetPhase;
    if (isForward && currentStatus !== 'HandoffReady' && trigger !== 'Override') {
      throw new Error(`Cannot transition to ${targetPhase}: current phase ${currentPhase} must be in 'HandoffReady' status.`);
    }

    if (!validation.valid && trigger !== 'Override') {
      throw new Error(validation.error || 'Invalid transition');
    }

    const newAgent = SDSStateMachine.getAssignedRole(targetPhase);
    const timestamp = new Date().toISOString();

    const logEntry: OrchestrationLogEntry = {
      timestamp,
      fromPhase: currentPhase,
      toPhase: targetPhase,
      status: 'InProgress',
      agent: newAgent,
      message,
      trigger
    };

    const updatedMetadata = this.trackMetadataService.updateTrackMetadata(trackId, {
      orchestration: {
        ...metadata.orchestration,
        currentPhase: targetPhase,
        status: 'InProgress',
        assignedAgent: newAgent,
        handoffTimestamp: timestamp,
        logs: [logEntry, ...(metadata.orchestration.logs || [])].slice(0, 50)
      }
    });

    // Persistent audit log file is written ONLY after metadata update succeeds
    try {
      this.appendAuditLog(trackId, logEntry);
    } catch (error) {
      // Rollback metadata if audit log fails to maintain atomic integrity
      this.trackMetadataService.updateTrackMetadata(trackId, metadata);
      throw error;
    }

    return updatedMetadata;
  }

  /**
   * Updates the orchestration status of a track without changing the phase.
   * 
   * @throws Error if track not found or log fails.
   */
  updateStatus(
    trackId: string, 
    status: OrchestrationStatus, 
    message?: string,
    trigger: OrchestrationTrigger = 'Auto'
  ): TrackMetadata {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    if (!metadata) {
      throw new Error(`Track ${trackId} not found.`);
    }

    const timestamp = new Date().toISOString();
    const currentPhase = metadata.orchestration.currentPhase as SDSPhase;

    const logEntry: OrchestrationLogEntry = {
      timestamp,
      toPhase: currentPhase,
      status,
      agent: metadata.orchestration.assignedAgent,
      message,
      trigger
    };

    const updatedMetadata = this.trackMetadataService.updateTrackMetadata(trackId, {
      orchestration: {
        ...metadata.orchestration,
        status,
        logs: [logEntry, ...(metadata.orchestration.logs || [])].slice(0, 50)
      }
    });

    // Persistent audit log file is written ONLY after metadata update succeeds
    try {
      this.appendAuditLog(trackId, logEntry);
    } catch (error) {
      // Rollback metadata if audit log fails
      this.trackMetadataService.updateTrackMetadata(trackId, metadata);
      throw error;
    }

    return updatedMetadata;
  }

  /**
   * Gets the current orchestration state for a track.
   */
  getOrchestrationState(trackId: string) {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    return metadata?.orchestration || null;
  }
}
