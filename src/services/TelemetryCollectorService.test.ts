import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryCollectorService } from './TelemetryCollectorService';

describe('TelemetryCollectorService', () => {
  let service: TelemetryCollectorService;

  beforeEach(() => {
    service = new TelemetryCollectorService();
  });

  it('records metrics and provides summary', () => {
    service.recordMetric('latency', 100);
    service.recordMetric('latency', 200);
    service.recordMetric('tokens', 500);
    service.recordMetric('errors', 1);

    const summary = service.getSummary();
    expect(summary.totalTokens).toBe(500);
    expect(summary.p50Latency).toBe(100);
    expect(summary.p95Latency).toBe(200);
  });

  it('calculates error rate correctly', () => {
    service.recordMetric('latency', 100);
    service.recordMetric('latency', 100);
    service.recordMetric('errors', 1);

    const summary = service.getSummary();
    expect(summary.errorRate).toBe(0.5);
  });

  it('handles empty metrics gracefully', () => {
    const summary = service.getSummary();
    expect(summary.totalTokens).toBe(0);
    expect(summary.p50Latency).toBe(0);
    expect(summary.errorRate).toBe(0);
  });
});
