import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRegistryService, Agent } from './AgentRegistryService';
import { MockFileSystem } from './mocks/MockServices';

describe('AgentRegistryService', () => {
  let mockFs: MockFileSystem;
  let service: AgentRegistryService;
  const rootDir = '/root';

  beforeEach(() => {
    mockFs = new MockFileSystem();
    service = new AgentRegistryService(mockFs, rootDir);
  });

  it('should return an empty array if agents file does not exist', () => {
    const agents = service.getAgents();
    expect(agents).toEqual([]);
  });

  it('should save and retrieve valid agents', () => {
    const mockAgents: Agent[] = [
      { id: '1', name: 'Test Agent', role: 'Dev', instruction: 'Test', color: '#000000' }
    ];
    service.saveAgents(mockAgents);
    const retrieved = service.getAgents();
    expect(retrieved).toEqual(mockAgents);
  });

  it('should throw error when saving invalid agents (missing name)', () => {
    const invalidAgents = [
      { id: '1', name: '', role: 'Dev', instruction: 'Test', color: '#000000' }
    ];
    expect(() => service.saveAgents(invalidAgents as Agent[])).toThrow('Invalid agent data');
  });

  it('should throw error when saving invalid agents (invalid color)', () => {
    const invalidAgents = [
      { id: '1', name: 'Agent', role: 'Dev', instruction: 'Test', color: 'invalid' }
    ];
    expect(() => service.saveAgents(invalidAgents as Agent[])).toThrow('Invalid agent data');
  });

  it('should create the directory if it does not exist when saving', () => {
    const mockAgents: Agent[] = [{ id: '1', name: 'Test', role: 'Dev', instruction: 'Test', color: '#000000' }];
    service.saveAgents(mockAgents);
    expect(mockFs.exists('/root/.meridian')).toBe(true);
  });

  it('should return empty array and log error when registry JSON is invalid', () => {
    mockFs.mkdir('/root/.meridian');
    mockFs.writeFile('/root/.meridian/agents.json', '{invalid: json}');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agents = service.getAgents();
    expect(agents).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read or parse agents registry'), expect.anything());
    consoleSpy.mockRestore();
  });

  it('should return empty array and log error when registry schema is invalid', () => {
    mockFs.mkdir('/root/.meridian');
    mockFs.writeFile('/root/.meridian/agents.json', JSON.stringify([{ id: '1', name: '', role: 'Dev' }]));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agents = service.getAgents();
    expect(agents).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid agent registry schema'), expect.any(Object));
    consoleSpy.mockRestore();
  });

  it('should sync agents to gemini .md files', () => {
    const mockAgents: Agent[] = [
      { id: 'gemini-agent', name: 'Gemini Agent', role: 'AI', instruction: 'Focus', color: '#ffffff' }
    ];
    service.syncToGemini(mockAgents);
    const filePath = '/root/.gemini/agents/gemini-agent.md';
    expect(mockFs.exists(filePath)).toBe(true);
    expect(mockFs.readFile(filePath)).toContain('name: Gemini Agent');
  });

  it('should discover agents from filesystem', () => {
    mockFs.mkdir('/root/.gemini/agents');
    mockFs.writeFile('/root/.gemini/agents/piter.md', '---\nname: Piter\ndescription: "Specialized"\n---\n# Content');
    
    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].name).toBe('Piter');
    expect(discovered[0].id).toBe('piter');
  });
});
