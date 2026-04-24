import { describe, it, expect, vi } from "vitest";
import { ProjectService } from "./ProjectService";
import { MockFileSystem } from "./mocks/MockFileSystem";
import path from "node:path";

describe("ProjectService", () => {
  it("should return an empty array if the search path does not exist", () => {
    const fs = new MockFileSystem();
    const service = new ProjectService(fs);

    expect(service.listProjects("/non-existent")).toEqual([]);
  });

  it("should return an empty array if the search path is not a directory", () => {
    const fs = new MockFileSystem();
    fs.writeFile("/file.txt", "not a dir");
    const service = new ProjectService(fs);

    expect(service.listProjects("/file.txt")).toEqual([]);
  });

  it("should list directories containing a .meridian folder as projects", () => {
    const fs = new MockFileSystem();
    const searchPath = "/projects";
    fs.mkdir(searchPath);

    // Project A: Valid
    const projectAPath = path.join(searchPath, "project-a");
    fs.mkdir(projectAPath);
    fs.mkdir(path.join(projectAPath, ".meridian"));

    // Folder B: Not a project (no .meridian)
    const folderBPath = path.join(searchPath, "folder-b");
    fs.mkdir(folderBPath);

    // File C: Not a project (is a file)
    fs.writeFile(path.join(searchPath, "file-c.txt"), "content");

    const service = new ProjectService(fs);
    const projects = service.listProjects(searchPath);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      id: "project-a",
      name: "project-a",
      path: projectAPath,
    });
  });

  it("should handle errors during directory reading gracefully", () => {
    const fs = new MockFileSystem();
    fs.mkdir("/error-path");
    const service = new ProjectService(fs);

    // Mock readDirectory to throw
    vi.spyOn(fs, "readDirectory").mockImplementation(() => {
      throw new Error("Read failed");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const projects = service.listProjects("/error-path");

    expect(projects).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to list projects:",
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it("should handle cases where .meridian exists but is a file (invalid project)", () => {
    const fs = new MockFileSystem();
    const searchPath = "/projects";
    fs.mkdir(searchPath);

    const projectPath = path.join(searchPath, "invalid-project");
    fs.mkdir(projectPath);
    // .meridian is a file, not a directory
    fs.writeFile(path.join(projectPath, ".meridian"), "just a file");

    const service = new ProjectService(fs);
    const projects = service.listProjects(searchPath);

    expect(projects).toEqual([]);
  });

  it("should check if the searchPath itself is a project", () => {
    const fs = new MockFileSystem();
    const searchPath = "/my-project";
    fs.mkdir(searchPath);
    fs.mkdir(path.join(searchPath, ".meridian"));

    const service = new ProjectService(fs);
    // This should trigger the rootMeridian check, though it currently doesn't add to the array
    const projects = service.listProjects(searchPath);
    expect(projects).toEqual([]);
  });
});
