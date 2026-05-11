import React, { useState } from "react";
import type { Socket } from "socket.io-client";
import "./OrchestrationPanel.css";
import { SDSPhase, SDS_PHASES } from "../../services/SDSStateMachine";

interface OrchestrationLog {
  timestamp: string;
  fromPhase?: SDSPhase;
  toPhase: SDSPhase;
  status: string;
  agent?: string;
  message?: string;
  trigger?: "Auto" | "Manual" | "Override";
}

interface OrchestrationPanelProps {
  trackId: string;
  metadata: {
    orchestration: {
      currentPhase: SDSPhase;
      status: string;
      logs: OrchestrationLog[];
    };
  };
  socket: Socket;
}

const PHASE_LABELS: Record<SDSPhase, string> = {
  "1.1": "Spec",
  "1.2": "Plan",
  "2.1": "Tasks",
  "3.1": "Dev",
  "4.2": "QA",
  "5.0": "Done",
};

/** Renders the SDS Orchestration panel for a given track. */
export const OrchestrationPanel: React.FC<OrchestrationPanelProps> = ({
  trackId,
  metadata,
  socket,
}) => {
  const [showLogs, setShowLogs] = useState(false);
  const [showOverrideDialog, setShowOverrideDialog] = useState(false);
  const [overridePhaseInput, setOverridePhaseInput] = useState("");
  const { currentPhase, status, logs } = metadata.orchestration;

  const currentPhaseIndex = SDS_PHASES.indexOf(currentPhase);

  /** Approves the handoff to the next phase. */
  const handleApprove = () => {
    const nextPhaseIndex = currentPhaseIndex + 1;
    if (nextPhaseIndex < SDS_PHASES.length) {
      socket.emit("orchestration:request-transition", {
        trackId,
        targetPhase: SDS_PHASES[nextPhaseIndex],
        trigger: "Manual",
      });
    }
  };

  /** Opens the force override dialog. */
  const handleOverride = () => {
    setOverridePhaseInput(currentPhase);
    setShowOverrideDialog(true);
  };

  const handleConfirmOverride = () => {
    if (SDS_PHASES.includes(overridePhaseInput as SDSPhase)) {
      socket.emit("orchestration:request-transition", {
        trackId,
        targetPhase: overridePhaseInput,
        trigger: "Override",
      });
    }
    setShowOverrideDialog(false);
  };

  return (
    <div className="orchestration-panel">
      <div className="orchestration-header">
        <h3>SDS Orchestration</h3>
        <div className="orchestration-actions">
          {status === "HandoffReady" && (
            <button className="action-btn btn-approve" onClick={handleApprove}>
              Approve Handoff
            </button>
          )}
          <button className="action-btn btn-override" onClick={handleOverride}>
            Force Override
          </button>
        </div>
      </div>

      {showOverrideDialog && (
        <div className="override-dialog">
          <label htmlFor="override-phase-input">Force override to phase:</label>
          <input
            id="override-phase-input"
            value={overridePhaseInput}
            onChange={(e) => setOverridePhaseInput(e.target.value)}
          />
          <button onClick={handleConfirmOverride}>Confirm</button>
          <button onClick={() => setShowOverrideDialog(false)}>Cancel</button>
        </div>
      )}

      <div className="phase-stepper">
        {SDS_PHASES.map((phase, index) => {
          let stateClass = "locked";
          if (index < currentPhaseIndex) stateClass = "completed";
          else if (index === currentPhaseIndex) {
            stateClass = status === "HandoffReady" ? "handoff-ready" : "active";
          }

          return (
            <div key={phase} className={`phase-item ${stateClass}`}>
              <div className="phase-dot" title={`Phase ${phase}`} />
              <span className="phase-label">{PHASE_LABELS[phase]}</span>
            </div>
          );
        })}
      </div>

      <div className="logs-container">
        <div className="logs-header" onClick={() => setShowLogs(!showLogs)}>
          <span>{showLogs ? "▼" : "▶"} Orchestration Logs</span>
          <span style={{ fontSize: "0.7rem" }}>({logs.length} entries)</span>
        </div>
        {showLogs && (
          <div className="logs-list">
            {logs.length === 0 ? (
              <div className="log-entry">No logs recorded.</div>
            ) : (
              logs
                .slice()
                .reverse()
                .map((log) => (
                  <div key={log.timestamp} className="log-entry">
                    <span className="log-timestamp">
                      [{new Date(log.timestamp).toLocaleTimeString()}]
                    </span>
                    <span className="log-transition">
                      {log.fromPhase ? `${PHASE_LABELS[log.fromPhase]} → ` : ""}
                      {PHASE_LABELS[log.toPhase]}
                    </span>
                    <span className="log-message">
                      {log.message || log.status}
                    </span>
                  </div>
                ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
