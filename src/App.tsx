import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';
import './components/TrackNavigator.css';
import './components/AgentsTable.css';
import { MarkdownViewer } from './components/MarkdownViewer/MarkdownViewer';
import { TelemetryDashboard } from './components/TelemetryDashboard/TelemetryDashboard';
import { TelemetrySummary, SDSCompliance, SyncConflict } from './services/IPCSchemas';

const socket = io();

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
  metadata: any;
  activeSession?: {
    status: string;
    activeAgentId?: string;
  };
}

function App() {
  const [view, setView] = useState<'dashboard' | 'warroom' | 'tracks' | 'agents' | 'settings'>('dashboard');
  const [messages, setMessages] = useState<{ text: string; type: string }[]>([]);
  const [status, setStatus] = useState('Initializing...');
  const [input, setInput] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [settings, setSettings] = useState({ rootDir: '' });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [flashes, setFlashes] = useState<{ id: number; text: string }[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySummary | null>(null);
  const [compliance, setCompliance] = useState<SDSCompliance[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  
  // Track Navigator States
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null);

  // Agent Management States
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<Partial<Agent>>({ name: '', role: '', color: '#00c3ff', instruction: '' });
  const [editAgent, setEditAgent] = useState<Partial<Agent>>({});

  const chatRef = useRef<HTMLDivElement>(null);
  const currentAiMsgRef = useRef<string>('');

  useEffect(() => {
    socket.emit('get-settings');
    socket.emit('get-agents');
    socket.emit('get-tracks');
    
    socket.on('settings', (s) => setSettings(s));
    socket.on('agents', (a) => setAgents(a));
    socket.on('tracks', (t) => setTracks(t));
    
    socket.on('telemetry-update', (data) => setTelemetry(data));
    socket.on('compliance-update', (data) => setCompliance(data));
    socket.on('sync-conflict', (data) => {
      setConflicts(prev => [data, ...prev].slice(0, 5));
    });

    socket.on('file-content', (data) => {
      setSelectedFile({ name: data.fileName, content: data.content });
    });

    socket.on('status', (msg) => {
      setStatus(msg);
      setIsTyping(true);
    });

    socket.on('ready', () => {
      setIsReady(true);
      setIsTyping(false);
    });

    socket.on('chunk', (text) => {
      setIsTyping(false);
      currentAiMsgRef.current += text;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.type === 'ai') {
          return [...prev.slice(0, -1), { text: currentAiMsgRef.current, type: 'ai' }];
        }
        return [...prev, { text: currentAiMsgRef.current, type: 'ai' }];
      });
    });

    socket.on('done', () => {
      setIsTyping(false);
      setIsReady(true);
      currentAiMsgRef.current = '';
    });

    socket.on('directory-picked', (path) => setSettings(prev => ({ ...prev, rootDir: path })));
    
    socket.on('settings-saved', () => showFlash('Settings saved.'));
    socket.on('agents-saved', () => showFlash('Squad updated.'));

    return () => {
      socket.off('settings');
      socket.off('agents');
      socket.off('tracks');
      socket.off('telemetry-update');
      socket.off('compliance-update');
      socket.off('sync-conflict');
      socket.off('file-content');
      socket.off('status');
      socket.off('ready');
      socket.off('chunk');
      socket.off('done');
      socket.off('directory-picked');
      socket.off('settings-saved');
      socket.off('agents-saved');
    };
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isTyping]);

  const showFlash = (text: string) => {
    const id = Date.now();
    setFlashes(prev => [...prev, { id, text }]);
    setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 3000);
  };

  const handleViewChange = (newView: typeof view) => {
    setView(newView);
    if (newView === 'warroom') {
      setMessages([]); // Reset messages when entering War Room for now
      socket.emit('start-session');
    }
    if (newView === 'tracks' || newView === 'agents') {
      socket.emit(`get-${newView}`);
    }
  };

  const handleSelectTrack = (track: Track) => {
    setSelectedTrack(track);
    setSelectedFile(null);
  };

  const handleSelectFile = (trackId: string, fileName: string) => {
    socket.emit('get-file-content', { trackId, fileName });
  };

  const handleNavigate = (path: string) => {
    if (!selectedTrack) return;
    // Resolve relative links (e.g., ./plan.md or ../track-x/plan.md)
    // Simple implementation for now: just strip leading ./ or ../ and use current track
    const fileName = path.replace(/^(\.\/|\.\.\/)+/, '');
    handleSelectFile(selectedTrack.id, fileName);
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { text: input, type: 'user' }]);
    socket.emit('diretriz', input);
    setInput('');
    setIsReady(false);
    setIsTyping(true);
  };

  const handleDeleteAgent = (id: string) => {
    if (!window.confirm('Delete this agent profile?')) return;
    const updated = agents.filter(a => a.id !== id);
    socket.emit('save-agents', updated);
  };

  const handleAddAgent = () => {
    if (!newAgent.name || !newAgent.role) return showFlash('Name and Role are required.');
    const id = newAgent.name.toLowerCase().replace(/\s+/g, '-');
    const agent: Agent = {
      id,
      name: newAgent.name,
      role: newAgent.role,
      color: newAgent.color || '#00c3ff',
      instruction: newAgent.instruction || 'New agent.'
    };
    const updated = [...agents, agent];
    socket.emit('save-agents', updated);
    setIsAdding(false);
    setNewAgent({ name: '', role: '', color: '#00c3ff', instruction: '' });
  };

  const startEditing = (agent: Agent) => {
    setEditingId(agent.id);
    setEditAgent({ ...agent });
  };

  const handleSaveEdit = () => {
    if (!editAgent.name || !editAgent.role) return showFlash('Name and Role are required.');
    const updated = agents.map(a => a.id === editingId ? (editAgent as Agent) : a);
    socket.emit('save-agents', updated);
    setEditingId(null);
  };

  const formatText = (text: string) => {
    const agentNames = agents.map(a => a.name.toUpperCase());
    const regex = new RegExp(`(\\[(?:${agentNames.join('|')}|VERDICT)\\])`, 'g');
    const parts = text.split(regex);
    return parts.map((part, i) => {
      const name = part.replace(/[\[\]]/g, '');
      const agent = agents.find(a => a.name.toUpperCase() === name);
      if (agent) return <span key={i} style={{ color: agent.color, fontWeight: 'bold' }}>{part}</span>;
      if (part === '[VERDICT]') return <span key={i} className="verdict">{part}</span>;
      return part;
    });
  };

  return (
    <div className="app-container">
      <div id="flash-container">
        {flashes.map(f => <div key={f.id} className="flash-msg">{f.text}</div>)}
      </div>

      <aside>
        <h2>Meridian</h2>
        <nav>
          <div className={view === 'dashboard' ? 'active' : ''} onClick={() => handleViewChange('dashboard')}>Dashboard</div>
          <div className={view === 'warroom' ? 'active' : ''} onClick={() => handleViewChange('warroom')}>War Room</div>
          <div className={view === 'tracks' ? 'active' : ''} onClick={() => handleViewChange('tracks')}>Tracks</div>
          <div className={view === 'agents' ? 'active' : ''} onClick={() => handleViewChange('agents')}>Agents</div>
          <div className={view === 'settings' ? 'active' : ''} onClick={() => handleViewChange('settings')}>Settings</div>
        </nav>
      </aside>

      <main>
        {view === 'dashboard' && (
          <div className="view">
            <header><h1>Governance Dashboard</h1></header>
            <TelemetryDashboard 
              telemetry={telemetry} 
              compliance={compliance} 
              conflicts={conflicts} 
            />
          </div>
        )}

        {view === 'tracks' && (
          <div className="view tracks-view">
            <header><h1>Track Navigator</h1></header>
            <div className="tracks-container">
              <div className="tracks-sidebar">
                <h3>Tracks</h3>
                <ul>
                  {tracks.map(t => (
                    <li key={t.id} className={selectedTrack?.id === t.id ? 'active' : ''} onClick={() => handleSelectTrack(t)}>
                      <span>📁 {t.name}</span>
                      <span className={`status-badge ${t.activeSession?.status}`}>
                        {t.activeSession?.status === 'Working' ? '⏳ ' : ''}
                        {t.activeSession?.status === 'Idle' ? '💤 ' : ''}
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
                    {selectedTrack.files.map(f => (
                      <li key={f} className={selectedFile?.name === f ? 'active' : ''} onClick={() => handleSelectFile(selectedTrack.id, f)}>
                        📄 {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="content-viewer">
                {selectedFile ? (
                  <div className="viewer-wrapper">
                    <h2>{selectedFile.name}</h2>
                    <MarkdownViewer 
                      content={selectedFile.content} 
                      onNavigate={handleNavigate}
                    />
                  </div>
                ) : (
                  <div className="viewer-placeholder">Select a file to preview documentation.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {view === 'warroom' && (
          <div className="view">
            <header><h1>War Room</h1></header>
            <div id="chat" ref={chatRef}>
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.type}`}>{formatText(m.text)}</div>
              ))}
              {isTyping && <div className="typing"><div className="dot"></div><div className="dot"></div><div className="dot"></div></div>}
            </div>
            <footer>
              <input 
                type="text" 
                value={input} 
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                placeholder={isReady ? "Enter your directive..." : status} 
                disabled={!isReady} 
              />
              <button onClick={handleSend} disabled={!isReady}>Send</button>
            </footer>
          </div>
        )}

        {view === 'agents' && (
          <div className="view">
            <header><h1>Active Squad</h1></header>
            <div className="agents-content">
              <div className="table-actions">
                <button className="add-btn" onClick={() => setIsAdding(true)}>+ New Agent Profile</button>
              </div>

              {isAdding && (
                <div className="quick-add-form">
                  <input type="text" placeholder="Name" value={newAgent.name} onChange={e => setNewAgent({...newAgent, name: e.target.value})} />
                  <input type="text" placeholder="Role" value={newAgent.role} onChange={e => setNewAgent({...newAgent, role: e.target.value})} />
                  <input type="color" value={newAgent.color} onChange={e => setNewAgent({...newAgent, color: e.target.value})} />
                  <button className="save-btn" onClick={handleAddAgent}>Save</button>
                  <button className="cancel-btn" onClick={() => setIsAdding(false)}>Cancel</button>
                </div>
              )}

              <table className="agents-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role / Specialization</th>
                    <th>Color</th>
                    <th style={{ width: '100px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map(agent => (
                    <tr key={agent.id}>
                      {editingId === agent.id ? (
                        <>
                          <td><input className="table-input" type="text" value={editAgent.name} onChange={e => setEditAgent({...editAgent, name: e.target.value})} /></td>
                          <td><input className="table-input" type="text" value={editAgent.role} onChange={e => setEditAgent({...editAgent, role: e.target.value})} /></td>
                          <td><input type="color" value={editAgent.color} onChange={e => setEditAgent({...editAgent, color: e.target.value})} /></td>
                          <td className="row-actions">
                            <button className="save-row-btn" onClick={handleSaveEdit}>✅</button>
                            <button className="cancel-row-btn" onClick={() => setEditingId(null)}>❌</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="agent-name-cell">{agent.name}</td>
                          <td className="agent-role-cell">{agent.role}</td>
                          <td className="agent-color-cell">
                            <div className="color-swatch" style={{ backgroundColor: agent.color }}></div>
                            <code>{agent.color}</code>
                          </td>
                          <td className="row-actions">
                            <button className="edit-row-btn" onClick={() => startEditing(agent)}>✏️</button>
                            <button className="delete-row-btn" onClick={() => handleDeleteAgent(agent.id)}>🗑️</button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <footer className="table-footer">
                <p>Profiles are automatically discovered and synchronized with <code>.gemini/agents/</code></p>
              </footer>
            </div>
          </div>
        )}

        {view === 'settings' && (
          <div className="view">
            <header><h1>Settings</h1></header>
            <div className="settings-content">
              <div className="form-group">
                <label>Root Directory</label>
                <div className="input-group">
                  <input type="text" value={settings.rootDir} readOnly />
                  <button className="browse-btn" onClick={() => socket.emit('pick-directory')}>Browse...</button>
                </div>
              </div>
              <button className="save-btn" onClick={() => socket.emit('save-settings', settings)}>Save Settings</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
