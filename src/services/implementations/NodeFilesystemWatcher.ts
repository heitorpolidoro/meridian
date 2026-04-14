import fs from 'node:fs';
import { IFilesystemWatcher } from '../interfaces/ICoreServices';

export class NodeFilesystemWatcher implements IFilesystemWatcher {
  private watcher: fs.FSWatcher | null = null;

  watch(path: string, callback: (event: string, path: string) => void): void {
    this.stop();
    try {
      this.watcher = fs.watch(path, { recursive: true }, (event, filename) => {
        if (filename) {
          callback(event, filename);
        }
      });
    } catch (error) {
      console.error('Error starting watcher:', error);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
