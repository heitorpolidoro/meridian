import fs from 'node:fs';
import { IFileSystem } from '../interfaces/ICoreServices';

export class NodeFileSystem implements IFileSystem {
  readFile(path: string): string {
    return fs.readFileSync(path, 'utf8');
  }

  writeFile(path: string, content: string): void {
    fs.writeFileSync(path, content, 'utf8');
  }

  deleteFile(path: string): void {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  }

  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  readDirectory(path: string): string[] {
    return fs.readdirSync(path);
  }

  isDirectory(path: string): boolean {
    return fs.statSync(path).isDirectory();
  }

  mkdir(path: string): void {
    fs.mkdirSync(path, { recursive: true });
  }
}
