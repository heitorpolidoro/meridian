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
import { GeminiMessage } from "./src/services/IPCSchemas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_DIR = path.join(__dirname, ".meridian");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR);

const fileSystem = new NodeFileSystem();
const telemetryCollector = new TelemetryCollectorService();

const DEFAULT_SETTINGS = { rootDir: process.cwd() };

/**
 * Retrieves the application settings from the settings file, ensuring the file exists with default settings.
 * If the settings file does not exist, it is created with DEFAULT_SETTINGS.
 * @returns {object} The settings object from the file or DEFAULT_SETTINGS if parsing fails.
 */
export function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE))
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Retrieves context-dependent services based on root directory.
 */
export function getContextServices() {
  const settings = getSettings();
  const rootDir = settings.rootDir;
  const meridianDir = path.join(rootDir, ".meridian");
  return {
    rootDir,
    meridianDir,
    agentRegistry: new AgentRegistryService(fileSystem, rootDir),
    trackMetadataService: new TrackMetadataService(fileSystem, meridianDir),
    bootstrappingService: new BootstrappingService(fileSystem, rootDir),
    complianceScorer: new SDSComplianceScorer(
      fileSystem,
      path.join(meridianDir, "tracks"),
    ),
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
app.use(express.static("dist"));

const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;
const GEMINI_CMD = "gemini";

interface GeminiContext {
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
    if (gemini?.stdin && gemini.stdin.writable) {
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
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
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
