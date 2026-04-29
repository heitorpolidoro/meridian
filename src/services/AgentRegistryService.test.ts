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

  it('should discover agents from filesystem with YAML frontmatter', () => {
    mockFs.mkdir('/root/.gemini/agents');
    mockFs.writeFile('/root/.gemini/agents/piter.md', '---\nname: Piter Parker\ndescription: Friendly Neighborhood Spider-Man\n---\n# Content');
    
    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].name).toBe('Piter Parker');
    expect(discovered[0].role).toBe('Friendly Neighborhood Spider-Man');
    expect(discovered[0].id).toBe('piter');
  });

  it('should fallback to default values when frontmatter is missing or malformed', () => {
    mockFs.mkdir('/root/.gemini/agents');
    mockFs.writeFile('/root/.gemini/agents/malformed.md', 'No frontmatter here');
    mockFs.writeFile('/root/.gemini/agents/bad-yaml.md', '---\nname: [unclosed bracket\n---\n# Content');
    
    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(2);
    
    const malformed = discovered.find(a => a.id === 'malformed');
    expect(malformed?.name).toBe('malformed');
    expect(malformed?.role).toBe('Specialized Agent');

    const badYaml = discovered.find(a => a.id === 'bad-yaml');
    expect(badYaml?.name).toBe('bad-yaml');
    expect(badYaml?.role).toBe('Specialized Agent');
  });

  it('should preserve existing agent role and instruction during discovery', () => {
    // 1. Setup existing registry
    const existing: Agent[] = [{ 
      id: 'existing', 
      name: 'Old Name', 
      role: 'Custom Role', 
      instruction: 'Custom Instruction', 
      color: '#ff0000' 
    }];
    service.saveAgents(existing);

    // 2. Discover from file with different info
    mockFs.mkdir('/root/.gemini/agents');
    mockFs.writeFile('/root/.gemini/agents/existing.md', '---\nname: New Name\ndescription: "New Role"\n---\n# Content');

    const discovered = service.discoverAgents();
    const agent = discovered.find(a => a.id === 'existing');
    
    expect(agent?.name).toBe('New Name'); // Name comes from file
    expect(agent?.role).toBe('Custom Role'); // Role is preserved from registry
    expect(agent?.instruction).toBe('Custom Instruction'); // Instruction is preserved
    expect(agent?.color).toBe('#ff0000'); // Color is preserved
  });
});
