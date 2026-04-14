import React from 'react';
import './TelemetryDashboard.css';
import { TelemetrySummary, SDSCompliance, SyncConflict } from '../../services/IPCSchemas';

interface TelemetryDashboardProps {
  telemetry: TelemetrySummary | null;
  compliance: SDSCompliance[];
  conflicts: SyncConflict[];
}

export const TelemetryDashboard: React.FC<TelemetryDashboardProps> = ({
  telemetry,
  compliance,
  conflicts,
}) => {
  return (
    <div className="telemetry-dashboard">
      <section className="metrics-grid">
        <div className="metric-card">
          <label>p95 Latency</label>
          <div className="value">{telemetry?.p95Latency.toFixed(0) || 0}ms</div>
        </div>
        <div className="metric-card">
          <label>Total Tokens</label>
          <div className="value">{telemetry?.totalTokens.toLocaleString() || 0}</div>
        </div>
        <div className="metric-card">
          <label>Error Rate</label>
          <div className="value">{(telemetry?.errorRate || 0 * 100).toFixed(1)}%</div>
        </div>
        <div className="metric-card">
          <label>p50 Latency</label>
          <div className="value">{telemetry?.p50Latency.toFixed(0) || 0}ms</div>
        </div>
      </section>

      <section className="compliance-section">
        <h3>SDS Compliance</h3>
        <div className="compliance-list">
          {compliance.map((c) => (
            <div key={c.trackId} className="compliance-item">
              <div className="track-info">
                <span className="track-id">{c.trackId}</span>
                <span className="score-bar">
                  <div
                    className="score-fill"
                    style={{
                      width: `${c.score}%`,
                      backgroundColor: c.score > 80 ? '#00ff88' : c.score > 50 ? '#ffcc00' : '#ff4444',
                    }}
                  ></div>
                </span>
                <span className="score-value">{c.score}%</span>
              </div>
              <div className="details">
                <span className={c.details.hasSpec ? 'valid' : 'invalid'}>Spec</span>
                <span className={c.details.hasPlan ? 'valid' : 'invalid'}>Plan</span>
                <span className={c.details.hasTasks ? 'valid' : 'invalid'}>Tasks</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {conflicts.length > 0 && (
        <section className="conflicts-section">
          <h3>Sync Alerts</h3>
          <div className="conflicts-list">
            {conflicts.map((conflict, i) => (
              <div key={i} className={`conflict-item ${conflict.type}`}>
                <span className="timestamp">[{new Date(conflict.timestamp).toLocaleTimeString()}]</span>
                <span className="message">{conflict.message}</span>
                <span className="path">{conflict.path}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
