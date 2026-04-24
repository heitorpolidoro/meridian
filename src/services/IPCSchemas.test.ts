import { describe, it, expect } from 'vitest';
import {
  TelemetryMetricSchema,
  TelemetrySummarySchema,
  SDSComplianceSchema,
  SyncConflictSchema,
  IPCEventSchema,
} from './IPCSchemas';

describe('IPCSchemas', () => {
  describe('TelemetryMetricSchema', () => {
    it('validates a correct metric', () => {
      const metric = {
        type: 'latency',
        value: 100,
        timestamp: new Date().toISOString(),
        metadata: { info: 'test' },
      };
      const result = TelemetryMetricSchema.safeParse(metric);
      expect(result.success).toBe(true);
    });

    it('fails with an invalid type', () => {
      const metric = {
        type: 'invalid',
        value: 100,
        timestamp: new Date().toISOString(),
      };
      const result = TelemetryMetricSchema.safeParse(metric);
      expect(result.success).toBe(false);
    });
  });

  describe('TelemetrySummarySchema', () => {
    it('validates a correct summary', () => {
      const summary = {
        p50Latency: 50,
        p95Latency: 95,
        totalTokens: 1000,
        errorRate: 0.1,
        history: [
          { type: 'tokens', value: 500, timestamp: new Date().toISOString() },
        ],
      };
      const result = TelemetrySummarySchema.safeParse(summary);
      expect(result.success).toBe(true);
    });

    it('fails if history is missing', () => {
      const summary = {
        p50Latency: 50,
        p95Latency: 95,
        totalTokens: 1000,
        errorRate: 0.1,
      };
      const result = TelemetrySummarySchema.safeParse(summary);
      expect(result.success).toBe(false);
    });
  });

  describe('SDSComplianceSchema', () => {
    it('validates correct compliance data', () => {
      const compliance = {
        trackId: 'track-1',
        score: 85,
        details: {
          hasSpec: true,
          hasPlan: true,
          hasTasks: false,
        },
      };
      const result = SDSComplianceSchema.safeParse(compliance);
      expect(result.success).toBe(true);
    });
  });

  describe('SyncConflictSchema', () => {
    it('validates a correct conflict report', () => {
      const conflict = {
        path: 'src/main.ts',
        type: 'conflict',
        message: 'Merge conflict',
        timestamp: new Date().toISOString(),
      };
      const result = SyncConflictSchema.safeParse(conflict);
      expect(result.success).toBe(true);
    });

    it('fails with invalid conflict type', () => {
      const conflict = {
        path: 'src/main.ts',
        type: 'unknown_type',
        message: 'Merge conflict',
        timestamp: new Date().toISOString(),
      };
      const result = SyncConflictSchema.safeParse(conflict);
      expect(result.success).toBe(false);
    });
  });

  describe('IPCEventSchema', () => {
    it('validates a telemetry-update event', () => {
      const event = {
        event: 'telemetry-update',
        data: {
          p50Latency: 50,
          p95Latency: 95,
          totalTokens: 100,
          errorRate: 0,
          history: [],
        },
      };
      const result = IPCEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('validates a compliance-update event', () => {
      const event = {
        event: 'compliance-update',
        data: [
          {
            trackId: '01',
            score: 100,
            details: { hasSpec: true, hasPlan: true, hasTasks: true },
          },
        ],
      };
      const result = IPCEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('validates a sync-conflict event', () => {
      const event = {
        event: 'sync-conflict',
        data: {
          path: 'README.md',
          type: 'manual_change',
          message: 'User modified file',
          timestamp: new Date().toISOString(),
        },
      };
      const result = IPCEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('fails with an unknown event name', () => {
      const event = {
        event: 'invalid-event',
        data: {},
      };
      const result = IPCEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });
});
