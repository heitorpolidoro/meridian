import path from "node:path";
import {
  SDSStateMachine,
  SDSPhase,
  OrchestrationStatus,
} from "./SDSStateMachine";
import { TrackMetadataService, TrackMetadata } from "./TrackMetadataService";
import { IFileSystem, IFilesystemWatcher } from "./interfaces/ICoreServices";
import { ValidationEngine } from "./ValidationEngine";

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

  constructor(
    private readonly trackMetadataService: TrackMetadataService,
    private readonly fs: IFileSystem,
    private readonly meridianDir: string,
    private readonly validationEngine?: ValidationEngine,
    private readonly watcher?: IFilesystemWatcher,
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
        const isValidTrackDir =
          trackId && trackId !== "." && trackId !== ".." && segments.length > 1;

        const eventHandlers: { [key: string]: (id: string) => Promise<void> } = {
          change: (id: string) => this.runAutoValidation(id),
          rename: (id: string) => this.runAutoValidation(id),
          FILE_SAVED: (id: string) => this.runAutoValidation(id),
        };

        if (isValidTrackDir && eventHandlers[event]) {
          eventHandlers[event](trackId).catch((err: unknown) => {
            console.error(`Auto-validation failed for track ${trackId}:`, err);
          });
        }
      },
    );
  }

  /**
   * Runs validation engine for the track's current phase.
   * If validation passes, updates status to 'HandoffReady'.
   */
  public async runAutoValidation(trackId: string): Promise<void> {
    if (!this.validationEngine || this.validatingTracks.has(trackId)) return;

    this.validatingTracks.add(trackId);

    try {
      const metadata = this.trackMetadataService.getTrackMetadata(trackId);
      if (!metadata || metadata.orchestration.status === "Completed") return;

      const currentPhase = metadata.orchestration.currentPhase;
      const report = await this.validationEngine.runValidation(
        trackId,
        currentPhase,
      );

      // Re-fetch metadata to avoid race conditions with stale state after async validation
      const latestMetadata =
        this.trackMetadataService.getTrackMetadata(trackId);
      if (!latestMetadata || latestMetadata.status === "Completed") return;

      const currentStatus = latestMetadata.orchestration.status;

      const transitions: Record<string, [string, string]> = {
        success_notHandoffReady: [
          "HandoffReady",
          "All quality gates passed automatically.",
        ],
        failure_HandoffReady: [
          "InProgress",
          "Quality gates failed after modification.",
        ],
      };
      const transitionKey = report.overallSuccess
        ? currentStatus !== "HandoffReady"
          ? "success_notHandoffReady"
          : ""
        : !report.overallSuccess && currentStatus === "HandoffReady"
        ? "failure_HandoffReady"
        : "";
      if (transitionKey && transitions[transitionKey]) {
        const [newStatus, comment] = transitions[transitionKey];
        this.updateStatus(trackId, newStatus, comment);
      }
    } finally {
      this.validatingTracks.delete(trackId);
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

    // SDS Integrity Guard: Forward linear transitions MUST be in HandoffReady status
    // unless it is an explicit User Override.
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

    if (!validation.valid && trigger !== "Override") {
      throw new Error(validation.error || "Invalid transition");
    }

    const newAgent = SDSStateMachine.getAssignedRole(targetPhase);
    const timestamp = new Date().toISOString();

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
