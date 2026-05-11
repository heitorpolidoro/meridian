import express from "express";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { NodeFileSystem } from "./src/services/implementations/NodeFileSystem";
import { AgentRegistryService } from "./src/services/AgentRegistryService";
import { TrackMetadataService } from "./src/services/TrackMetadataService";
import { BootstrappingService } from "./src/services/BootstrappingService";
import { SDSComplianceScorer } from "./src/services/SDSComplianceScorer";
import { TelemetryCollectorService } from "./src/services/TelemetryCollectorService";
import { ProjectService } from "./src/services/ProjectService";
import { GeminiMessage } from "./src/services/IPCSchemas";
import { ValidationEngine } from "./src/services/ValidationEngine";
import { NodeFilesystemWatcher } from "./src/services/implementations/NodeFilesystemWatcher";
import { OrchestrationService } from "./src/services/OrchestrationService";
import { SessionManagerService } from "./src/services/SessionManagerService";
import { SpecGate } from "./src/services/gates/SpecGate";
import { PlanGate } from "./src/services/gates/PlanGate";
import { TasksGate } from "./src/services/gates/TasksGate";
import { createCodeGate } from "./src/services/gates/CodeGate";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, ".settings.json");

const fileSystem = new NodeFileSystem();
const telemetryCollector = new TelemetryCollectorService();
const sessionManager = new SessionManagerService();
const watcher = new NodeFilesystemWatcher();

const DEFAULT_SETTINGS = {
  rootDir: process.env.MERIDIAN_ROOT || process.cwd(),
};

/**
 * Retrieves the application settings from the settings file, ensuring the file exists with default settings.
 * If the settings file does not exist, it is created with DEFAULT_SETTINGS.
 * @returns {object} The settings object from the file or DEFAULT_SETTINGS if parsing fails.
 */
export function getSettings() {
  let settings;
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  } else {
    settings = { ...DEFAULT_SETTINGS };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }

  // Override with environment variable if provided (e.g., from the meridian CLI script)
  if (process.env.MERIDIAN_ROOT) {
    settings.rootDir = process.env.MERIDIAN_ROOT;
  }

  return settings;
}

/**
 * Retrieves context-dependent services based on root directory.
 */
// skipcq: JS-0067
export function getContextServices() {
  const settings = getSettings();
  const rootDir = settings.rootDir;
  const meridianDir = path.join(rootDir, ".meridian");
  const trackMetadataService = new TrackMetadataService(
    fileSystem,
    meridianDir,
  );
  const bootstrappingService = new BootstrappingService(fileSystem, rootDir);
  const complianceScorer = new SDSComplianceScorer(
    fileSystem,
    path.join(meridianDir, "tracks"),
  );

  const validationEngine = new ValidationEngine(fileSystem, meridianDir);
  validationEngine.registerGate("1.1", SpecGate);
  validationEngine.registerGate("1.2", PlanGate);
  validationEngine.registerGate("2.1", TasksGate);
  validationEngine.registerGate("3.1", createCodeGate(complianceScorer));
  validationEngine.registerGate("4.2", createCodeGate(complianceScorer));

  const orchestrationService = new OrchestrationService(
    trackMetadataService,
    fileSystem,
    meridianDir,
    validationEngine,
    watcher,
    bootstrappingService,
    sessionManager,
  );

  return {
    rootDir,
    meridianDir,
    agentRegistry: new AgentRegistryService(fileSystem, rootDir),
    trackMetadataService,
    bootstrappingService,
    complianceScorer,
    projectService: new ProjectService(fileSystem),
    validationEngine,
    orchestrationService,
  };
}

/**
 * Logs a message to the console with level-based coloring.
 */
export function log(
  msg: string,
  level: "OUT" | "IN" | "INFO" | "ERROR" = "INFO",
) {
  const timestamp = new Date().toLocaleTimeString();
  const colors = {
    INFO: "\x1b[32m",
    ERROR: "\x1b[31m",
    OUT: "\x1b[34m",
    IN: "\x1b[35m",
  };
  console.error(`${colors[level]}[${timestamp}] [${level}] ${msg}\x1b[0m`);
}

const app = express();
const isDev = process.env.NODE_ENV !== "production";

