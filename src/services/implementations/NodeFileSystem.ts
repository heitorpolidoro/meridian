import fs from 'node:fs';
import { IFileSystem } from '../interfaces/ICoreServices';

export class NodeFileSystem implements IFileSystem {
  // skipcq: JS-0105
  readFile(path: string): string {
    return fs.readFileSync(path, 'utf8');
  }

  // skipcq: JS-0105
  writeFile(path: string, content: string): void {
    fs.writeFileSync(path, content, 'utf8');
  }

  // skipcq: JS-0105
  deleteFile(path: string): void {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  }

  // skipcq: JS-0105
  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  // skipcq: JS-0105
  readDirectory(path: string): string[] {
    return fs.readdirSync(path);
  }

  // skipcq: JS-0105
  isDirectory(path: string): boolean {
    return fs.statSync(path).isDirectory();
  }

  // skipcq: JS-0105
  mkdir(path: string): void {
    fs.mkdirSync(path, { recursive: true });
  }
}
