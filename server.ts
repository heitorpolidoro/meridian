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
import { TelemetryCollectorService } from "./src/services/TelemetryCollectorService";
import { SDSComplianceScorer } from "./src/services/SDSComplianceScorer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_DIR = path.join(__dirname, ".meridian");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR);

const fileSystem = new NodeFileSystem();
const telemetryCollector = new TelemetryCollectorService();

const DEFAULT_SETTINGS = { rootDir: process.cwd() };

function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE))
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Saves settings to the configuration file.
 */
function saveSettings(settings: { rootDir: string }) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Retrieves context-dependent services based on root directory.
 */
/**
 * Retrieves context-dependent services based on root directory.
 */
function getContextServices() {
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
function log(msg: string, level: "OUT" | "IN" | "INFO" | "ERROR" = "INFO") {
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
}

/**
 * Main handler for Gemini output.
 */
function handleGeminiStream(
  data: Buffer,
  socket: Socket,
  sendACP: (msg: unknown) => void,
  ctx: GeminiContext,
) {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processGeminiOutput(trimmed, ctx, sendACP);
  }
}

/**
 * Parses and dispatches Gemini JSON outputs.
 */
function processGeminiOutput(
  jsonLine: string,
  ctx: GeminiContext,
  sendACP: (msg: unknown) => void,
) {
  try {
    const parsed: GeminiMessage = JSON.parse(jsonLine);
    if (parsed.id === 1) handleInitialize(sendACP, ctx);
    if (parsed.id === 2 && parsed.result?.sessionId) {
      ctx.setSessionId(parsed.result.sessionId);
      ctx.socket.emit("ready");
    }
    if (parsed.method === "session/update")
      handleSessionUpdate(parsed, ctx.socket, ctx.telemetryCollector);
    if (parsed.id !== undefined && parsed.id >= 3 && parsed.result)
      handleRequestComplete(ctx);
  } catch {
    /* Ignore malformed */
  }
}

/**
 * Initializes a new Gemini session.
 */
function handleInitialize(sendACP: (msg: unknown) => void, ctx: GeminiContext) {
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
function handleSessionUpdate(
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
function handleRequestComplete(ctx: GeminiContext) {
  const start = ctx.getPromptStartTime();
  if (start) {
    ctx.telemetryCollector.recordMetric("latency", Date.now() - start);
    ctx.setPromptStartTime(null);
  }
  ctx.socket.emit("done");
}

function log(msg: string, level: "OUT" | "IN" | "INFO" | "ERROR" = "INFO") {
  const timestamp = new Date().toLocaleTimeString();
  const colors = {
    INFO: "\x1b[32m",
    ERROR: "\x1b[31m",
    OUT: "\x1b[34m",
    IN: "\x1b[35m",
  };
  console.error(`${colors[level]}[${timestamp}] [${level}] ${msg}\x1b[0m`);
}

io.on("connection", (socket) => {
  let gemini: ChildProcess | null = null;
  let sessionId: string | null = null;
  let requestId = 3;
  let promptStartTime: number | null = null;

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

  const sendACP = (msg: unknown) => {
    if (gemini?.stdin) {
      gemini.stdin.write(`${JSON.stringify(msg)}\n`);
      log(JSON.stringify(msg), "OUT");
    }
  };

  socket.on("start-session", () => {
    if (gemini) gemini.kill();
    const { rootDir, meridianDir, agentRegistry, bootstrappingService } =
      getContextServices();
    const agents = agentRegistry.getAgents();
    ctx.rootDir = rootDir;
    ctx.globalContent = fs.existsSync(path.join(meridianDir, "core/global.md"))
      ? fs.readFileSync(path.join(meridianDir, "core/global.md"), "utf8")
      : "";
    ctx.agentInstructions = agents
      .map(
        (a: any) =>
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

    gemini.stdout?.on("data", (data: Buffer) =>
      handleGeminiStream(data, { ...ctx, gemini }),
    );
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

httpServer.listen(PORT, () =>
  console.log(`\n🚀 Meridian running at http://localhost:${PORT}`),
);