if (isDev) {
  log(
    "Running in development mode - access the frontend via Vite on port 5174",
    "INFO",
  );
} else {
  app.use(express.static("dist"));

  // Fallback to index.html for SPA routing using a Regex to bypass Express 5 string parsing quirks
  app.get(/^(?!\/socket\.io).+/, (_req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;
const GEMINI_CMD = "gemini";

export interface GeminiContext {
  globalContent: string;
  agentInstructions: string;
  rootDir: string;
  socket: Socket;
  telemetryCollector: TelemetryCollectorService;
  setSessionId: (id: string) => void;
  setPromptStartTime: (time: number | null) => void;
  getPromptStartTime: () => number | null;
  gemini?: ChildProcess | null;
}

/**
 * Parses and dispatches Gemini JSON outputs.
 */
export function processGeminiOutput(
  jsonLine: string,
  ctx: GeminiContext,
  sendACP: (msg: unknown) => void,
) {
  try {
    const parsed: GeminiMessage = JSON.parse(jsonLine);

    const handlers: Record<string | number, () => void> = {
      "session/update": () =>
        handleSessionUpdate(parsed, ctx.socket, ctx.telemetryCollector),
      1: () => handleInitialize(sendACP, ctx),
      2: () => {
        const sessionId = parsed.result?.sessionId;
        if (sessionId) {
          ctx.setSessionId(sessionId);
          ctx.socket.emit("ready");
        }
      },
      ...(parsed.id !== undefined && parsed.id >= 3 && parsed.result
        ? { [parsed.id]: () => handleRequestComplete(ctx) }
        : {}),
    };

    const key = parsed.method ?? parsed.id;
    handlers[key]?.();
  } catch {
    /* Ignore malformed */
  }
}

/**
 * Initializes a new Gemini session.
 */
export function handleInitialize(
  sendACP: (msg: unknown) => void,
  ctx: GeminiContext,
) {
  sendACP({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      cwd: ctx.rootDir,
      mcpServers: [],
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: `${ctx.globalContent}\n\n# Orchestration Instructions\nYou are the Meridian Orchestrator. Respond as these distinct agents debating:\n${ctx.agentInstructions}\nWhenever I send a directive, simulate a brief debate and end with [VERDICT].`,
          },
        ],
      },
    },
  });
}

/**
 * Updates session state based on agent messages.
 */
export function handleSessionUpdate(
  parsed: GeminiMessage,
  socket: Socket,
  telemetry: TelemetryCollectorService,
) {
  const update = parsed.params?.update;
  if (update?.sessionUpdate === "agent_message_chunk") {
    const chunk = update.content?.text || "";
    telemetry.recordMetric("tokens", Math.ceil(chunk.length / 4));
    socket.emit("chunk", chunk);
  }
}

/**
 * Handles completion of a prompt request.
 */
export function handleRequestComplete(ctx: GeminiContext) {
  const start = ctx.getPromptStartTime();
  if (start) {
    ctx.telemetryCollector.recordMetric("latency", Date.now() - start);
    ctx.setPromptStartTime(null);
  }
  ctx.socket.emit("done");
}

