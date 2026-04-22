import type { TelemetrySummary } from '../IPCSchemas';

/**
 * Core interface for filesystem operations.
 * Abstraction to allow multiple implementations (Node, Mock, Browser).
 */
export interface IFileSystem {
  /**
   * Reads the content of a file as a string.
   */
  readFile(path: string): string;

  /**
   * Writes content to a file, overwriting if it exists.
   */
  writeFile(path: string, content: string): void;

  /**
   * Appends content to a file.
   */
  appendFile(path: string, content: string): void;

  /**
   * Deletes a file from disk.
   */
  deleteFile(path: string): void;

  /**
   * Checks if a path (file or directory) exists.
   */
  exists(path: string): boolean;

  /**
   * Lists the names of items within a directory.
   */
  readDirectory(path: string): string[];

  /**
   * Checks if the given path is a directory.
   */
  isDirectory(path: string): boolean;

  /**
   * Creates a directory and its parents if they don't exist.
   */
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
