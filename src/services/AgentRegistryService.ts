import path from 'node:path';
import { z } from 'zod';
import { IFileSystem } from './interfaces/ICoreServices';

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  instruction: z.string().optional().default(''),
  color: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid Hex Color')
});

export const AgentArraySchema = z.array(AgentSchema);
export type Agent = z.infer<typeof AgentSchema>;

export class AgentRegistryService {
  private readonly AGENTS_FILE = '.meridian/agents.json';

  constructor(private fs: IFileSystem, private rootDir: string) {}

  private getFilePath(): string {
    return path.join(this.rootDir, this.AGENTS_FILE);
  }

  getAgents(): Agent[] {
    const filePath = this.getFilePath();
    if (!this.fs.exists(filePath)) return [];
    try {
      const content = this.fs.readFile(filePath);
      const parsed = JSON.parse(content);
      const result = AgentArraySchema.safeParse(parsed);
      if (!result.success) {
        console.error('Invalid agent registry schema', result.error);
        return [];
      }
      return result.data;
    } catch (error) {
      console.error('Failed to read or parse agents registry', error);
      return [];
    }
  }

  saveAgents(agents: Agent[]): void {
    const uniqueAgents = Array.from(new Map(agents.map(a => [a.id, a])).values());
    const result = AgentArraySchema.safeParse(uniqueAgents);
    if (!result.success) {
      throw new Error(`Invalid agent data: ${result.error.message}`);
    }

    const filePath = this.getFilePath();
    const dirPath = path.dirname(filePath);
    if (!this.fs.exists(dirPath)) this.fs.mkdir(dirPath);
    
    this.fs.writeFile(filePath, JSON.stringify(result.data, null, 2));
  }

  discoverAgents(): Agent[] {
    const geminiDir = path.join(this.rootDir, '.gemini', 'agents');
    if (!this.fs.exists(geminiDir)) return this.getAgents();

    const currentAgents = this.getAgents();
    const files = this.fs.readDirectory(geminiDir).filter(f => f.endsWith('.md'));
    
    const discoveredAgents: Agent[] = files.map(file => {
      const content = this.fs.readFile(path.join(geminiDir, file));
      const fileId = file.replace('.md', '');
      
      const nameMatch = content.match(/name:\s*(.*)/);
      const descMatch = content.match(/description:\s*"(.*)"/);
      
      const name = nameMatch ? nameMatch[1].trim() : fileId;
      const role = descMatch ? descMatch[1].trim() : 'Specialized Agent';
      
      const existing = currentAgents.find(a => a.id === fileId);
      
      return {
        id: fileId,
        name: name,
        role: existing?.role || role,
        instruction: existing?.instruction || 'Bootstrap loaded from filesystem.',
        color: existing?.color || '#00c3ff'
      };
    });

    this.saveAgents(discoveredAgents);
    return discoveredAgents;
  }

  syncToGemini(agents: Agent[]): void {
    const geminiDir = path.join(this.rootDir, '.gemini', 'agents');
    if (!this.fs.exists(geminiDir)) this.fs.mkdir(geminiDir);

    const activeIds = new Set(agents.map(a => `${a.id}.md`));
    const diskFiles = this.fs.readDirectory(geminiDir).filter(f => f.endsWith('.md'));

    // 1. Cleanup orphaned files
    diskFiles.forEach(file => {
      if (!activeIds.has(file)) {
        const filePath = path.join(geminiDir, file);
        this.fs.deleteFile(filePath);
      }
    });

    // 2. Update/Create current agents
    agents.forEach(agent => {
      const fileName = `${agent.id}.md`;
      const filePath = path.join(geminiDir, fileName);
      const content = `---
name: ${agent.name}
description: "${agent.role}"
---

# Agent Bootstrapping

Your complete identity and roles are defined at:
@../../agents_core/roles/${agent.id}.md

**Critical Instruction:** 
Before performing anything, you MUST read and fully load the file above to understand your responsibility and global standards.
`;
      this.fs.writeFile(filePath, content);
    });
  }
}
