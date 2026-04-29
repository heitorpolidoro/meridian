import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistryService, Agent } from "./AgentRegistryService";
import { MockFileSystem } from "./mocks/MockServices";

describe("AgentRegistryService", () => {
  let mockFs: MockFileSystem;
  let service: AgentRegistryService;
  const rootDir = "/root";

  beforeEach(() => {
    mockFs = new MockFileSystem();
    service = new AgentRegistryService(mockFs, rootDir);
  });

  it("should return an empty array if agents file does not exist", () => {
    const agents = service.getAgents();
    expect(agents).toEqual([]);
  });

  it("should save and retrieve valid agents", () => {
    const mockAgents: Agent[] = [
      {
        id: "1",
        name: "Test Agent",
        role: "Dev",
        instruction: "Test",
        color: "#000000",
      },
    ];
    service.saveAgents(mockAgents);
    const retrieved = service.getAgents();
    expect(retrieved).toEqual(mockAgents);
  });

  it("should throw error when saving invalid agents (missing name)", () => {
    const invalidAgents = [
      { id: "1", name: "", role: "Dev", instruction: "Test", color: "#000000" },
    ];
    expect(() => service.saveAgents(invalidAgents as Agent[])).toThrow(
      "Invalid agent data",
    );
  });

  it("should throw error when saving invalid agents (invalid color)", () => {
    const invalidAgents = [
      {
        id: "1",
        name: "Agent",
        role: "Dev",
        instruction: "Test",
        color: "invalid",
      },
    ];
    expect(() => service.saveAgents(invalidAgents as Agent[])).toThrow(
      "Invalid agent data",
    );
  });

  it("should create the directory if it does not exist when saving", () => {
    const mockAgents: Agent[] = [
      {
        id: "1",
        name: "Test",
        role: "Dev",
        instruction: "Test",
        color: "#000000",
      },
    ];
    service.saveAgents(mockAgents);
    expect(mockFs.exists("/root/.meridian")).toBe(true);
  });

  it("should return empty array and log error when registry JSON is invalid", () => {
    mockFs.mkdir("/root/.meridian");
    mockFs.writeFile("/root/.meridian/agents.json", "{invalid: json}");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agents = service.getAgents();
    expect(agents).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read or parse agents registry"),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  it("should return empty array and log error when registry schema is invalid", () => {
    mockFs.mkdir("/root/.meridian");
    mockFs.writeFile(
      "/root/.meridian/agents.json",
      JSON.stringify([{ id: "1", name: "", role: "Dev" }]),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agents = service.getAgents();
    expect(agents).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid agent registry schema"),
      expect.any(Object),
    );
    consoleSpy.mockRestore();
  });

  it("should sync agents to gemini .md files", () => {
    const mockAgents: Agent[] = [
      {
        id: "gemini-agent",
        name: "Gemini Agent",
        role: "AI",
        instruction: "Focus",
        color: "#ffffff",
      },
    ];
    service.syncToGemini(mockAgents);
    const filePath = "/root/.gemini/agents/gemini-agent.md";
    expect(mockFs.exists(filePath)).toBe(true);
    expect(mockFs.readFile(filePath)).toContain("name: Gemini Agent");
  });

  it("should cleanup orphaned files in gemini .md directory", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile("/root/.gemini/agents/orphan.md", "some content");

    const activeAgents: Agent[] = [
      {
        id: "active",
        name: "Active",
        role: "AI",
        instruction: "Focus",
        color: "#ffffff",
      },
    ];

    service.syncToGemini(activeAgents);

    expect(mockFs.exists("/root/.gemini/agents/active.md")).toBe(true);
    expect(mockFs.exists("/root/.gemini/agents/orphan.md")).toBe(false);
  });

  it("should NOT cleanup active files in gemini .md directory", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile("/root/.gemini/agents/active.md", "some content");

    const activeAgents: Agent[] = [
      {
        id: "active",
        name: "Active",
        role: "AI",
        instruction: "Focus",
        color: "#ffffff",
      },
    ];

    service.syncToGemini(activeAgents);

    expect(mockFs.exists("/root/.gemini/agents/active.md")).toBe(true);
  });

  it("should fallback to ID if metadata exists but name/description are missing", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/no-fields.md",
      "---\nother: field\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    const agent = discovered.find((a) => a.id === "no-fields");
    expect(agent?.name).toBe("no-fields");
    expect(agent?.role).toBe("Specialized Agent");
  });

  it("should create gemini agents directory if it does not exist during sync", () => {
    const mockAgents: Agent[] = [
      {
        id: "1",
        name: "Test",
        role: "Dev",
        instruction: "Test",
        color: "#000000",
      },
    ];
    service.syncToGemini(mockAgents);
    expect(mockFs.exists("/root/.gemini/agents")).toBe(true);
  });

  it("should return agents from registry if gemini directory does not exist during discovery", () => {
    const mockAgents: Agent[] = [
      {
        id: "1",
        name: "Test",
        role: "Dev",
        instruction: "Test",
        color: "#000000",
      },
    ];
    service.saveAgents(mockAgents);
    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].id).toBe("1");
  });

  it("should use partial fallback for existing agents in discoverAgents", () => {
    // Agent exists but instruction is empty string (default)
    const existing: Agent[] = [
      {
        id: "existing",
        name: "Old Name",
        role: "Custom Role",
        instruction: "",
        color: "#ff0000",
      },
    ];
    service.saveAgents(existing);

    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/existing.md",
      "---\nname: New Name\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    const agent = discovered.find((a) => a.id === "existing");

    expect(agent?.name).toBe("New Name");
    expect(agent?.role).toBe("Custom Role");
    expect(agent?.instruction).toBe("Bootstrap loaded from filesystem."); // Falls back because instruction was ''
    expect(agent?.color).toBe("#ff0000");
  });

  it("should handle null metadata from YAML parse in discoverAgents", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile("/root/.gemini/agents/empty.md", "---\n---");

    const discovered = service.discoverAgents();
    expect(discovered[0].name).toBe("empty");
    expect(discovered[0].role).toBe("Specialized Agent");
  });

  it("should discover agents from filesystem with YAML frontmatter", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/piter.md",
      "---\nname: Piter Parker\ndescription: Friendly Neighborhood Spider-Man\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].name).toBe("Piter Parker");
    expect(discovered[0].role).toBe("Friendly Neighborhood Spider-Man");
    expect(discovered[0].id).toBe("piter");
  });

  it("should fallback to default values when frontmatter is missing or malformed", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/malformed.md",
      "No frontmatter here",
    );
    mockFs.writeFile(
      "/root/.gemini/agents/bad-yaml.md",
      "---\nname: [unclosed bracket\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    expect(discovered).toHaveLength(2);

    const malformed = discovered.find((a) => a.id === "malformed");
    expect(malformed?.name).toBe("malformed");
    expect(malformed?.role).toBe("Specialized Agent");

    const badYaml = discovered.find((a) => a.id === "bad-yaml");
    expect(badYaml?.name).toBe("bad-yaml");
    expect(badYaml?.role).toBe("Specialized Agent");
  });

  it("should use default name if metadata exists but name is missing", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/no-name.md",
      "---\ndescription: 'Just description'\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    const agent = discovered.find((a) => a.id === "no-name");
    expect(agent?.name).toBe("no-name");
    expect(agent?.role).toBe("Just description");
  });

  it("should use default role if metadata exists but description is missing", () => {
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/no-desc.md",
      "---\nname: 'Only Name'\n---\n# Content",
    );

    const discovered = service.discoverAgents();
    const agent = discovered.find((a) => a.id === "no-desc");
    expect(agent?.name).toBe("Only Name");
    expect(agent?.role).toBe("Specialized Agent");
  });

  it("should preserve existing agent role and instruction during discovery", () => {
    // 1. Setup existing registry
    const existing: Agent[] = [
      {
        id: "existing",
        name: "Old Name",
        role: "Custom Role",
        instruction: "Custom Instruction",
        color: "#ff0000",
      },
    ];
    service.saveAgents(existing);

    // 2. Discover from file with different info
    mockFs.mkdir("/root/.gemini/agents");
    mockFs.writeFile(
      "/root/.gemini/agents/existing.md",
      '---\nname: New Name\ndescription: "New Role"\n---\n# Content',
    );

    const discovered = service.discoverAgents();
    const agent = discovered.find((a) => a.id === "existing");

    expect(agent?.name).toBe("New Name"); // Name comes from file
    expect(agent?.role).toBe("Custom Role"); // Role is preserved from registry
    expect(agent?.instruction).toBe("Custom Instruction"); // Instruction is preserved
    expect(agent?.color).toBe("#ff0000"); // Color is preserved
  });
});
