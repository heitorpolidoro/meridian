import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io();

function App() {
  const [view, setView] = useState<'dashboard' | 'warroom' | 'settings'>('dashboard');
  const [messages, setMessages] = useState<{ text: string; type: string }[]>([]);
  const [status, setStatus] = useState('Initializing...');
  const [input, setInput] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [settings, setSettings] = useState({ rootDir: '' });
  const [flashes, setFlashes] = useState<{ id: number; text: string }[]>([]);

  const chatRef = useRef<HTMLDivElement>(null);
  const currentAiMsgRef = useRef<string>('');

  useEffect(() => {
    socket.emit('get-settings');
    socket.on('settings', (s) => setSettings(s));
    
    socket.on('status', (msg) => {
      setStatus(msg);
      setMessages(prev => [...prev, { text: `[SYSTEM]: ${msg}`, type: 'system' }]);
      setIsTyping(true);
    });

    socket.on('ready', () => {
      setIsReady(true);
      setIsTyping(false);
      setMessages(prev => [...prev, { text: `[SYSTEM]: Asgard Council ready for deliberation.`, type: 'system' }]);
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

    socket.on('directory-picked', (path) => setSettings({ ...settings, rootDir: path }));
    
    socket.on('settings-saved', () => {
      showFlash('Settings saved successfully. A new session will start on next War Room entry.');
      setSessionStarted(false);
      setMessages([]);
    });

    return () => {
      socket.off('settings');
      socket.off('status');
      socket.off('ready');
      socket.off('chunk');
      socket.off('done');
      socket.off('directory-picked');
      socket.off('settings-saved');
    };
  }, [settings]);

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
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { text: input, type: 'user' }]);
    socket.emit('diretriz', input);
    setInput('');
    setIsReady(false);
    setIsTyping(true);
  };

  const formatText = (text: string) => {
    const parts = text.split(/(\[ODIN\]|\[MIMIR\]|\[VERDICT\])/g);
    return parts.map((part, i) => {
      if (part === '[ODIN]') return <span key={i} className="odin">[ODIN]</span>;
      if (part === '[MIMIR]') return <span key={i} className="mimir">[MIMIR]</span>;
      if (part === '[VERDICT]') return <span key={i} className="verdict">[VERDICT]</span>;
      return part;
    });
  };

  return (
    <div className="app-container">
      <div id="flash-container">
        {flashes.map(f => (
          <div key={f.id} className="flash-msg">{f.text}</div>
        ))}
      </div>

      <aside>
        <h2>Asgard</h2>
        <nav>
          <div className={view === 'dashboard' ? 'active' : ''} onClick={() => handleViewChange('dashboard')}>Dashboard</div>
          <div className={view === 'warroom' ? 'active' : ''} onClick={() => handleViewChange('warroom')}>War Room</div>
          <div className={view === 'settings' ? 'active' : ''} onClick={() => handleViewChange('settings')}>Settings</div>
        </nav>
      </aside>

      <main>
        {view === 'dashboard' && (
          <div className="view">
            <header><h1>Dashboard</h1></header>
            <div className="dashboard-content"><p>Dashboard is empty for now.</p></div>
          </div>
        )}

        {view === 'warroom' && (
          <div className="view">
            <header><h1>War Room</h1></header>
            <div id="chat" ref={chatRef}>
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.type}`}>{formatText(m.text)}</div>
              ))}
              {isTyping && (
                <div className="typing">
                  <div className="dot"></div><div className="dot"></div><div className="dot"></div>
                </div>
              )}
            </div>
            <footer>
              <input 
                type="text" 
                value={input} 
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                placeholder={isReady ? "Council ready. Enter your directive..." : status} 
                disabled={!isReady} 
              />
              <button onClick={handleSend} disabled={!isReady}>Send</button>
            </footer>
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
