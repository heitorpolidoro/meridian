import * as path from 'node:path';
import { IFileSystem } from './interfaces/ICoreServices';

export class BootstrappingService {
  constructor(private fs: IFileSystem, private rootDir: string) {}

  /**
   * Resolves an agent's full system instruction by traversing the hierarchy:
   * Stub -> Role -> Core Standards.
   * 
   * Ensures Global Standards come first.
   */
  public resolve(agentId: string): string {
    const globalPath = path.join(this.rootDir, '.meridian/core/global.md');
    if (!this.fs.exists(globalPath)) {
      throw new Error(`Global standards file not found at: ${globalPath}`);
    }
    const globalContent = this.fs.readFile(globalPath);
    const resolvedStub = this.resolveAgent(agentId);

    return `${globalContent}\n\n${resolvedStub}`.trim();
  }

  /**
   * Resolves an agent's instruction WITHOUT prepending global standards.
   * Useful for combining multiple agents into one session.
   */
  public resolveAgent(agentId: string): string {
    const stubPath = path.join(this.rootDir, '.gemini/agents', `${agentId}.md`);
    const globalPath = path.join(this.rootDir, '.meridian/core/global.md');

    if (!this.fs.exists(stubPath)) {
      throw new Error(`Stub file not found for agent: ${agentId}`);
    }

    const visited = new Set<string>();
    if (this.fs.exists(globalPath)) {
      visited.add(path.resolve(globalPath));
    }

    return this.resolveFile(stubPath, visited);
  }

  private resolveFile(filePath: string, visited: Set<string>): string {
    const absolutePath = path.resolve(filePath);
    if (visited.has(absolutePath)) {
      return '';
    }
    visited.add(absolutePath);

    if (!this.fs.exists(absolutePath)) {
      return `[Error: File not found: ${filePath}]`;
    }

    const content = this.fs.readFile(absolutePath);
    const dir = path.dirname(absolutePath);
    const lines = content.split('\n');
    
    const resolvedLines = lines.map(line => {
      const trimmedLine = line.trim();
      // Match lines starting with @ (optionally with whitespace before)
      if (trimmedLine.startsWith('@')) {
        const relativePath = trimmedLine.substring(1).trim();
        const linkedPath = path.resolve(dir, relativePath);
        return this.resolveFile(linkedPath, visited);
      }
      return line;
    });

    return resolvedLines.join('\n');
  }
}
