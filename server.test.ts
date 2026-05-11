import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSettings,
  getContextServices,
  log,
  handleSessionUpdate,
  handleInitialize,
  handleRequestComplete,
  processGeminiOutput,
  type GeminiContext,
} from "./server";
import fs from "node:fs";
import { Socket } from "socket.io";
import { TelemetryCollectorService } from "./src/services/TelemetryCollectorService";
import { AgentRegistryService, type Agent } from "./src/services/AgentRegistryService";
import { BootstrappingService } from "./src/services/BootstrappingService";
import { TrackMetadataService, type TrackMetadata } from "./src/services/TrackMetadataService";
import { ProjectService, type Project } from "./src/services/ProjectService";
import { NodeFileSystem } from "./src/services/implementations/NodeFileSystem";
import { OrchestrationService } from "./src/services/OrchestrationService";

// Mock services and modules
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

const { mSocket, mIO, mChildProcess, state, mSpawn, mExec } = vi.hoisted(() => ({
  mSpawn: vi.fn(),
  mExec: vi.fn(),
  state: { connectionHandler: null as ((socket: unknown) => void) | null },
  mSocket: {
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  },
  mIO: {
    on: vi.fn(),
    emit: vi.fn(),
  },
  mChildProcess: {
    stdin: {
      write: vi.fn(),
      writable: true,
    },
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn(),
    kill: vi.fn(),
  },
}));

vi.mock("socket.io", () => {
  return {
    Server: vi.fn(function () {
      mIO.on.mockImplementation((event: string, handler: (socket: unknown) => void) => {
        if (event === "connection") state.connectionHandler = handler;
      });
      return mIO;
    }),
    Socket: vi.fn(function () {
      return mSocket;
    }),
  };
});

const { mApp } = vi.hoisted(() => ({
  mApp: {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn(),
  }
}));

vi.mock("express", () => {
  const mExpress = vi.fn(() => mApp) as ReturnType<typeof vi.fn> & { static: ReturnType<typeof vi.fn> };
  mExpress.static = vi.fn();
  return {
    default: mExpress,
  };
});

vi.mock("node:http", () => {
  const mHttpServer = {
    listen: vi.fn((port, cb) => {
      if (cb) cb();
    }),
  };
  return {
    createServer: vi.fn(() => mHttpServer),
    default: {
      createServer: vi.fn(() => mHttpServer),
    },
  };
});

vi.mock("node:child_process", () => {
  mSpawn.mockImplementation(() => mChildProcess);
  return {
    spawn: mSpawn,
    exec: mExec,
    default: {
      spawn: mSpawn,
      exec: mExec,
    },
  };
});

vi.mock("./src/services/implementations/NodeFileSystem");
vi.mock("./src/services/AgentRegistryService");
vi.mock("./src/services/TrackMetadataService");
vi.mock("./src/services/BootstrappingService");
vi.mock("./src/services/SDSComplianceScorer");
vi.mock("./src/services/TelemetryCollectorService");
vi.mock("./src/services/ProjectService");
vi.mock("./src/services/OrchestrationService");
vi.mock("./src/services/ValidationEngine");
vi.mock("./src/services/SessionManagerService");
vi.mock("./src/services/implementations/NodeFilesystemWatcher");

