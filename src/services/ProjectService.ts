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

  listProjects(searchPath: string): Project[] {
    if (!this.fs.exists(searchPath) || !this.fs.isDirectory(searchPath)) {
      return [];
    }

    try {
      const items = this.fs.readDirectory(searchPath);
      const projects: Project[] = [];

      for (const item of items) {
        const fullPath = path.join(searchPath, item);
        if (this.fs.isDirectory(fullPath)) {
          const meridianPath = path.join(fullPath, ".meridian");
          if (
            this.fs.exists(meridianPath) &&
            this.fs.isDirectory(meridianPath)
          ) {
            let projectName = item;
            const projectJsonPath = path.join(meridianPath, "project.json");

            if (this.fs.exists(projectJsonPath)) {
              try {
                const content = this.fs.readFile(projectJsonPath);
                const config = JSON.parse(content);
                if (config.name) {
                  projectName = config.name;
                }
              } catch {
                // Fallback to folder name if JSON is invalid or unreadable
              }
            }

            projects.push({
              id: item, // Use folder name as ID for now
              name: projectName,
              path: fullPath,
            });
          }
        }
      }

      // Also check if the searchPath itself is a project
      const rootMeridian = path.join(searchPath, '.meridian');
      if (this.fs.exists(rootMeridian) && this.fs.isDirectory(rootMeridian)) {
        // If the searchPath itself is a project, it might be the only one or one of many
        // But usually listProjects is called on a parent directory
      }

      return projects;
    } catch (error) {
      console.error('Failed to list projects:', error);
      return [];
    }
  }

  saveProjectConfig(projectPath: string, config: any): void {
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
