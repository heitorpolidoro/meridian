import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_FILE = path.join(__dirname, '.settings.json');
const DEFAULT_SETTINGS = {
    rootDir: process.cwd()
};

function getSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
        return DEFAULT_SETTINGS;
    }
}

function saveSettings(settings: any) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = 3000;
const GEMINI_CMD = 'gemini';

const SYSTEM_INSTRUCTION = `
You are the Asgard Council. Respond as two distinct agents debating:
1. ODIN (Engineering Manager): Focused on deadlines, technical feasibility, and final decision.
2. MIMIR (Product Manager): Focused on user value and business rules.

Whenever I send a directive, simulate a brief debate between them and end with a verdict.
Use the format:
[MIMIR]: (message)
[ODIN]: (message)
[VERDICT]: (final conclusion)
`;

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

    socket.on('get-settings', () => {
        socket.emit('settings', getSettings());
    });

    socket.on('save-settings', (newSettings) => {
        saveSettings(newSettings);
        log('Settings updated: ' + JSON.stringify(newSettings), 'INFO');
        socket.emit('settings-saved');
    });

    socket.on('pick-directory', () => {
        const cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select the Root Directory:")'`;
        exec(cmd, (error, stdout) => {
            if (error) {
                log('Directory picker cancelled or failed', 'ERROR');
                return;
            }
            const pickedPath = stdout.trim();
            if (pickedPath) {
                log(`Picked directory: ${pickedPath}`, 'INFO');
                socket.emit('directory-picked', pickedPath);
            }
        });
    });

    socket.on('start-session', () => {
        if (gemini) gemini.kill();
        
        const settings = getSettings();
        const GEMINI_ARGS = [
            '--experimental-acp', 
            '--output-format', 'stream-json',
            '--resume', 'latest',
            '-y',
            '--extensions', ''
        ];

        gemini = spawn(GEMINI_CMD, GEMINI_ARGS, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: settings.rootDir,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        const sendACP = (msg: any) => {
            const json = JSON.stringify(msg);
            log(json, 'OUT');
            gemini.stdin.write(json + '\n');
        };

        socket.emit('status', 'Initializing ACP Protocol...');
        sendACP({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: 0, clientInfo: { name: "asgard-council-web", version: "1.0" }, capabilities: {} }
        });

        gemini.stdout.on('data', (data: any) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                log(trimmedLine, 'IN');

                try {
                    const parsed = JSON.parse(trimmedLine);
                    
                    if (parsed.id === 1 && parsed.result) {
                        socket.emit('status', 'Protocol Initialized. Starting session...');
                        sendACP({
                            jsonrpc: "2.0", id: 2, method: "session/new",
                            params: { 
                                cwd: settings.rootDir, 
                                mcpServers: [],
                                systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] }
                            }
                        });
                    }

                    if (parsed.id === 2 && parsed.result?.sessionId) {
                        sessionId = parsed.result.sessionId;
                        log(`Active Session: ${sessionId}`, 'INFO');
                        socket.emit('status', 'Session active and configured.');
                        socket.emit('ready');
                    }

                    if (parsed.method === 'session/update') {
                        const update = parsed.params?.update;
                        if (update?.sessionUpdate === 'agent_message_chunk') {
                            socket.emit('chunk', update.content?.text || '');
                        }
                    }

                    if (parsed.id >= 3 && parsed.result) {
                        socket.emit('done');
                    }
                } catch (e) {}
            }
        });

        gemini.stderr.on('data', (d: any) => {
            const msg = d.toString().trim();
            if (msg && !msg.includes('cached credentials')) log(msg, 'ERROR');
        });
    });

    socket.on('diretriz', (text) => {
        if (!sessionId || !gemini) return;
        const promptMsg = {
            jsonrpc: "2.0",
            id: requestId++,
            method: "session/prompt",
            params: {
                sessionId: sessionId,
                prompt: [{ type: "text", text: text.trim() }]
            }
        };
        const json = JSON.stringify(promptMsg);
        log(json, 'OUT');
        gemini.stdin.write(json + '\n');
    });

    socket.on('disconnect', () => {
        log('Client disconnected', 'INFO');
        if (gemini) gemini.kill();
    });
});

httpServer.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
});
