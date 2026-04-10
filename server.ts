import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_DIR = path.join(__dirname, '.meridian');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const AGENTS_FILE = path.join(SETTINGS_DIR, 'agents.json');

if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR);

const DEFAULT_SETTINGS = {
    rootDir: process.cwd()
};

const DEFAULT_AGENTS = [
    { id: '1', name: 'Strategic Lead', role: 'Engineering Manager', instruction: 'Focus on deadlines, technical feasibility, and final decision.', color: '#ffd700' },
    { id: '2', name: 'Product Lead', role: 'Product Manager', instruction: 'Focus on user value and business rules.', color: '#ff69b4' }
];

function getSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return DEFAULT_SETTINGS; }
}

function getAgents() {
    if (!fs.existsSync(AGENTS_FILE)) fs.writeFileSync(AGENTS_FILE, JSON.stringify(DEFAULT_AGENTS, null, 2));
    try { return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch { return DEFAULT_AGENTS; }
}

function saveSettings(settings: any) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function saveAgents(agents: any) { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2)); }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = 3000;
const GEMINI_CMD = 'gemini';

function log(msg: string, level: 'OUT' | 'IN' | 'INFO' | 'ERROR' = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const colors = { INFO: '\x1b[32m', ERROR: '\x1b[31m', OUT: '\x1b[34m', IN: '\x1b[35m' };
    console.error(`${colors[level]}[${timestamp}] [${level}] ${msg}\x1b[0m`);
}

// Servir arquivos estáticos (Vite)
if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist/index.html')));
} else {
    app.use(express.static('public'));
}

