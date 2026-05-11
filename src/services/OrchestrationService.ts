import path from "node:path";
import {
  SDSStateMachine,
  SDSPhase,
  OrchestrationStatus,
  TransitionResult,
} from "./SDSStateMachine";
import { TrackMetadataService, TrackMetadata } from "./TrackMetadataService";
import { IFileSystem, IFilesystemWatcher } from "./interfaces/ICoreServices";
import { ValidationEngine } from "./ValidationEngine";
import { BootstrappingService } from "./BootstrappingService";
import { SessionManagerService } from "./SessionManagerService";

export type OrchestrationTrigger = "Auto" | "Manual" | "Override";

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
  private readonly validatingTracks = new Set<string>();

  private static readonly VALIDATION_TRANSITIONS = {
    pass: {
      newStatus: "HandoffReady" as OrchestrationStatus,
      comment: "All quality gates passed automatically.",
    },
    fail: {
      newStatus: "InProgress" as OrchestrationStatus,
      comment: "Quality gates failed after modification.",
    },
  } as const;

  constructor(
    private readonly trackMetadataService: TrackMetadataService,
    private readonly fs: IFileSystem,
    private readonly meridianDir: string,
    private readonly validationEngine?: ValidationEngine,
    private readonly watcher?: IFilesystemWatcher,
    private readonly bootstrappingService?: BootstrappingService,
    private readonly sessionManagerService?: SessionManagerService,
  ) {
    if (this.watcher && this.validationEngine) {
      this.setupAutoValidation();
    }
  }

  /**
   * Sets up file system watching to trigger validation automatically.
   */
  private setupAutoValidation() {
    this.watcher?.watch(
      path.join(this.meridianDir, "tracks"),
      (event: string, filePath: string) => {
        // Extract trackId from path: tracks/<trackId>/...
        const tracksDir = path.join(this.meridianDir, "tracks");
        const relative = path.relative(tracksDir, filePath);
        const segments = relative.split(path.sep);
        const trackId = segments[0];

        // Ensure we are watching a file inside a track directory, not the tracks dir itself
        const invalidTrackIds = new Set(["", ".", ".."]);
        if (invalidTrackIds.has(trackId) || segments.length <= 1) {
          return;
        }

        const eventHandlers: { [key: string]: (id: string) => Promise<void> } =
          {
            change: (id: string) => this.runAutoValidation(id),
            rename: (id: string) => this.runAutoValidation(id),
            FILE_SAVED: (id: string) => this.runAutoValidation(id),
          };

        eventHandlers[event]?.(trackId)?.catch((err: unknown) => {
          console.error(`Auto-validation failed for track ${trackId}:`, err);
        });
      },
    );
  }

  /**
   * Runs validation engine for the track's current phase.
   * If validation passes, updates status to 'HandoffReady'.
   */
  private getActiveMetadata(trackId: string): TrackMetadata | null {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    return metadata && metadata.status !== "Completed" ? metadata : null;
  }

  private async applyValidationResult(
    trackId: string,
    engine: ValidationEngine,
  ): Promise<void> {
    const metadata = this.getActiveMetadata(trackId);
    if (!metadata) return;

    const report = await engine.runValidation(
      trackId,
      metadata.orchestration.currentPhase,
    );

    // Re-fetch to avoid stale state after async validation
    const latestMetadata = this.getActiveMetadata(trackId);
    if (!latestMetadata) return;

    const key = report.overallSuccess ? "pass" : "fail";
    const action = OrchestrationService.VALIDATION_TRANSITIONS[key];
    if (action.newStatus !== latestMetadata.orchestration.status) {
      this.updateStatus(trackId, action.newStatus, action.comment);
    }
  }

  public async runAutoValidation(trackId: string): Promise<void> {
    if (!this.validationEngine || this.validatingTracks.has(trackId)) return;
    this.validatingTracks.add(trackId);
    try {
      await this.applyValidationResult(trackId, this.validationEngine);
    } finally {
      this.validatingTracks.delete(trackId);
    }
  }
  private assertForwardTransitionAllowed(
    currentPhase: SDSPhase,
    currentStatus: OrchestrationStatus,
    targetPhase: SDSPhase,
    trigger: OrchestrationTrigger,
  ) {
    const isForward =
      SDSStateMachine.getNextPhase(currentPhase) === targetPhase;
    if (
      isForward &&
      currentStatus !== "HandoffReady" &&
      trigger !== "Override"
    ) {
      throw new Error(
        `Cannot transition to ${targetPhase}: current phase ${currentPhase} must be in 'HandoffReady' status.`,
      );
    }
  }

  private assertValidationPassed(
    validation: TransitionResult,
    trigger: OrchestrationTrigger,
  ) {
    if (!validation.valid && trigger !== "Override") {
      throw new Error(validation.error ?? "Invalid transition");
    }
  }

  /**
   * Returns the absolute path to the track directory.
   */
  private getTrackDir(trackId: string): string {
    return path.join(this.meridianDir, "tracks", trackId);
  }

  /**
   * Appends an entry to the persistent orchestration log file.
   * This operation is synchronous and transactional.
   */
  private appendAuditLog(trackId: string, entry: OrchestrationLogEntry) {
    const logPath = path.join(this.getTrackDir(trackId), "orchestration.log");
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
    trigger: OrchestrationTrigger = "Manual",
  ): TrackMetadata {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    if (!metadata) {
      throw new Error(`Track ${trackId} not found.`);
    }

    const currentPhase = metadata.orchestration.currentPhase;
    const currentStatus = metadata.orchestration.status;

    const validation = SDSStateMachine.validateTransition(
      currentPhase,
      targetPhase,
    );
    this.assertForwardTransitionAllowed(
      currentPhase,
      currentStatus,
      targetPhase,
      trigger,
    );
    this.assertValidationPassed(validation, trigger);

    const newAgent = SDSStateMachine.getAssignedRole(targetPhase);
    const timestamp = new Date().toISOString();

    // Resolve instructions if bootstrapping service is available
    if (this.bootstrappingService) {
      this.bootstrappingService.resolve(newAgent);
    }

    // Assign agent if session manager is available
    if (this.sessionManagerService) {
      this.sessionManagerService.assignAgent(trackId, newAgent);
    }

    const logEntry: OrchestrationLogEntry = {
      timestamp,
      fromPhase: currentPhase,
      toPhase: targetPhase,
      status: "InProgress",
      agent: newAgent,
      message,
      trigger,
    };

    const updatedMetadata = this.trackMetadataService.updateTrackMetadata(
      trackId,
      {
        orchestration: {
          ...metadata.orchestration,
          currentPhase: targetPhase,
          status: "InProgress",
          assignedAgent: newAgent,
          handoffTimestamp: timestamp,
          logs: [logEntry, ...(metadata.orchestration.logs || [])].slice(0, 50),
        },
      },
    );

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
    trigger: OrchestrationTrigger = "Auto",
  ): TrackMetadata {
    const metadata = this.trackMetadataService.getTrackMetadata(trackId);
    if (!metadata) {
      throw new Error(`Track ${trackId} not found.`);
    }

    const timestamp = new Date().toISOString();
    const currentPhase = metadata.orchestration.currentPhase;

    const logEntry: OrchestrationLogEntry = {
      timestamp,
      toPhase: currentPhase,
      status,
      agent: metadata.orchestration.assignedAgent,
      message,
      trigger,
    };

    const updatedMetadata = this.trackMetadataService.updateTrackMetadata(
      trackId,
      {
        orchestration: {
          ...metadata.orchestration,
          status,
          logs: [logEntry, ...(metadata.orchestration.logs || [])].slice(0, 50),
        },
      },
    );

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
