import path from 'node:path';
import { z } from 'zod';
import { IFileSystem } from './interfaces/ICoreServices';

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  lastAccessed: z.string().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

export class ProjectService {
  constructor(private readonly fs: IFileSystem) {}

  private readProjectName(meridianPath: string, folderName: string): string {
    const projectJsonPath = path.join(meridianPath, "project.json");
    if (!this.fs.exists(projectJsonPath)) return folderName;
    try {
      const config = JSON.parse(this.fs.readFile(projectJsonPath));
      return config.name ?? folderName;
    } catch {
      return folderName;
    }
  }

  private getProjectFromDirectory(parentPath: string, folderName: string): Project | null {
    const fullPath = path.join(parentPath, folderName);
    if (!this.fs.isDirectory(fullPath)) return null;

    const meridianPath = path.join(fullPath, ".meridian");
    if (!this.fs.exists(meridianPath) || !this.fs.isDirectory(meridianPath)) return null;

    return {
      id: folderName,
      name: this.readProjectName(meridianPath, folderName),
      path: fullPath,
    };
  }

  listProjects(searchPath: string): Project[] {
    if (!this.fs.exists(searchPath) || !this.fs.isDirectory(searchPath)) {
      return [];
    }

    try {
      return this.fs.readDirectory(searchPath)
        .map(item => this.getProjectFromDirectory(searchPath, item))
        .filter((p): p is Project => p !== null);
    } catch (error) {
      console.error('Failed to list projects:', error);
      return [];
    }
  }

  saveProjectConfig(projectPath: string, config: Record<string, unknown>): void {
    if (!this.fs.exists(projectPath) || !this.fs.isDirectory(projectPath)) {
      throw new Error(`Invalid project path: ${projectPath}`);
    }

    // Ensure we are saving inside the project folder, not the workspace root
    const meridianPath = path.join(projectPath, ".meridian");
    
    if (!this.fs.exists(meridianPath)) {
      this.fs.mkdir(meridianPath);
    }

    const projectJsonPath = path.join(meridianPath, "project.json");
    this.fs.writeFile(projectJsonPath, JSON.stringify(config, null, 2));
  }
}
