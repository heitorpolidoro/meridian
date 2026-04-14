export interface IFileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  deleteFile(path: string): void; // New Method
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
  recordMetric(type: 'latency' | 'tokens' | 'errors', value: number, metadata?: any): void;
  getSummary(): any;
}

export interface IFilesystemWatcher {
  watch(path: string, callback: (event: string, path: string) => void): void;
  stop(): void;
}

export interface ISDSComplianceScorer {
  calculateScore(trackId: string): number;
}
