import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import * as server from "./server";
import fs from "node:fs";
import { Socket } from "socket.io";
import { TelemetryCollectorService } from "./src/services/TelemetryCollectorService";
import { AgentRegistryService } from "./src/services/AgentRegistryService";
import { BootstrappingService } from "./src/services/BootstrappingService";

// Mock services and modules
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

const { mSocket, mIO, mChildProcess, state, mSpawn } = vi.hoisted(() => ({
  mSpawn: vi.fn(),
  state: { connectionHandler: null as any },
  mSocket: {
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  },
  mIO: {
    on: vi.fn(),
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
      mIO.on.mockImplementation((event: string, handler: any) => {
        if (event === "connection") state.connectionHandler = handler;
      });
      return mIO;
    }),
    Socket: vi.fn(function () {
      return mSocket;
    }),
  };
});

vi.mock("express", () => {
  const mApp = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn(),
  };
  const mExpress: any = vi.fn(() => mApp);
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
    default: {
      spawn: mSpawn,
    },
  };
});

vi.mock("./src/services/implementations/NodeFileSystem");
vi.mock("./src/services/AgentRegistryService");
vi.mock("./src/services/TrackMetadataService");
vi.mock("./src/services/BootstrappingService");
vi.mock("./src/services/SDSComplianceScorer");
vi.mock("./src/services/TelemetryCollectorService");

describe("server.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getSettings", () => {
    it("returns default settings if file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const settings = server.getSettings();
      expect(settings).toEqual({ rootDir: process.cwd() });
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("returns parsed settings if file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ rootDir: "/custom" }),
      );
      const settings = server.getSettings();
      expect(settings.rootDir).toBe("/custom");
    });

    it("returns default settings if parsing fails", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");
      const settings = server.getSettings();
      expect(settings).toEqual({ rootDir: process.cwd() });
    });
  });

  describe("getContextServices", () => {
    it("returns all core services", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ rootDir: "/test" }),
      );
      const services = server.getContextServices();
      expect(services.rootDir).toBe("/test");
      expect(services.agentRegistry).toBeDefined();
      expect(services.trackMetadataService).toBeDefined();
    });
  });

  describe("log", () => {
    it("logs messages to console.error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      server.log("test message", "INFO");
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

      server.handleSessionUpdate(message, socketMock, telemetryMock);

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

      server.handleSessionUpdate(message, socketMock, telemetryMock);

      expect(telemetryMock.recordMetric).toHaveBeenCalledWith("tokens", 0);
      expect(socketMock.emit).toHaveBeenCalledWith("chunk", "");
    });

    it("does nothing for other session updates", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      server.handleSessionUpdate(
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
      const ctx = {
        rootDir: "/root",
        globalContent: "global",
        agentInstructions: "instruct",
      } as any;

      server.handleInitialize(sendACP, ctx);

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
      const ctx = {
        getPromptStartTime: () => 1000,
        setPromptStartTime: vi.fn(),
        telemetryCollector: telemetryMock,
        socket: socketMock,
      } as any;

      vi.spyOn(Date, "now").mockReturnValue(2000);

      server.handleRequestComplete(ctx);

      expect(telemetryMock.recordMetric).toHaveBeenCalledWith("latency", 1000);
      expect(ctx.setPromptStartTime).toHaveBeenCalledWith(null);
      expect(socketMock.emit).toHaveBeenCalledWith("done");
    });

    it("emits done even if start time is missing", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const ctx = {
        getPromptStartTime: () => null,
        socket: socketMock,
      } as any;

      server.handleRequestComplete(ctx);
      expect(socketMock.emit).toHaveBeenCalledWith("done");
    });
  });

  describe("processGeminiOutput", () => {
    it("ignores malformed JSON", () => {
      const ctx = {} as any;
      const sendACP = vi.fn();
      expect(() =>
        server.processGeminiOutput("invalid", ctx, sendACP),
      ).not.toThrow();
    });

    it("calls handleSessionUpdate for session/update method", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const telemetryMock = new TelemetryCollectorService();
      const ctx = { socket: socketMock, telemetryCollector: telemetryMock };
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

      server.processGeminiOutput(line, ctx as any, sendACP);
      expect(socketMock.emit).toHaveBeenCalledWith("chunk", "hi");
    });

    it("calls handleInitialize for message with ID 1", () => {
      const sendACP = vi.fn();
      const ctx = { rootDir: "/r", globalContent: "g", agentInstructions: "i" };
      const line = JSON.stringify({ id: 1, result: {} });

      server.processGeminiOutput(line, ctx as any, sendACP);
      expect(sendACP).toHaveBeenCalledWith(
        expect.objectContaining({ method: "session/new" }),
      );
    });

    it("sets sessionId and emits ready for message with ID 2", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const setSessionId = vi.fn();
      const ctx = { socket: socketMock, setSessionId };
      const line = JSON.stringify({ id: 2, result: { sessionId: "sess-123" } });

      server.processGeminiOutput(line, ctx as any, vi.fn());
      expect(setSessionId).toHaveBeenCalledWith("sess-123");
      expect(socketMock.emit).toHaveBeenCalledWith("ready");
    });

    it("does nothing for message with ID 2 if sessionId is missing", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const setSessionId = vi.fn();
      const ctx = { socket: socketMock, setSessionId };
      const line = JSON.stringify({ id: 2, result: {} }); // Missing sessionId

      server.processGeminiOutput(line, ctx as any, vi.fn());
      expect(setSessionId).not.toHaveBeenCalled();
      expect(socketMock.emit).not.toHaveBeenCalled();
    });

    it("calls handleRequestComplete for message with ID >= 3 and result", () => {
      const socketMock = { emit: vi.fn() } as unknown as Socket;
      const ctx = {
        socket: socketMock,
        getPromptStartTime: () => null,
        setPromptStartTime: vi.fn(),
      };
      const line = JSON.stringify({ id: 3, result: {} });

      server.processGeminiOutput(line, ctx as any, vi.fn());
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
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      
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
      
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
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
  });

  describe("Module initialization", () => {
    it("does not create SETTINGS_DIR if it already exists", async () => {
      vi.resetModules();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.mkdirSync).mockClear();
      
      await import("./server");
      
      // The exact call with SETTINGS_DIR should not have happened
      const mkdirCalls = vi.mocked(fs.mkdirSync).mock.calls;
      expect(mkdirCalls.length).toBe(0);
    });
  });
});
