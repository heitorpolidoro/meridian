import { ITelemetryCollector } from './interfaces/ICoreServices';
import { TelemetryMetric, TelemetrySummary } from './IPCSchemas';

export class TelemetryCollectorService implements ITelemetryCollector {
  private metrics: TelemetryMetric[] = [];

  recordMetric(type: 'latency' | 'tokens' | 'errors', value: number, metadata?: any): void {
    this.metrics.push({
      type,
      value,
      timestamp: new Date().toISOString(),
      metadata,
    });
  }

  getSummary(): TelemetrySummary {
    const latencies = this.metrics
      .filter((m) => m.type === 'latency')
      .map((m) => m.value)
      .sort((a, b) => a - b);

    const totalTokens = this.metrics
      .filter((m) => m.type === 'tokens')
      .reduce((sum, m) => sum + m.value, 0);

    const errorCount = this.metrics.filter((m) => m.type === 'errors').length;
    const totalRequests = this.metrics.filter((m) => m.type === 'latency').length;

    return {
      p50Latency: this.calculatePercentile(latencies, 50),
      p95Latency: this.calculatePercentile(latencies, 95),
      totalTokens,
      errorRate: totalRequests > 0 ? errorCount / totalRequests : 0,
      history: this.metrics.slice(-100), // Last 100 metrics
    };
  }

  private calculatePercentile(sortedLatencies: number[], percentile: number): number {
    if (sortedLatencies.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedLatencies.length) - 1;
    return sortedLatencies[index];
  }

  // Helper for testing
  clearMetrics(): void {
    this.metrics = [];
  }
}