io.on("connection", (socket) => {
  let gemini: ChildProcess | null = null;
  let sessionId: string | null = null;
  let requestId = 3;
  let promptStartTime: number | null = null;
  let lineBuffer = ""; // Buffer to accumulate partial lines

  const ctx: GeminiContext = {
    globalContent: "",
    agentInstructions: "",
    rootDir: "",
    socket,
    telemetryCollector,
    setSessionId: (id: string) => {
      sessionId = id;
    },
    setPromptStartTime: (time: number | null) => {
      promptStartTime = time;
    },
    getPromptStartTime: () => promptStartTime,
  };

  /**
   * Sends a message to the Gemini child process and logs it.
   */
  const sendACP = (msg: unknown) => {
    if (gemini?.stdin?.writable) {
      gemini.stdin.write(`${JSON.stringify(msg)}\n`);
      log(JSON.stringify(msg), "OUT");
    }
  };

  const cleanup = () => {
    if (gemini) {
      log("Cleaning up Gemini process...", "INFO");
      gemini.kill();
      gemini = null;
    }
  };

  socket.on("list-dir-contents", (dirPath: string) => {
    try {
      if (fileSystem.exists(dirPath) && fileSystem.isDirectory(dirPath)) {
        const entries = fileSystem.readDirectory(dirPath).filter((name) => {
          try {
            return fileSystem.isDirectory(path.join(dirPath, name));
          } catch {
            return false;
          }
        });
        socket.emit("dir-contents", entries);
      } else {
        socket.emit("dir-contents", []);
      }
    } catch (error) {
      log(`Error listing directory ${dirPath}: ${error}`, "ERROR");
      socket.emit("dir-contents", []);
    }
  });

  socket.on("get-parent-dir", (dirPath: string) => {
    socket.emit("parent-dir", path.dirname(dirPath));
  });

  socket.on("get-settings", () => {
    socket.emit("settings", getSettings());
  });

  socket.on("save-settings", (settings) => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    // Use socket.emit instead of io.emit to avoid triggering flash messages for all clients
    socket.emit("settings-saved", settings);
  });

  socket.on("get-agents", () => {
    const { agentRegistry } = getContextServices();
    socket.emit("agents", agentRegistry.getAgents());
  });

  socket.on("save-agents", (agents) => {
    const { agentRegistry } = getContextServices();
    agentRegistry.saveAgents(agents);
    socket.emit("agents-saved");
  });

  socket.on("get-tracks", () => {
    const { trackMetadataService } = getContextServices();
    socket.emit("tracks", trackMetadataService.listTracksWithMetadata());
  });

  socket.on("get-projects", () => {
    const { rootDir, projectService } = getContextServices();
    // In this model, rootDir is always the workspace.
    // We list all projects containing .meridian inside it.
    socket.emit("projects", projectService.listProjects(rootDir));
  });

  socket.on("save-project-config", ({ projectPath, config }) => {
    log(`Attempting to save project config for: ${projectPath}`, "INFO");
    try {
      const { rootDir, projectService } = getContextServices();
      projectService.saveProjectConfig(projectPath, config);
      log(`Project config saved successfully for ${projectPath}`, "INFO");
      // Emit only to the user who saved
      socket.emit("project-config-saved");
      // Broadcast updated project list to everyone to refresh sidebars/hubs
      io.emit("projects", projectService.listProjects(rootDir));
    } catch (error) {
      log(`Error saving project config for ${projectPath}: ${error}`, "ERROR");
    }
  });

  socket.on(
    "get-file-content",
    ({ trackId, fileName }: { trackId: string; fileName: string }) => {
      const { meridianDir } = getContextServices();
      const filePath = path.join(meridianDir, "tracks", trackId, fileName);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        socket.emit("file-content", { trackId, fileName, content });
      }
    },
  );

  socket.on(
    "orchestration:request-transition",
    ({ trackId, targetPhase, message, trigger }) => {
      try {
        const { orchestrationService, trackMetadataService } =
          getContextServices();
        orchestrationService.requestTransition(
          trackId,
          targetPhase,
          message,
          trigger,
        );
        io.emit("tracks", trackMetadataService.listTracksWithMetadata());
      } catch (error) {
        log(`Error in orchestration:request-transition: ${error}`, "ERROR");
        socket.emit("orchestration:error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on(
    "orchestration:update-status",
    ({ trackId, status, message, trigger }) => {
      try {
        const { orchestrationService, trackMetadataService } =
          getContextServices();
        orchestrationService.updateStatus(trackId, status, message, trigger);
        io.emit("tracks", trackMetadataService.listTracksWithMetadata());
      } catch (error) {
        log(`Error in orchestration:update-status: ${error}`, "ERROR");
        socket.emit("orchestration:error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on("orchestration:get-state", (trackId: string) => {
    try {
      const { orchestrationService } = getContextServices();
      const state = orchestrationService.getOrchestrationState(trackId);
      socket.emit("orchestration:state", { trackId, state });
    } catch (error) {
      log(`Error in orchestration:get-state: ${error}`, "ERROR");
      socket.emit("orchestration:error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("disconnect", cleanup);

  socket.on("start-session", () => {
    cleanup();
    lineBuffer = "";
    const { rootDir, meridianDir, agentRegistry, bootstrappingService } =
      getContextServices();
    const agents = agentRegistry.getAgents();
    ctx.rootDir = rootDir;
    ctx.globalContent = fs.existsSync(path.join(meridianDir, "core/global.md"))
      ? fs.readFileSync(path.join(meridianDir, "core/global.md"), "utf8")
      : "";
    ctx.agentInstructions = agents
      .map(
        (a: { name: string; role: string; id: string }) =>
          `${a.name.toUpperCase()} (${a.role}): ${bootstrappingService.resolveAgent(a.id)}`,
      )
      .join("\n\n---\n\n");

    const binDir = path.join(rootDir, "bin");
    const restrictedPath = [
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      fs.existsSync(binDir) ? binDir : "",
    ]
      .filter(Boolean)
      .join(path.delimiter);

    gemini = spawn(
      GEMINI_CMD,
      [
        "--experimental-acp",
        "--output-format",
        "stream-json",
        "--resume",
        "latest",
        "-y",
        "--extensions",
        "",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: rootDir,
        env: {
          PYTHONUNBUFFERED: "1",
          PATH: restrictedPath,
        },
      },
    );

    gemini.stdout?.on("data", (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      // Keep the last partial line in the buffer
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processGeminiOutput(trimmed, { ...ctx, gemini }, sendACP);
      }
    });

    gemini.stderr?.on("data", (data: Buffer) => {
      log(data.toString(), "ERROR");
    });

    gemini.on("error", (err) => {
      log(`Failed to start Gemini process: ${err.message}`, "ERROR");
      socket.emit("status", "Error: Failed to start Gemini CLI");
    });

    gemini.on("exit", (code) => {
      log(`Gemini process exited with code ${code}`, "INFO");
      if (code !== 0 && code !== null) {
        socket.emit("status", `Process crashed (code ${code})`);
      }
    });

    socket.emit("status", "Initializing...");
    sendACP({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 0,
        clientInfo: { name: "meridian-ai", version: "1.0" },
        capabilities: {},
      },
    });
  });

  socket.on("diretriz", (text: string) => {
    if (!sessionId || !gemini?.stdin) return;
    promptStartTime = Date.now();
    const promptMsg = {
      jsonrpc: "2.0",
      id: requestId++,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: text.trim() }] },
    };
    gemini.stdin.write(`${JSON.stringify(promptMsg)}\n`);
  });
});

httpServer.listen(PORT, () => {
  // Logging server startup is useful for monitoring server status in production
  console.log(`
🚀 Meridian running at http://localhost:${PORT}`); // skipcq: JS-0002
});