io.on('connection', (socket) => {
    log('New client connected', 'INFO');
    
    let gemini: any = null;
    let sessionId: string | null = null;
    let requestId = 3;

    socket.on('get-settings', () => socket.emit('settings', getSettings()));
    socket.on('save-settings', (s) => { saveSettings(s); socket.emit('settings-saved'); });

    socket.on('get-agents', () => socket.emit('agents', getAgents()));
    socket.on('save-agents', (a) => { 
        saveAgents(a); 
        const settings = getSettings();
        const geminiAgentsDir = path.join(settings.rootDir, '.gemini', 'agents');
        if (!fs.existsSync(geminiAgentsDir)) fs.mkdirSync(geminiAgentsDir, { recursive: true });

        a.forEach((agent: any) => {
            const fileName = `${agent.name.toLowerCase().replace(/\s+/g, '-')}.toml`;
            const filePath = path.join(geminiAgentsDir, fileName);
            const tomlContent = `name = "${agent.name}"
description = "${agent.role}"
instruction = """
${agent.instruction}
"""
# Meridian Color: ${agent.color}
`;
            fs.writeFileSync(filePath, tomlContent);
        });
        socket.emit('agents-saved'); 
    });

    // --- Track Navigator Handlers ---
    socket.on('get-tracks', () => {
        const tracksDir = path.join(SETTINGS_DIR, 'tracks');
        if (!fs.existsSync(tracksDir)) return socket.emit('tracks', []);

        try {
            const tracks = fs.readdirSync(tracksDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => {
                    const trackPath = path.join(tracksDir, dirent.name);
                    const files = fs.readdirSync(trackPath)
                        .filter(file => file.endsWith('.md'));
                    return { id: dirent.name, name: dirent.name, files };
                });
            socket.emit('tracks', tracks);
        } catch (err) {
            log('Error scanning tracks: ' + err, 'ERROR');
            socket.emit('tracks', []);
        }
    });

    socket.on('get-file-content', (data) => {
        const { trackId, fileName } = data || {};
        if (typeof trackId !== 'string' || typeof fileName !== 'string') {
            return socket.emit('file-content-error', 'Invalid arguments');
        }

        const safeTrackId = trackId.replace(/\.\./g, '');
        const safeFileName = fileName.replace(/\.\./g, '');
        const filePath = path.join(SETTINGS_DIR, 'tracks', safeTrackId, safeFileName);
        
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                socket.emit('file-content', { trackId, fileName, content });
            } else {
                socket.emit('file-content-error', 'File not found');
            }
        } catch (err) {
            socket.emit('file-content-error', 'Error reading file');
        }
    });

    socket.on('generate-agent', (description) => {
        log(`Generating agent for: ${description}`, 'INFO');
        const settings = getSettings();
        const tempGemini = spawn(GEMINI_CMD, [
            '--experimental-acp', '--output-format', 'stream-json',
            '-y', '--extensions', ''
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: settings.rootDir,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        let fullResponse = '';
        const sendACP = (msg: any) => { 
            tempGemini.stdin.write(JSON.stringify(msg) + '\n'); 
            log(JSON.stringify(msg), 'OUT');
        };

        sendACP({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: 0, clientInfo: { name: "meridian-gen", version: "1.0" }, capabilities: {} }
        });

        tempGemini.stdout.on('data', (data: any) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.id === 1) {
                        sendACP({
                            jsonrpc: "2.0", id: 2, method: "session/new",
                            params: { cwd: settings.rootDir, mcpServers: [] }
                        });
                    }
                    if (parsed.id === 2 && parsed.result?.sessionId) {
                        const prompt = `Generate a JSON object for a project management agent based on this description: "${description}".
                        The JSON must have exactly these fields: "role", "instruction", and "color" (a hex code).
                        Return ONLY the JSON object, no markdown, no explanation.`;
                        sendACP({ 
                            jsonrpc: "2.0", id: 3, method: "session/prompt", 
                            params: { sessionId: parsed.result.sessionId, prompt: [{ type: "text", text: prompt }] } 
                        });
                    }
                    if (parsed.method === 'session/update') {
                        fullResponse += parsed.params?.update?.content?.text || '';
                    }
                    if (parsed.id === 3) {
                        try {
                            const cleanJson = fullResponse.replace(/```json|```/g, '').trim();
                            const agentData = JSON.parse(cleanJson);
                            socket.emit('agent-generated', agentData);
                        } catch (e) {
                            socket.emit('agent-generation-error', 'Failed to parse AI response.');
                        }
                        tempGemini.kill();
                    }
                } catch {}
            }
        });
    });

    socket.on('pick-directory', () => {
        const cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select the Root Directory:")'`;
        exec(cmd, (error, stdout) => {
            if (!error) socket.emit('directory-picked', stdout.trim());
        });
    });

    socket.on('start-session', () => {
        if (gemini) gemini.kill();
        const settings = getSettings();
        const agents = getAgents();

        const agentInstructions = agents.map((a: any) => `${a.name.toUpperCase()} (${a.role}): ${a.instruction}`).join('\n');
        const fullInstruction = `
You are the Meridian Orchestrator. Respond as these distinct agents debating:
${agentInstructions}

Whenever I send a directive, simulate a brief debate between them and end with a verdict.
Use the format:
[AGENT_NAME]: (message)
[VERDICT]: (final conclusion)
`;

        gemini = spawn(GEMINI_CMD, [
            '--experimental-acp', '--output-format', 'stream-json',
            '--resume', 'latest', '-y', '--extensions', ''
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: settings.rootDir,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        const sendACP = (msg: any) => { gemini.stdin.write(JSON.stringify(msg) + '\n'); log(JSON.stringify(msg), 'OUT'); };

        socket.emit('status', 'Initializing Meridian Engine...');
        sendACP({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: 0, clientInfo: { name: "meridian-ai", version: "1.0" }, capabilities: {} }
        });

        gemini.stdout.on('data', (data: any) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.id === 1 && parsed.result) {
                        socket.emit('status', 'Engine Initialized. Starting session...');
                        sendACP({
                            jsonrpc: "2.0", id: 2, method: "session/new",
                            params: { 
                                cwd: settings.rootDir, mcpServers: [],
                                systemInstruction: { role: 'system', parts: [{ text: fullInstruction }] }
                            }
                        });
                    }
                    if (parsed.id === 2 && parsed.result?.sessionId) {
                        sessionId = parsed.result.sessionId;
                        socket.emit('status', 'Meridian Active.');
                        socket.emit('ready');
                    }
                    if (parsed.method === 'session/update') {
                        const update = parsed.params?.update;
                        if (update?.sessionUpdate === 'agent_message_chunk') socket.emit('chunk', update.content?.text || '');
                    }
                    if (parsed.id >= 3 && parsed.result) socket.emit('done');
                } catch {}
            }
        });
    });

    socket.on('diretriz', (text) => {
        if (!sessionId || !gemini) return;
        const promptMsg = { jsonrpc: "2.0", id: requestId++, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: text.trim() }] } };
        gemini.stdin.write(JSON.stringify(promptMsg) + '\n');
        log(JSON.stringify(promptMsg), 'OUT');
    });

    socket.on('disconnect', () => { if (gemini) gemini.kill(); });
});

httpServer.listen(PORT, () => console.log(`\n🚀 Meridian running at http://localhost:${PORT}`));
