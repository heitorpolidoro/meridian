import * as path from "node:path";
import {
  IFileSystem,
  IContextInjectionService,
} from "./interfaces/ICoreServices";

/**
 * Service responsible for injecting context into files and directories
 * while enforcing security by blocking forbidden file patterns.
 */
export class ContextInjectionService implements IContextInjectionService {
  private readonly FORBIDDEN_PATTERNS = [
    ".env",
    ".git",
    "node_modules",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".DS_Store",
  ];

  /**
   * Creates a new instance of ContextInjectionService.
   * @param fs - File system abstraction for performing file operations.
   * @param rootDir - The root directory path where context injection occurs.
   */
  constructor(
    private fs: IFileSystem,
    private rootDir: string,
  ) {}

  /**
   * Validates if a file path is forbidden based on security patterns.
   * Prevents leaking secrets like .env or large dependencies.
   * @param filePath - The file path to check against forbidden patterns.
   * @returns True if the file path contains a forbidden pattern, false otherwise.
   */
  public isForbidden(filePath: string): boolean {
    const normalizedPath = filePath.split("\\").join("/");
    const pathParts = normalizedPath.split("/");

    return pathParts.some(
      (part) =>
        this.FORBIDDEN_PATTERNS.includes(part) || part.startsWith(".env"),
    );
  }

  /**
   * Dynamically selects and injects relevant files for a specific track.
   * Enforces isolation and secret prevention.
   */
  public injectTrackContext(trackId: string): string {
    const baseTracksDir = path.join(this.rootDir, ".meridian/tracks");

    // Strict Isolation Check: block directory traversal patterns
    if (trackId.includes("..")) {
      console.error(
        `[ERROR] [ContextInjectionService] Isolation breach attempt detected (traversal): ${trackId}`,
      );
      return "";
    }

    const trackPath = path.join(baseTracksDir, trackId);

    // Ensure the resolved path is still within the tracks directory
    const relative = path.relative(baseTracksDir, trackPath);
    const isInside =
      relative && !relative.startsWith("..") && !path.isAbsolute(relative);

    if (!isInside && trackId !== "") {
      console.error(
        `[ERROR] [ContextInjectionService] Isolation breach attempt detected (out-of-bounds): ${trackId}`,
      );
      return "";
    }

    if (!this.fs.exists(trackPath)) {
      return "";
    }

    const contextParts: string[] = [`# Context for Track: ${trackId}`];

    // 1. Always inject Product Vision (product.md) from the root if it exists
    const productPath = path.join(this.rootDir, ".meridian/product.md");
    if (this.fs.exists(productPath)) {
      const content = this.fs.readFile(productPath);
      contextParts.push(`\n## Product Vision\n\n${content}`);
    }

    // 2. Inject Track Files
    const files = this.fs.readDirectory(trackPath);

    for (const fileName of files) {
      const fullPath = path.join(trackPath, fileName);

      if (this.fs.isDirectory(fullPath)) {
        continue;
      }

      if (this.isForbidden(fullPath)) {
        continue;
      }

      // Only inject markdown files by default for context clarity
      if (fileName.endsWith(".md")) {
        const content = this.fs.readFile(fullPath);
        contextParts.push(`\n## File: ${fileName}\n\n${content}`);
      }
    }

    return contextParts.join("\n");
  }
}