function makeCtx(overrides: Partial<GeminiContext>): GeminiContext {
  return {
    globalContent: "",
    agentInstructions: "",
    rootDir: "",
    socket: { emit: vi.fn() } as unknown as Socket,
    telemetryCollector: new TelemetryCollectorService(),
    setSessionId: vi.fn(),
    setPromptStartTime: vi.fn(),
    getPromptStartTime: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe("server.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getSettings", () => {
    it("returns default settings if file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const settings = getSettings();
      expect(settings).toEqual({ rootDir: process.cwd() });
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("returns parsed settings if file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ rootDir: "/custom" }),
      );
      const settings = getSettings();
      expect(settings.rootDir).toBe("/custom");
    });

    it("returns default settings if parsing fails", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");
      const settings = getSettings();
      expect(settings).toEqual({ rootDir: process.cwd() });
    });

    it("overrides rootDir if MERIDIAN_ROOT is set", () => {
      const originalRoot = process.env.MERIDIAN_ROOT;
      process.env.MERIDIAN_ROOT = "/env/root";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ rootDir: "/custom" }),
      );
      
      const settings = getSettings();
      expect(settings.rootDir).toBe("/env/root");
      
      if (originalRoot === undefined) {
        delete process.env.MERIDIAN_ROOT;
      } else {
        process.env.MERIDIAN_ROOT = originalRoot;
      }
    });
  });

  describe("getContextServices", () => {
    it("returns all core services", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ rootDir: "/test" }),
      );
      const services = getContextServices();
      expect(services.rootDir).toBe("/test");
      expect(services.agentRegistry).toBeDefined();
      expect(services.trackMetadataService).toBeDefined();
    });
  });

  describe("log", () => {
    it("logs messages to console.error", () => {
      const spy = vi.spyOn(console, "error").mockReturnValue();
      log("test message", "INFO");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("test message"));
      spy.mockRestore();
    });
  });

  describe("handleSessionUpdate", () => {
    it("records tokens and emits chunk event", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      const message = {
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hello" },
          },
        },
      };

      handleSessionUpdate(message, socketMock, telemetryMock);

      expect(telemetryMock.recordMetric).toHaveBeenCalledWith("tokens", 2);
      expect(socketMock.emit).toHaveBeenCalledWith("chunk", "hello");
    });

    it("uses empty string if content text is missing in agent_message_chunk", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      const message = {
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {},
          },
        },
      };

      handleSessionUpdate(message, socketMock, telemetryMock);

      expect(telemetryMock.recordMetric).toHaveBeenCalledWith("tokens", 0);
      expect(socketMock.emit).toHaveBeenCalledWith("chunk", "");
    });

    it("does nothing for other session updates", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      handleSessionUpdate(
        { params: { update: { sessionUpdate: "other" } } },
        socketMock,
        telemetryMock,
      );
      expect(socketMock.emit).not.toHaveBeenCalled();
    });
  });

  describe("handleInitialize", () => {
    it("sends session/new message via sendACP", () => {
      const sendACP = vi.fn();
      const ctx = makeCtx({
        rootDir: "/root",
        globalContent: "global",
        agentInstructions: "instruct",
      });

      handleInitialize(sendACP, ctx);

      expect(sendACP).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "session/new",
          params: expect.objectContaining({
            cwd: "/root",
          }),
        }),
      );
    });
  });

  describe("handleRequestComplete", () => {
    it("records latency and emits done", () => {
      const telemetryMock = new TelemetryCollectorService();
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const ctx = makeCtx({
        getPromptStartTime: () => 1000,
        setPromptStartTime: vi.fn(),
        telemetryCollector: telemetryMock,
        socket: socketMock,
      });

      vi.spyOn(Date, "now").mockReturnValue(2000);

      handleRequestComplete(ctx);

      expect(telemetryMock.recordMetric).toHaveBeenCalledWith("latency", 1000);
      expect(ctx.setPromptStartTime).toHaveBeenCalledWith(null);
      expect(socketMock.emit).toHaveBeenCalledWith("done");
    });

    it("emits done even if start time is missing", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const ctx = makeCtx({
        getPromptStartTime: () => null,
        socket: socketMock,
      });

      handleRequestComplete(ctx);
      expect(socketMock.emit).toHaveBeenCalledWith("done");
    });
  });

  describe("processGeminiOutput", () => {
    it("ignores malformed JSON", () => {
      const ctx = makeCtx({});
      const sendACP = vi.fn();
      expect(() =>
        processGeminiOutput("invalid", ctx, sendACP),
      ).not.toThrow();
    });

    it("calls handleSessionUpdate for session/update method", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      const ctx = makeCtx({ socket: socketMock, telemetryCollector: telemetryMock });
      const sendACP = vi.fn();
      const line = JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi" },
          },
        },
      });

      processGeminiOutput(line, ctx, sendACP);
      expect(socketMock.emit).toHaveBeenCalledWith("chunk", "hi");
    });

    it("calls handleInitialize for message with ID 1", () => {
      const sendACP = vi.fn();
      const ctx = makeCtx({ rootDir: "/r", globalContent: "g", agentInstructions: "i" });
      const line = JSON.stringify({ id: 1, result: {} });

      processGeminiOutput(line, ctx, sendACP);
      expect(sendACP).toHaveBeenCalledWith(
        expect.objectContaining({ method: "session/new" }),
      );
    });

    it("sets sessionId and emits ready for message with ID 2", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const setSessionId = vi.fn();
      const ctx = makeCtx({ socket: socketMock, setSessionId });
      const line = JSON.stringify({ id: 2, result: { sessionId: "sess-123" } });

      processGeminiOutput(line, ctx, vi.fn());
      expect(setSessionId).toHaveBeenCalledWith("sess-123");
      expect(socketMock.emit).toHaveBeenCalledWith("ready");
    });

    it("does nothing for message with ID 2 if sessionId is missing", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const setSessionId = vi.fn();
      const ctx = makeCtx({ socket: socketMock, setSessionId });
      const line = JSON.stringify({ id: 2, result: {} }); // Missing sessionId

      processGeminiOutput(line, ctx, vi.fn());
      expect(setSessionId).not.toHaveBeenCalled();
      expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it("calls handleRequestComplete for message with ID >= 3 and result", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const ctx = makeCtx({
        socket: socketMock,
        getPromptStartTime: () => null,
        setPromptStartTime: vi.fn(),
      });
      const line = JSON.stringify({ id: 3, result: {} });

      processGeminiOutput(line, ctx, vi.fn());
      expect(socketMock.emit).toHaveBeenCalledWith("done");
    });
  });

  describe("Socket Connection", () => {
    beforeEach(() => {
      vi.mocked(AgentRegistryService.prototype.getAgents).mockReturnValue([
        { id: "a1", name: "Agent 1", role: "Role 1" }
      ]);
      vi.mocked(BootstrappingService.prototype.resolveAgent).mockReturnValue("resolved-a1");
      vi.mocked(fs.existsSync).mockReturnValue(false); // For core/global.md
    });

    it("registers socket event handlers on connection", () => {
      const socket = { on: vi.fn() };
      state.connectionHandler(socket);
      
      const registeredEvents = vi.mocked(socket.on).mock.calls.map(call => call[0]);
      expect(registeredEvents).toContain("disconnect");
      expect(registeredEvents).toContain("start-session");
      expect(registeredEvents).toContain("diretriz");
    });

    it("handles start-session and spawns gemini", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);

      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      
      startSessionHandler();

      expect(mSpawn).toHaveBeenCalledWith("gemini", expect.anything(), expect.anything());
      expect(socket.emit).toHaveBeenCalledWith("status", "Initializing...");
    });

    it("handles gemini stdout data", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const stdoutOnHandler = vi.mocked(mChildProcess.stdout.on).mock.calls.find(call => call[0] === "data")?.[1];
      
      // Simulate partial JSON lines
      stdoutOnHandler(Buffer.from('{"method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "Hello"}}}}'));
      stdoutOnHandler(Buffer.from('\n{"id": 2, "result": {"sessionId": "s1"}}\n'));

      expect(socket.emit).toHaveBeenCalledWith("chunk", "Hello");
      expect(socket.emit).toHaveBeenCalledWith("ready");
    });

    it("handles gemini stderr data", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const stderrOnHandler = vi.mocked(mChildProcess.stderr.on).mock.calls.find(call => call[0] === "data")?.[1];
      const spy = vi.spyOn(console, "error").mockReturnValue();
      
      stderrOnHandler(Buffer.from("some error"));
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("handles gemini process error", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const errorHandler = vi.mocked(mChildProcess.on).mock.calls.find(call => call[0] === "error")?.[1];
      errorHandler({ message: "failed to start" });

      expect(socket.emit).toHaveBeenCalledWith("status", "Error: Failed to start Gemini CLI");
    });

    it("handles empty trimmed lines in gemini stdout data", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const stdoutOnHandler = vi.mocked(mChildProcess.stdout.on).mock.calls.find(call => call[0] === "data")?.[1];
      
      // Sending only whitespaces
      stdoutOnHandler(Buffer.from('   \n  \t  \n'));

      // Process output shouldn't be called for empty strings
      expect(socket.emit).not.toHaveBeenCalledWith("chunk", expect.anything());
    });

    it("handles gemini process exit with null, undefined, or zero code", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const exitHandler = vi.mocked(mChildProcess.on).mock.calls.find(call => call[0] === "exit")?.[1];
      
      socket.emit.mockClear();
      exitHandler(0);
      expect(socket.emit).not.toHaveBeenCalledWith("status", expect.stringContaining("Process crashed"));

      socket.emit.mockClear();
      exitHandler(null);
      expect(socket.emit).not.toHaveBeenCalledWith("status", expect.stringContaining("Process crashed"));

      socket.emit.mockClear();
      exitHandler(undefined);
      expect(socket.emit).toHaveBeenCalledWith("status", expect.stringContaining("Process crashed"));
    });

    it("ignores sendACP if stdin is not writable", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      mChildProcess.stdin.writable = false;
      mChildProcess.stdin.write.mockClear();
      const stdoutOnHandler = vi.mocked(mChildProcess.stdout.on).mock.calls.find(call => call[0] === "data")?.[1];
      stdoutOnHandler(Buffer.from('{"id": 1, "result": {}}\n'));

      expect(mChildProcess.stdin.write).not.toHaveBeenCalled();
      mChildProcess.stdin.writable = true; // restore
    });

    it("calls handleInitialize for message with ID 1 and calls sendACP", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      mChildProcess.stdin.writable = true;
      mChildProcess.stdin.write.mockClear();
      const stdoutOnHandler = vi.mocked(mChildProcess.stdout.on).mock.calls.find(call => call[0] === "data")?.[1];
      
      const spy = vi.spyOn(console, "error").mockReturnValue();
      stdoutOnHandler(Buffer.from('{"id": 1, "result": {}}\n'));

      // Check if sendACP was called
      expect(mChildProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining("session/new"));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("OUT"));
      spy.mockRestore();
    });

    it("handles diretriz event and tests prompt times", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const stdoutOnHandler = vi.mocked(mChildProcess.stdout.on).mock.calls.find(call => call[0] === "data")?.[1];
      stdoutOnHandler(Buffer.from('{"id": 2, "result": {"sessionId": "s1"}}\n'));

      const diretrizHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "diretriz")?.[1];
      diretrizHandler("test prompt");

      expect(mChildProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining("test prompt"));

      // Complete the request to check prompt time reset
      stdoutOnHandler(Buffer.from('{"id": 3, "result": {}}\n'));
      expect(socket.emit).toHaveBeenCalledWith("done");
    });

    it("handles disconnect and cleans up gemini", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      const disconnectHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "disconnect")?.[1];
      disconnectHandler();

      expect(mChildProcess.kill).toHaveBeenCalled();
    });

    it("reads global.md if it exists during start-session", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("global content");

      const startSessionHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "start-session")?.[1];
      startSessionHandler();

      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining("global.md"), "utf8");
    });

    it("ignores diretriz event if sessionId or gemini.stdin is missing", () => {
      const socket = { on: vi.fn(), emit: vi.fn() };
      state.connectionHandler(socket);
      
      const diretrizHandler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "diretriz")?.[1];
      
      // Should return early, not writing anything
      diretrizHandler("test prompt");
      expect(mChildProcess.stdin.write).not.toHaveBeenCalled();
    });

    describe("New Handlers", () => {
      let socket: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };

      beforeEach(() => {
        socket = { on: vi.fn(), emit: vi.fn() };
        state.connectionHandler(socket);
      });

      it("handles list-dir-contents for a valid directory", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "list-dir-contents")?.[1];
        
        vi.mocked(NodeFileSystem.prototype.exists).mockReturnValue(true);
        vi.mocked(NodeFileSystem.prototype.readDirectory).mockReturnValue(["dir1", "file1", "dir2"]);
        vi.mocked(NodeFileSystem.prototype.isDirectory).mockImplementation((path: string) => 
          path === "/test" || path.includes("dir")
        );

        handler("/test");

        expect(socket.emit).toHaveBeenCalledWith("dir-contents", ["dir1", "dir2"]);
      });

      it("handles list-dir-contents for a non-existent directory", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "list-dir-contents")?.[1];
        vi.mocked(NodeFileSystem.prototype.exists).mockReturnValue(false);

        handler("/invalid");

        expect(socket.emit).toHaveBeenCalledWith("dir-contents", []);
      });

      it("handles list-dir-contents for a path that is not a directory", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "list-dir-contents")?.[1];
        vi.mocked(NodeFileSystem.prototype.exists).mockReturnValue(true);
        vi.mocked(NodeFileSystem.prototype.isDirectory).mockReturnValue(false);

        handler("/file.txt");

        expect(socket.emit).toHaveBeenCalledWith("dir-contents", []);
      });

      it("handles list-dir-contents when error occurs", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "list-dir-contents")?.[1];
        
        vi.mocked(NodeFileSystem.prototype.exists).mockImplementation(() => { throw new Error("FS Error"); });
        const spy = vi.spyOn(console, "error").mockReturnValue();

        handler("/error");

        expect(socket.emit).toHaveBeenCalledWith("dir-contents", []);
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("Error listing directory"));
        spy.mockRestore();
      });

      it("handles list-dir-contents when nested isDirectory throws", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "list-dir-contents")?.[1];
        
        vi.mocked(NodeFileSystem.prototype.exists).mockReturnValue(true);
        vi.mocked(NodeFileSystem.prototype.readDirectory).mockReturnValue(["dir1"]);
        vi.mocked(NodeFileSystem.prototype.isDirectory).mockImplementation((path: string) => {
          if (path === "/test") return true;
          throw new Error("Nested Error");
        });

        handler("/test");

        expect(socket.emit).toHaveBeenCalledWith("dir-contents", []);
      });

      it("handles get-parent-dir", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-parent-dir")?.[1];
        handler("/test/path");
        expect(socket.emit).toHaveBeenCalledWith("parent-dir", expect.stringContaining("test"));
      });

      it("handles get-settings", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-settings")?.[1];
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ rootDir: "/test" }));

        handler();

        expect(socket.emit).toHaveBeenCalledWith("settings", { rootDir: "/test" });
      });

      it("handles save-settings", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "save-settings")?.[1];
        const newSettings = { rootDir: "/new" };

        handler(newSettings);

        expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), JSON.stringify(newSettings, null, 2));
        expect(socket.emit).toHaveBeenCalledWith("settings-saved", newSettings);
      });

      it("handles get-agents", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-agents")?.[1];
        const agents = [{ id: "1", name: "A1" }];
        vi.mocked(AgentRegistryService.prototype.getAgents).mockReturnValue(agents as Agent[]);

        handler();

        expect(socket.emit).toHaveBeenCalledWith("agents", agents);
      });

      it("handles save-agents", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "save-agents")?.[1];
        const agents = [{ id: "1", name: "A1" }];

        handler(agents);

        expect(AgentRegistryService.prototype.saveAgents).toHaveBeenCalledWith(agents);
        expect(socket.emit).toHaveBeenCalledWith("agents-saved");
      });

      it("handles get-tracks", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-tracks")?.[1];
        const tracks = [{ id: "t1", name: "Track 1" }];
        vi.mocked(TrackMetadataService.prototype.listTracksWithMetadata).mockReturnValue(tracks as TrackMetadata[]);

        handler();

        expect(socket.emit).toHaveBeenCalledWith("tracks", tracks);
      });

      it("handles get-projects", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-projects")?.[1];
        const projects = [{ id: "p1", name: "Proj 1" }];
        vi.mocked(ProjectService.prototype.listProjects).mockReturnValue(projects as Project[]);

        handler();

        expect(socket.emit).toHaveBeenCalledWith("projects", projects);
      });

      it("handles save-project-config", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "save-project-config")?.[1];
        const config = { name: "New Proj" };
        const projects = [{ id: "p1", name: "New Proj" }];
        vi.mocked(ProjectService.prototype.listProjects).mockReturnValue(projects as Project[]);

        handler({ projectPath: "/proj", config });

        expect(ProjectService.prototype.saveProjectConfig).toHaveBeenCalledWith("/proj", config);
        expect(socket.emit).toHaveBeenCalledWith("project-config-saved");
        expect(mIO.emit).toHaveBeenCalledWith("projects", projects);
      });

      it("handles save-project-config with error", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "save-project-config")?.[1];
        const config = { name: "New Proj" };
        vi.mocked(ProjectService.prototype.saveProjectConfig).mockImplementation(() => {
          throw new Error("test error");
        });
        const consoleSpy = vi.spyOn(console, "error").mockReturnValue();

        handler({ projectPath: "/proj", config });

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });

      it("handles get-file-content", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-file-content")?.[1];
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue("file content");

        handler({ trackId: "t1", fileName: "spec.md" });

        expect(socket.emit).toHaveBeenCalledWith("file-content", {
          trackId: "t1",
          fileName: "spec.md",
          content: "file content"
        });
      });

      it("does not emit file-content if file does not exist", () => {
        const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "get-file-content")?.[1];
        vi.mocked(fs.existsSync).mockReturnValue(false);

        handler({ trackId: "t1", fileName: "spec.md" });

        expect(socket.emit).not.toHaveBeenCalledWith("file-content", expect.anything());
      });

      describe("Orchestration Handlers", () => {
        it("handles orchestration:request-transition", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:request-transition")?.[1];
          const payload = { trackId: "t1", targetPhase: "PLANNING", message: "start", trigger: "USER" };
          const tracks = [{ id: "t1", metadata: {} }];
          vi.mocked(TrackMetadataService.prototype.listTracksWithMetadata).mockReturnValue(tracks as any);

          handler(payload);

          expect(OrchestrationService.prototype.requestTransition).toHaveBeenCalledWith("t1", "PLANNING", "start", "USER");
          expect(mIO.emit).toHaveBeenCalledWith("tracks", tracks);
        });

        it("handles orchestration:request-transition error", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:request-transition")?.[1];
          vi.mocked(OrchestrationService.prototype.requestTransition).mockImplementation(() => {
            throw new Error("transition error");
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler({ trackId: "t1" });

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "transition error" });
          spy.mockRestore();
        });

        it("handles orchestration:request-transition error (non-Error)", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:request-transition")?.[1];
          vi.mocked(OrchestrationService.prototype.requestTransition).mockImplementation(() => {
            throw "string error";
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler({ trackId: "t1" });

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "string error" });
          spy.mockRestore();
        });

        it("handles orchestration:update-status", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:update-status")?.[1];
          const payload = { trackId: "t1", status: "IN_PROGRESS", message: "working", trigger: "SYSTEM" };
          const tracks = [{ id: "t1", metadata: {} }];
          vi.mocked(TrackMetadataService.prototype.listTracksWithMetadata).mockReturnValue(tracks as any);

          handler(payload);

          expect(OrchestrationService.prototype.updateStatus).toHaveBeenCalledWith("t1", "IN_PROGRESS", "working", "SYSTEM");
          expect(mIO.emit).toHaveBeenCalledWith("tracks", tracks);
        });

        it("handles orchestration:update-status error", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:update-status")?.[1];
          vi.mocked(OrchestrationService.prototype.updateStatus).mockImplementation(() => {
            throw new Error("status error");
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler({ trackId: "t1" });

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "status error" });
          spy.mockRestore();
        });

        it("handles orchestration:update-status error (non-Error)", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:update-status")?.[1];
          vi.mocked(OrchestrationService.prototype.updateStatus).mockImplementation(() => {
            throw "status string error";
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler({ trackId: "t1" });

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "status string error" });
          spy.mockRestore();
        });

        it("handles orchestration:get-state", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:get-state")?.[1];
          const state = { currentPhase: "SPEC", status: "IDLE" };
          vi.mocked(OrchestrationService.prototype.getOrchestrationState).mockReturnValue(state as any);

          handler("t1");

          expect(OrchestrationService.prototype.getOrchestrationState).toHaveBeenCalledWith("t1");
          expect(socket.emit).toHaveBeenCalledWith("orchestration:state", { trackId: "t1", state });
        });

        it("handles orchestration:get-state error", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:get-state")?.[1];
          vi.mocked(OrchestrationService.prototype.getOrchestrationState).mockImplementation(() => {
            throw new Error("state error");
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler("t1");

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "state error" });
          spy.mockRestore();
        });

        it("handles orchestration:get-state error (non-Error)", () => {
          const handler = vi.mocked(socket.on).mock.calls.find(call => call[0] === "orchestration:get-state")?.[1];
          vi.mocked(OrchestrationService.prototype.getOrchestrationState).mockImplementation(() => {
            throw "state string error";
          });
          const spy = vi.spyOn(console, "error").mockReturnValue();

          handler("t1");

          expect(socket.emit).toHaveBeenCalledWith("orchestration:error", { message: "state string error" });
          spy.mockRestore();
        });
      });
    });
  });

  describe("Module initialization", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      vi.resetModules();
      mApp.get.mockClear();
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("does not create SETTINGS_DIR if it already exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.mkdirSync).mockClear();
      
      await import("./server");
      
      // The exact call with SETTINGS_DIR should not have happened
      const mkdirCalls = vi.mocked(fs.mkdirSync).mock.calls;
      expect(mkdirCalls.length).toBe(0);
    });

    it("uses MERIDIAN_ROOT for DEFAULT_SETTINGS if set", async () => {
      const originalRoot = process.env.MERIDIAN_ROOT;
      process.env.MERIDIAN_ROOT = "/env/root/init";
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const serverModule = await import("./server");
      const settings = serverModule.getSettings();
      
      expect(settings.rootDir).toBe("/env/root/init");
      
      if (originalRoot === undefined) {
        delete process.env.MERIDIAN_ROOT;
      } else {
        process.env.MERIDIAN_ROOT = originalRoot;
      }
    });

    it("registers fallback route to index.html in production mode", async () => {
      process.env.NODE_ENV = "production";
      await import("./server");

      const getCall = mApp.get.mock.calls.find(call => call[0].toString() === "/^(?!\\/socket\\.io).+/");
      expect(getCall).toBeDefined();

      const handler = getCall[1];
      const mockReq = {};
      const mockRes = { sendFile: vi.fn() };

      handler(mockReq, mockRes);
      expect(mockRes.sendFile).toHaveBeenCalledWith(expect.stringContaining("index.html"));
    });

    it("does not register a fallback route in development mode", async () => {
      process.env.NODE_ENV = "development";
      await import("./server");

      const getCall = mApp.get.mock.calls.find(call => call[0].toString() === "/^(?!\\/socket\\.io).+/");
      expect(getCall).toBeUndefined();
    });
  });
});
