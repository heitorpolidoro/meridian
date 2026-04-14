import { z } from 'zod';

export const TelemetryMetricSchema = z.object({
  type: z.enum(['latency', 'tokens', 'errors']),
  value: z.number(),
  timestamp: z.string(),
  metadata: z.record(z.any()).optional(),
});

export const TelemetrySummarySchema = z.object({
  p50Latency: z.number(),
  p95Latency: z.number(),
  totalTokens: z.number(),
  errorRate: z.number(),
  history: z.array(TelemetryMetricSchema),
});

export const SDSComplianceSchema = z.object({
  trackId: z.string(),
  score: z.number(),
  details: z.object({
    hasSpec: z.boolean(),
    hasPlan: z.boolean(),
    hasTasks: z.boolean(),
  }),
});

export const SyncConflictSchema = z.object({
  path: z.string(),
  type: z.enum(['manual_change', 'agent_change', 'conflict']),
  message: z.string(),
  timestamp: z.string(),
});

export const IPCEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('telemetry-update'), data: TelemetrySummarySchema }),
  z.object({ event: z.literal('compliance-update'), data: z.array(SDSComplianceSchema) }),
  z.object({ event: z.literal('sync-conflict'), data: SyncConflictSchema }),
]);

export type TelemetryMetric = z.infer<typeof TelemetryMetricSchema>;
export type TelemetrySummary = z.infer<typeof TelemetrySummarySchema>;
export type SDSCompliance = z.infer<typeof SDSComplianceSchema>;
export type SyncConflict = z.infer<typeof SyncConflictSchema>;
export type IPCEvent = z.infer<typeof IPCEventSchema>;
