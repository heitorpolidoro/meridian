import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';
import { MarkdownViewer } from './components/MarkdownViewer/MarkdownViewer';

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
}

function App() {
  const [view, setView] = useState<'dashboard' | 'warroom' | 'tracks' | 'agents' | 'settings'>('dashboard');
  const [messages, setMessages] = useState<{ text: string; type: string }[]>([]);
  const [status, setStatus] = useState('Initializing...');
  const [input, setInput] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [settings, setSettings] = useState({ rootDir: '' });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [flashes, setFlashes] = useState<{ id: number; text: string }[]>([]);
  
  // Track Navigator States
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null);

  // AI Generation States
  const [aiInput, setAiInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  
  // New Agent "Draft" State
  const [isAdding, setIsAdding] = useState(false);
  const [newAgent, setNewAgent] = useState<Agent>({
    id: '', name: '', role: '', instruction: '', color: '#ffffff'
  });

  const chatRef = useRef<HTMLDivElement>(null);
  const currentAiMsgRef = useRef<string>('');

  useEffect(() => {
    socket.emit('get-settings');
    socket.emit('get-agents');
    socket.emit('get-tracks');
    
    socket.on('settings', (s) => setSettings(s));
    socket.on('agents', (a) => setAgents(a));
    socket.on('tracks', (t) => setTracks(t));
    
    socket.on('file-content', (data) => {
      setSelectedFile({ name: data.fileName, content: data.content });
    });

    socket.on('status', (msg) => {
      setStatus(msg);
      setMessages(prev => [...prev, { text: `[SYSTEM]: ${msg}`, type: 'system' }]);
      setIsTyping(true);
    });

    socket.on('ready', () => {
      setIsReady(true);
      setIsTyping(false);
      setMessages(prev => [...prev, { text: `[SYSTEM]: Meridian Engine active and synchronized.`, type: 'system' }]);
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
    
    socket.on('settings-saved', () => {
      showFlash('Settings saved successfully.');
      setSessionStarted(false);
      setMessages([]);
    });

    socket.on('agents-saved', () => {
      showFlash('Agents configuration updated.');
      setSessionStarted(false);
      setMessages([]);
    });

    socket.on('agent-generated', (data) => {
      setIsGenerating(false);
      setAiInput('');
      setNewAgent(prev => ({
        ...prev,
        role: data.role || prev.role,
        instruction: data.instruction || prev.instruction,
        color: data.color || prev.color
      }));
      showFlash('AI suggested content for the fields!');
    });

    socket.on('agent-generation-error', (err) => {
      setIsGenerating(false);
      showFlash('Error: ' + err);
    });

    return () => {
      socket.off('settings');
      socket.off('agents');
      socket.off('tracks');
      socket.off('file-content');
      socket.off('status');
      socket.off('ready');
      socket.off('chunk');
      socket.off('done');
      socket.off('directory-picked');
      socket.off('settings-saved');
      socket.off('agents-saved');
      socket.off('agent-generated');
      socket.off('agent-generation-error');
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
    if (newView === 'warroom' && !sessionStarted) {
      setSessionStarted(true);
      socket.emit('start-session');
    }
    if (newView === 'tracks') {
      socket.emit('get-tracks');
    }
  };

  const handleSelectTrack = (track: Track) => {
    setSelectedTrack(track);
    setSelectedFile(null);
  };

  const handleSelectFile = (trackId: string, fileName: string) => {
    socket.emit('get-file-content', { trackId, fileName });
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { text: input, type: 'user' }]);
    socket.emit('diretriz', input);
    setInput('');
    setIsReady(false);
    setIsTyping(true);
  };

  const handleUpdateAgent = (id: string, field: keyof Agent, value: string) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, [field]: value } : a));
  };

  const handleStartAdding = () => {
    setNewAgent({ id: Date.now().toString(), name: '', role: '', instruction: '', color: '#ffffff' });
    setIsAdding(true);
  };

  const handleConfirmAdd = () => {
    if (!newAgent.name.trim()) return showFlash('Please enter a name.');
    setAgents(prev => [...prev, newAgent]);
    setIsAdding(false);
  };

  const handleRemoveAgent = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id));
  };

  const handleGenerateAI = () => {
    if (!aiInput.trim()) return;
    setIsGenerating(true);
    socket.emit('generate-agent', aiInput);
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
            <header><h1>Dashboard</h1></header>
            <div className="dashboard-content">
                <p>Welcome to Meridian. Select a track to begin.</p>
                <div className="stats-placeholder">
                    {agents.length} Agents Active | {tracks.length} Tracks Found
                </div>
            </div>
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
                      📁 {t.name}
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
                    <MarkdownViewer content={selectedFile.content} />
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
            <header><h1>Agents Configuration</h1></header>
            <div className="agents-content">
              {isAdding && (
                <div className="agent-card new-agent-card">
                  <h3>New Agent Profile</h3>
                  <div className="agent-header">
                    <div className="form-group-inline">
                      <label>Name</label>
                      <input value={newAgent.name} onChange={(e) => setNewAgent(prev => ({ ...prev, name: e.target.value }))} placeholder="Agent Name" />
                    </div>
                    <div className="form-group-inline color-group">
                      <label>Color</label>
                      <input type="color" value={newAgent.color} onChange={(e) => setNewAgent(prev => ({ ...prev, color: e.target.value }))} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Role</label>
                    <input value={newAgent.role} onChange={(e) => setNewAgent(prev => ({ ...prev, role: e.target.value }))} placeholder="e.g. Frontend Engineer" />
                  </div>
                  <div className="form-group">
                    <label>System Instruction</label>
                    <textarea value={newAgent.instruction} onChange={(e) => setNewAgent(prev => ({ ...prev, instruction: e.target.value }))} placeholder="What should this agent focus on?" />
                  </div>
                  <div className="ai-generation-box">
                    <label>Magic Fill with AI ✨</label>
                    <div className="input-group">
                      <input type="text" placeholder="Describe the agent profile..." value={aiInput} onChange={(e) => setAiInput(e.target.value)} disabled={isGenerating} />
                      <button onClick={handleGenerateAI} disabled={isGenerating || !aiInput.trim()}>{isGenerating ? 'Analyzing...' : 'Auto Fill'}</button>
                    </div>
                  </div>
                  <div className="agent-actions">
                    <button className="save-btn" onClick={handleConfirmAdd}>Add Agent</button>
                    <button className="cancel-btn" onClick={() => setIsAdding(false)}>Cancel</button>
                  </div>
                </div>
              )}
              {agents.map(agent => (
                <div key={agent.id} className="agent-card">
                  <div className="agent-header">
                    <div className="form-group-inline">
                      <label>Name</label>
                      <input value={agent.name} onChange={(e) => handleUpdateAgent(agent.id, 'name', e.target.value)} />
                    </div>
                    <div className="form-group-inline color-group">
                      <label>Color</label>
                      <input type="color" value={agent.color} onChange={(e) => handleUpdateAgent(agent.id, 'color', e.target.value)} />
                    </div>
                    <button className="remove-btn" onClick={() => handleRemoveAgent(agent.id)}>×</button>
                  </div>
                  <div className="form-group">
                    <label>Role</label>
                    <input value={agent.role} onChange={(e) => handleUpdateAgent(agent.id, 'role', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>System Instruction</label>
                    <textarea value={agent.instruction} onChange={(e) => handleUpdateAgent(agent.id, 'instruction', e.target.value)} />
                  </div>
                </div>
              ))}
              <div className="agent-actions">
                <button className="add-btn" onClick={handleStartAdding} disabled={isAdding}>+ Add Agent</button>
                <button className="save-btn" onClick={() => socket.emit('save-agents', agents)}>Apply Changes</button>
              </div>
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
