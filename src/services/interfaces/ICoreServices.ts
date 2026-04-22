import type { TelemetrySummary } from '../IPCSchemas';

export interface IFileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  appendFile(path: string, content: string): void; // Added for performance logging
  deleteFile(path: string): void;
  exists(path: string): boolean;
  readDirectory(path: string): string[];
  isDirectory(path: string): boolean;
  mkdir(path: string): void;
}

export interface IShell {
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface IContextInjectionService {
  isForbidden(filePath: string): boolean;
  injectTrackContext(trackId: string): string;
}

export interface ITelemetryCollector {
  recordMetric(type: 'latency' | 'tokens' | 'errors', value: number, metadata?: Record<string, unknown>): void;
  getSummary(): TelemetrySummary;
}

export interface IFilesystemWatcher {
  watch(path: string, callback: (event: string, path: string) => void): void;
  stop(): void;
}

export interface ISDSComplianceScorer {
  calculateScore(trackId: string): number;
}
