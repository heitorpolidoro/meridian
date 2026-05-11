import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import "./App.css";
import "./components/TrackNavigator.css";
import "./components/AgentsTable.css";
import { MarkdownViewer } from "./components/MarkdownViewer/MarkdownViewer";
import { DirectoryPicker } from "./components/DirectoryPicker/DirectoryPicker";
import { OrchestrationPanel } from "./components/Orchestration/OrchestrationPanel";
import {
  TelemetrySummary,
  SDSCompliance,
  SyncConflict,
} from "./services/IPCSchemas";
import { TrackMetadata } from "./services/TrackMetadataService";

const socket = io();

function validateAgentForm(
  agent: Partial<{ name: string; role: string }>,
): boolean {
  return Boolean(agent.name && agent.role);
}

interface Agent {
  id: string;
  name: string;
  role: string;
  instruction: string;
  color: string;
}

interface Track {
  id: string;
  name: string;
  files: string[];
  metadata: TrackMetadata;
  activeSession?: {
    status: string;
    activeAgentId?: string;
  };
}

interface Project {
  id: string;
  name: string;
  path: string;
}

function App() {
  const [view, setView] = useState<
    | "dashboard"
    | "warroom"
    | "tracks"
    | "agents"
    | "settings"
    | "projects"
    | "project-home"
  >("dashboard");
  const [messages, setMessages] = useState<
    { id: string; text: string; type: string }[]
  >([]);
  const [status, setStatus] = useState("Initializing...");
  const [input, setInput] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [settings, setSettings] = useState({ rootDir: "" });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [flashes, setFlashes] = useState<{ id: number; text: string }[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySummary | null>(null);
  const [compliance, setCompliance] = useState<SDSCompliance[]>([]);
  const [_conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // Track Navigator States
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    name: string;
    content: string;
  } | null>(null);

  // Agent Management States
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<Partial<Agent>>({
    name: "",
    role: "",
    color: "#00c3ff",
    instruction: "",
  });
  const [editAgent, setEditAgent] = useState<Partial<Agent>>({});
  const [isProjectsOpen, setIsProjectsOpen] = useState(true);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectFormName, setProjectFormName] = useState("");

  const chatRef = useRef<HTMLDivElement>(null);
  const currentAiMsgRef = useRef<string>("");

  const showFlash = (text: string) => {
    const id = Date.now();
    setFlashes((prev) => [...prev, { id, text }]);
    setTimeout(
      () => setFlashes((prev) => prev.filter((f) => f.id !== id)),
      3000,
    );
  };

  const handleViewChange = (newView: typeof view) => {
    setView(newView);
    const actions: Partial<Record<typeof view, () => void>> = {
      warroom: () => {
        setMessages([]);
        socket.emit("start-session");
      },
      tracks: () => socket.emit("get-tracks"),
      agents: () => socket.emit("get-agents"),
      projects: () => socket.emit("get-projects"),
    };
    actions[newView]?.();
  };

  useEffect(() => {
    socket.emit("get-settings");
    socket.emit("get-agents");
    socket.emit("get-tracks");
    socket.emit("get-projects");

    socket.on("settings", (s) => {
      setSettings(s);
      socket.emit("get-projects");
    });
    socket.on("projects", (p) => {
      setProjects(p);
    });
    socket.on("tracks", (data) => setTracks(data));

    socket.on("telemetry-update", (data) => setTelemetry(data));
    socket.on("compliance-update", (data) => setCompliance(data));
    socket.on("sync-conflict", (data) => {
      setConflicts((prev) => [data, ...prev].slice(0, 5));
    });

    socket.on("file-content", (data) => {
      setSelectedFile({ name: data.fileName, content: data.content });
    });

    socket.on("status", (msg) => {
      setStatus(msg);
      setIsTyping(true);
    });

    socket.on("ready", () => {
      setIsReady(true);
      setIsTyping(false);
    });

    socket.on("chunk", (text) => {
      setIsTyping(false);
      currentAiMsgRef.current += text;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.type === "ai") {
          return [
            ...prev.slice(0, -1),
            { id: last.id, text: currentAiMsgRef.current, type: "ai" },
          ];
        }
        return [
          ...prev,
          { id: `ai-${Date.now()}`, text: currentAiMsgRef.current, type: "ai" },
        ];
      });
    });

    socket.on("done", () => {
      setIsTyping(false);
      setIsReady(true);
      currentAiMsgRef.current = "";
    });

    socket.on("settings-saved", () => showFlash("Settings saved."));
    socket.on("agents-saved", () => showFlash("Squad updated."));
    socket.on("project-config-saved", () =>
      showFlash("Project configuration saved."),
    );
    socket.on("orchestration:error", (data) =>
      showFlash(`Orchestration Error: ${data.message}`),
    );

    return () => {
      socket.off("settings");
      socket.off("agents");
      socket.off("tracks");
      socket.off("projects");
      socket.off("telemetry-update");
      socket.off("compliance-update");
      socket.off("sync-conflict");
      socket.off("file-content");
      socket.off("status");
      socket.off("ready");
      socket.off("chunk");
      socket.off("done");
      socket.off("settings-saved");
      socket.off("agents-saved");
      socket.off("project-config-saved");
      socket.off("orchestration:error");
    };
  }, [settings.rootDir]);

  useEffect(() => {
    if (chatRef.current)
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isTyping]);

  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const handleSelectProject = (project: Project) => {
    setSelectedProject(project);
    setProjectFormName(project.name);
    setTimeout(() => {
      // In this mode, we tell the backend to work on the selected project's path
      socket.emit("save-settings", { ...settings, rootDir: project.path });
      socket.emit("get-agents");
      socket.emit("get-tracks");
      setView("project-home");
    }, 100);
  };

  const handleSaveProjectConfig = () => {
    if (!selectedProject) return;

    socket.emit("save-project-config", {
      projectPath: selectedProject.path,
      config: { name: projectFormName },
    });
  };

  const handleSelectTrack = (track: Track) => {
    setSelectedTrack(track);
    setSelectedFile(null);
  };

  const handleSelectFile = (trackId: string, fileName: string) => {
    socket.emit("get-file-content", { trackId, fileName });
  };

  const handleNavigate = (path: string) => {
    if (!selectedTrack) return;
    const fileName = path.replace(/^(\.\/|\.\.\/)+/, "");
    handleSelectFile(selectedTrack.id, fileName);
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, text: input, type: "user" },
    ]);
    socket.emit("diretriz", input);
    setInput("");
    setIsReady(false);
    setIsTyping(true);
  };

  const handleDeleteAgent = (id: string) => {
    setConfirmDialog({
      show: true,
      message: "Delete this agent profile?",
      onConfirm: () => {
        const updated = agents.filter((a) => a.id !== id);
        socket.emit("save-agents", updated);
        setConfirmDialog(null);
      },
    });
  };

  const handleAddAgent = () => {
    if (!validateAgentForm(newAgent)) {
      showFlash("Name and Role are required.");
      return;
    }
    const id = newAgent.name.toLowerCase().replace(/\s+/g, "-");
    const agent: Agent = {
      id,
      name: newAgent.name,
      role: newAgent.role,
      color: newAgent.color || "#00c3ff",
      instruction: newAgent.instruction || "New agent.",
    };
    const updated = [...agents, agent];
    socket.emit("save-agents", updated);
    setIsAdding(false);
    setNewAgent({ name: "", role: "", color: "#00c3ff", instruction: "" });
  };

  const startEditing = (agent: Agent) => {
    setEditingId(agent.id);
    setEditAgent({ ...agent });
  };

  const handleSaveEdit = () => {
    if (!validateAgentForm(editAgent)) {
      showFlash("Name and Role are required.");
      return;
    }
    const updated = agents.map((a) =>
      a.id === editingId ? (editAgent as Agent) : a,
    );
    socket.emit("save-agents", updated);
    setEditingId(null);
  };

  const formatText = (text: string, messageId: string) => {
    const agentNames = agents.map((a) => a.name.toUpperCase());
    const regex = new RegExp(
      `(\\[(?:${agentNames.join("|")}|VERDICT)\\])`,
      "g",
    );
    const parts = text.split(regex);
    return parts.map((part, i) => {
      const name = part.replace(/[\[\]]/g, "");
      const agent = agents.find((a) => a.name.toUpperCase() === name);
      const key = `${messageId}-${i}`;
      if (agent)
        return (
          <span key={key} style={{ color: agent.color, fontWeight: "bold" }}>
            {part}
          </span>
        );
      if (part === "[VERDICT]")
        return (
          <span key={key} className="verdict">
            {part}
          </span>
        );
      return part;
    });
  };

  /** Renders the projects discovery view. */
  const renderProjectsView = () => (
    <div className="view projects-view">
      <header>
        <h1>Projects Discovery</h1>
      </header>
      <div className="projects-grid">
        {projects.length > 0 ? (
          projects.map((project) => (
            <button
              key={project.id}
              type="button"
              aria-current={
                settings.rootDir === project.path ? "true" : undefined
              }
              className={`project-card ${settings.rootDir === project.path ? "active" : ""}`}
              onClick={() => {
                handleSelectProject(project);
                setView("project-home");
              }}
            >
              <div className="project-icon">📂</div>
              <div className="project-info">
                <span className="project-title">{project.name}</span>
              </div>
              {settings.rootDir === project.path && (
                <div className="current-badge">Current</div>
              )}
            </button>
          ))
        ) : (
          <div className="no-projects">
            No projects found with .meridian directory in the workspace.
          </div>
        )}
      </div>
    </div>
  );

  /** Renders the governance dashboard view (now serving as the projects hub). */
  const renderDashboardView = () => (
    <div className="view projects-view">
      <header>
        <h1>Projects Hub</h1>
      </header>
      <div className="projects-grid">
        {projects.length > 0 ? (
          projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className="project-card"
              onClick={() => {
                handleSelectProject(project);
                setView("project-home");
              }}
            >
              <div className="project-icon">📂</div>
              <div className="project-info">
                <span className="project-title">{project.name}</span>
              </div>
            </button>
          ))
        ) : (
          <div className="no-projects">
            No projects found with .meridian directory in the workspace.
          </div>
        )}
      </div>
    </div>
  );

  /** Renders the track navigator view. */
  const renderTracksView = () => (
    <div className="view tracks-view">
      <header>
        <h1>Track Navigator</h1>
      </header>
      <div className="tracks-container">
        <div className="tracks-sidebar">
          <h3>Tracks</h3>
          <ul>
            {tracks.map((t) => (
              <li
                key={t.id}
                className={selectedTrack?.id === t.id ? "active" : ""}
                onClick={() => handleSelectTrack(t)}
              >
                <span>📁 {t.name}</span>
                <span className={`status-badge ${t.activeSession?.status}`}>
                  {t.activeSession?.status === "Working" ? "⏳ " : ""}
                  {t.activeSession?.status === "Idle" ? "💤 " : ""}
                  {t.activeSession?.status}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {selectedTrack && (
          <div className="files-sidebar">
            <h3>Files</h3>
            <ul>
              {selectedTrack.files.map((f) => (
                <li
                  key={f}
                  className={selectedFile?.name === f ? "active" : ""}
                  onClick={() => handleSelectFile(selectedTrack.id, f)}
                >
                  📄 {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="content-viewer">
          {selectedTrack && (
            <OrchestrationPanel
              trackId={selectedTrack.id}
              metadata={selectedTrack.metadata}
              socket={socket}
            />
          )}
          {selectedFile ? (
            <div className="viewer-wrapper">
              <h2>{selectedFile.name}</h2>
              <MarkdownViewer
                content={selectedFile.content}
                onNavigate={handleNavigate}
              />
            </div>
          ) : (
            <div className="viewer-placeholder">
              Select a file to preview documentation.
            </div>
          )}
        </div>
      </div>
    </div>
  );

  /** Renders the war room chat interface. */
  const renderWarRoomView = () => (
    <div className="view">
      <header>
        <h1>War Room</h1>
      </header>
      <div id="chat" ref={chatRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.type}`}>
            {formatText(m.text, m.id)}
          </div>
        ))}
        {isTyping && (
          <div className="typing">
            <div className="dot" />
            <div className="dot" />
            <div className="dot" />
          </div>
        )}
      </div>
      <footer>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === "Enter" && handleSend()}
          placeholder={isReady ? "Enter your directive..." : status}
          disabled={!isReady}
        />
        <button onClick={handleSend} disabled={!isReady}>
          Send
        </button>
      </footer>
    </div>
  );

  /** Renders a single agent row in the squad table. */
  const renderAgentRow = (agent: Agent) => {
    if (editingId === agent.id) {
      return (
        <tr key={agent.id}>
          <td>
            <input
              className="table-input"
              type="text"
              value={editAgent.name}
              onChange={(e) =>
                setEditAgent({ ...editAgent, name: e.target.value })
              }
            />
          </td>
          <td>
            <input
              className="table-input"
              type="text"
              value={editAgent.role}
              onChange={(e) =>
                setEditAgent({ ...editAgent, role: e.target.value })
              }
            />
          </td>
          <td>
            <input
              type="color"
              value={editAgent.color}
              onChange={(e) =>
                setEditAgent({ ...editAgent, color: e.target.value })
              }
            />
          </td>
          <td className="row-actions">
            <button className="save-row-btn" onClick={handleSaveEdit}>
              ✅
            </button>
            <button
              className="cancel-row-btn"
              onClick={() => setEditingId(null)}
            >
              ❌
            </button>
          </td>
        </tr>
      );
    }
    return (
      <tr key={agent.id}>
        <td className="agent-name-cell">{agent.name}</td>
        <td className="agent-role-cell">{agent.role}</td>
        <td className="agent-color-cell">
          <div
            className="color-swatch"
            style={{ backgroundColor: agent.color }}
          />
          <code>{agent.color}</code>
        </td>
        <td className="row-actions">
          <button className="edit-row-btn" onClick={() => startEditing(agent)}>
            ✏️
          </button>
          <button
            className="delete-row-btn"
            onClick={() => handleDeleteAgent(agent.id)}
          >
            🗑️
          </button>
        </td>
      </tr>
    );
  };

  /** Renders the form to add a new agent. */
  const renderAddAgentForm = () => {
    if (!isAdding) return null;
    return (
      <div className="quick-add-form">
        <input
          type="text"
          placeholder="Name"
          value={newAgent.name}
          onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
        />
        <input
          type="text"
          placeholder="Role"
          value={newAgent.role}
          onChange={(e) => setNewAgent({ ...newAgent, role: e.target.value })}
        />
        <input
          type="color"
          value={newAgent.color}
          onChange={(e) => setNewAgent({ ...newAgent, color: e.target.value })}
        />
        <button className="save-btn" onClick={handleAddAgent}>
          Save
        </button>
        <button className="cancel-btn" onClick={() => setIsAdding(false)}>
          Cancel
        </button>
      </div>
    );
  };

  /** Renders the active squad agent management view. */
  const renderAgentsView = () => (
    <div className="view">
      <header>
        <h1>Active Squad</h1>
      </header>
      <div className="agents-content">
        <div className="table-actions">
          <button className="add-btn" onClick={() => setIsAdding(true)}>
            + New Agent Profile
          </button>
        </div>

        {renderAddAgentForm()}

        <table className="agents-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role / Specialization</th>
              <th>Color</th>
              <th style={{ width: "100px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>{agents.map(renderAgentRow)}</tbody>
        </table>
        <footer className="table-footer">
          <p>
            Profiles are automatically discovered and synchronized with{" "}
            <code>.gemini/agents/</code>
          </p>
        </footer>
      </div>
    </div>
  );

  /** Renders the form inputs for the application settings. */
  const renderSettingsForm = () => (
    <div className="form-group">
      <label>Root Directory</label>
      <div className="input-group">
        <input type="text" value={settings.rootDir} readOnly />
        <button
          type="button"
          className="browse-btn"
          onClick={() => setIsPickerOpen(true)}
        >
          Browse...
        </button>
      </div>
    </div>
  );

  /** Renders the application settings view. */
  const renderSettingsView = () => (
    <div className="view">
      <header>
        <h1>Settings</h1>
      </header>
      <div className="settings-content">
        {renderSettingsForm()}
        <button
          type="button"
          className="save-btn"
          onClick={() => socket.emit("save-settings", settings)}
        >
          Save Settings
        </button>
      </div>
    </div>
  );

  /** Renders the project home view for the selected project. */
  const renderProjectHomeView = () => (
    <div className="view">
      <header>
        <h1>Project: {selectedProject?.name ?? "Home"}</h1>
      </header>
      <div className="project-home-content" style={{ padding: "2rem" }}>
        <div
          className="project-settings-form"
          style={{
            maxWidth: "600px",
            backgroundColor: "rgba(255,255,255,0.05)",
            padding: "2rem",
            borderRadius: "8px",
          }}
        >
          <h3>Project Settings</h3>
          <div className="form-group" style={{ marginBottom: "1.5rem" }}>
            <label style={{ display: "block", marginBottom: "0.5rem" }}>
              Project Name
            </label>
            <input
              type="text"
              value={projectFormName}
              onChange={(e) => setProjectFormName(e.target.value)}
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#222",
                border: "1px solid #444",
                color: "#fff",
              }}
            />
          </div>
          <button
            type="button"
            className="save-btn"
            onClick={handleSaveProjectConfig}
          >
            Save Project Config
          </button>
        </div>
        <div style={{ marginTop: "2rem" }}>
          <p>
            Welcome to the project home. Specific features for this project will
            be defined soon.
          </p>
        </div>
      </div>
    </div>
  );

  const viewRegistry: Record<typeof view, () => React.ReactElement> = {
    dashboard: renderDashboardView,
    tracks: renderTracksView,
    agents: renderAgentsView,
    projects: renderProjectsView,
    warroom: renderWarRoomView,
    settings: renderSettingsView,
    "project-home": renderProjectHomeView,
  };

  /** Evaluates the current view state and renders the appropriate content component. */
  const renderContent = () => viewRegistry[view]();

  return (
    <div className="app-container">
      <div id="flash-container">
        {flashes.map((f) => (
          <div key={f.id} className="flash-msg">
            {f.text}
          </div>
        ))}
      </div>

      {isPickerOpen && (
        <DirectoryPicker
          socket={socket}
          initialPath={settings.rootDir}
          onSelect={(path) => {
            setSettings((prev) => ({ ...prev, rootDir: path }));
            setIsPickerOpen(false);
          }}
          onClose={() => setIsPickerOpen(false)}
        />
      )}

      {confirmDialog?.show && (
        <div className="confirm-overlay">
          <div className="confirm-dialog">
            <p>{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="confirm-btn"
                onClick={confirmDialog.onConfirm}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <aside>
        <div className="sidebar-header">
          <h2>Meridian</h2>
        </div>
        <nav>
          <button
            type="button"
            aria-current={view === "dashboard" ? "page" : undefined}
            className={view === "dashboard" ? "active" : ""}
            onClick={() => handleViewChange("dashboard")}
          >
            Dashboard
          </button>

          <div className="sidebar-group">
            <button
              type="button"
              className={`sidebar-group-title ${isProjectsOpen ? "open" : ""}`}
              onClick={() => setIsProjectsOpen(!isProjectsOpen)}
            >
              <span className="arrow">{isProjectsOpen ? "▼" : "▶"}</span>{" "}
              Projects
            </button>

            {isProjectsOpen && (
              <ul className="sidebar-project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={
                        settings.rootDir === project.path ? "active" : ""
                      }
                      onClick={() => {
                        handleSelectProject(project);
                      }}
                    >
                      📁 {project.name}
                    </button>
                  </li>
                ))}
                {projects.length === 0 && (
                  <li className="empty-msg">No projects found</li>
                )}
              </ul>
            )}
          </div>

          <button
            type="button"
            aria-current={view === "settings" ? "page" : undefined}
            className={view === "settings" ? "active" : ""}
            onClick={() => handleViewChange("settings")}
          >
            Settings
          </button>
        </nav>
      </aside>

      <main>{renderContent()}</main>
    </div>
  );
}

export default App;
