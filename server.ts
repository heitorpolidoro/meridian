import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { NodeFileSystem } from './src/services/implementations/NodeFileSystem';
import { AgentRegistryService } from './src/services/AgentRegistryService';
import { TrackMetadataService } from './src/services/TrackMetadataService';
import { SessionManagerService } from './src/services/SessionManagerService';
import { BootstrappingService } from './src/services/BootstrappingService';
import { TelemetryCollectorService } from './src/services/TelemetryCollectorService';
import { NodeFilesystemWatcher } from './src/services/implementations/NodeFilesystemWatcher';
import { SDSComplianceScorer } from './src/services/SDSComplianceScorer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_DIR = path.join(__dirname, '.meridian');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR);

const fileSystem = new NodeFileSystem();
const agentRegistry = new AgentRegistryService(fileSystem, __dirname);
const trackMetadataService = new TrackMetadataService(fileSystem, SETTINGS_DIR);
const sessionManager = new SessionManagerService();
const bootstrappingService = new BootstrappingService(fileSystem, __dirname);
const telemetryCollector = new TelemetryCollectorService();
const watcher = new NodeFilesystemWatcher();
const complianceScorer = new SDSComplianceScorer(fileSystem, path.join(SETTINGS_DIR, 'tracks'));

const DEFAULT_SETTINGS = {
    rootDir: process.cwd()
};

function getSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return DEFAULT_SETTINGS; }
}

function saveSettings(settings: any) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = 3000;
const GEMINI_CMD = 'gemini';

// --- Global Watcher and Periodic Updates ---
watcher.watch(SETTINGS_DIR, (event, filename) => {
    io.emit('sync-conflict', {
        path: filename,
        type: 'manual_change',
        message: `Manual change detected in ${filename}`,
        timestamp: new Date().toISOString()
    });
    const trackIds = trackMetadataService.listTracksWithMetadata().map(t => t.id);
    io.emit('compliance-update', complianceScorer.getAllCompliance(trackIds));
});

setInterval(() => {
    io.emit('telemetry-update', telemetryCollector.getSummary());
}, 5000);

function log(msg: string, level: 'OUT' | 'IN' | 'INFO' | 'ERROR' = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const colors = { INFO: '\x1b[32m', ERROR: '\x1b[31m', OUT: '\x1b[34m', IN: '\x1b[35m' };
    console.error(`${colors[level]}[${timestamp}] [${level}] ${msg}\x1b[0m`);
}

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

    socket.on('get-agents', () => socket.emit('agents', agentRegistry.discoverAgents()));
    socket.on('save-agents', (a) => { 
        try {
            agentRegistry.saveAgents(a); 
            agentRegistry.syncToGemini(a);
            socket.emit('agents-saved');
            socket.emit('agents', agentRegistry.getAgents());
        } catch (err) {
            log('Error saving agents: ' + err, 'ERROR');
        }
    });

    // --- Track Navigator Handlers ---
    socket.on('get-tracks', () => {
        try {
            const metadataList = trackMetadataService.listTracksWithMetadata();
            const tracksDir = path.join(SETTINGS_DIR, 'tracks');

            const tracksWithFiles = metadataList.map(metadata => {
                const trackPath = path.join(tracksDir, metadata.id);
                let files: string[] = [];
                try {
                    files = fs.readdirSync(trackPath).filter(file => file.endsWith('.md'));
                } catch {}
                
                // Attach session state if exists
                const session = sessionManager.getSession(metadata.id);
                
                return {
                    id: metadata.id,
                    name: metadata.name,
                    files,
                    metadata,
                    activeSession: session || { status: 'Idle' }
                };
            });

            socket.emit('tracks', tracksWithFiles);
        } catch (err) {
            log('Error scanning tracks: ' + err, 'ERROR');
            socket.emit('tracks', []);
        }
    });

    socket.on('get-file-content', (data) => {
        const { trackId, fileName } = data || {};
        if (typeof trackId !== 'string' || typeof fileName !== 'string') return;

        const tracksDir = path.resolve(SETTINGS_DIR, 'tracks');
        const resolvedPath = path.resolve(tracksDir, trackId, fileName);
        
        // Ensure the resolved path is within the tracks directory
        const relative = path.relative(tracksDir, resolvedPath);
        const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

        if (!isSafe) {
            log(`Blocked potential path traversal attempt: trackId=${trackId}, fileName=${fileName}`, 'ERROR');
        try {
            const realPath = fs.realpathSync(resolvedPath);
            const safetyCheck = path.relative(tracksDir, realPath);
            const isRealPathSafe = safetyCheck && !safetyCheck.startsWith('..') && !path.isAbsolute(safetyCheck);
            
            if (!isRealPathSafe) {
                log(`Blocked potential path traversal attempt: trackId=${trackId}, fileName=${fileName}`, 'ERROR');
                return;
            }
            
            const stats = fs.statSync(realPath);
            if (stats.isFile()) {
                const content = fs.readFileSync(realPath, 'utf8');
                socket.emit('file-content', { trackId, fileName, content });
            }
        } catch (err) {
            log(`Error reading file: ${err}`, 'ERROR');
        }
    });

    // --- Core Session Management (Task 1.4) ---
    socket.on('assign-agent', ({ trackId, agentId, taskId }) => {
        const session = sessionManager.assignAgent(trackId, agentId, taskId);
        socket.emit('session-updated', session);
        // Refresh tracks to show new state
        socket.emit('tracks', trackMetadataService.listTracksWithMetadata().map(m => ({
            ...m,
            activeSession: sessionManager.getSession(m.id) || { status: 'Idle' }
        })));
    });

    // --- Legacy AI Session (Updated with Bootstrapping Engine) ---
    let promptStartTime: number | null = null;

    socket.on('start-session', () => {
        if (gemini) gemini.kill();
        const settings = getSettings();
        const agents = agentRegistry.getAgents();

        // 1. Load Global Standards
        const globalPath = path.join(__dirname, '.meridian/core/global.md');
        const globalContent = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, 'utf8') : '';

        // 2. Resolve each agent's full hierarchy
        const agentInstructions = agents.map((a: any) => {
            try {
                // We use resolveAgent to get the hierarchy without prepending global every time
                const resolved = bootstrappingService.resolveAgent(a.id);
                return `${a.name.toUpperCase()} (${a.role}):\n${resolved}`;
            } catch (err) {
                log(`Failed to resolve agent ${a.id}: ${err}`, 'ERROR');
                return `${a.name.toUpperCase()} (${a.role}): ${a.instruction}`;
            }
        }).join('\n\n---\n\n');

        const fullInstruction = `${globalContent}\n\n# Orchestration Instructions
You are the Meridian Orchestrator. Respond as these distinct agents debating:
${agentInstructions}
Whenever I send a directive, simulate a brief debate and end with [VERDICT].`;

        gemini = spawn(GEMINI_CMD, [
            '--experimental-acp', '--output-format', 'stream-json',
            '--resume', 'latest', '-y', '--extensions', ''
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: settings.rootDir,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        gemini.on('error', (err: any) => {
            telemetryCollector.recordMetric('errors', 1);
            log(`Gemini process error: ${err}`, 'ERROR');
        });

        const sendACP = (msg: any) => { gemini.stdin.write(JSON.stringify(msg) + '\n'); log(JSON.stringify(msg), 'OUT'); };

        socket.emit('status', 'Initializing...');
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
                    if (parsed.id === 1) sendACP({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: settings.rootDir, mcpServers: [], systemInstruction: { role: 'system', parts: [{ text: fullInstruction }] } } });
                    if (parsed.id === 2 && parsed.result?.sessionId) { sessionId = parsed.result.sessionId; socket.emit('ready'); }
                    if (parsed.method === 'session/update') {
                        const update = parsed.params?.update;
                        if (update?.sessionUpdate === 'agent_message_chunk') {
                            const chunk = update.content?.text || '';
                            telemetryCollector.recordMetric('tokens', Math.ceil(chunk.length / 4));
                            socket.emit('chunk', chunk);
                        }
                    }
                    if (parsed.id >= 3 && parsed.result) {
                        if (promptStartTime) {
                            telemetryCollector.recordMetric('latency', Date.now() - promptStartTime);
                            promptStartTime = null;
                        }
                        socket.emit('done');
                    }
                } catch {}
            }
        });
    });

    socket.on('diretriz', (text) => {
        if (!sessionId || !gemini) return;
        promptStartTime = Date.now();
        const promptMsg = { jsonrpc: "2.0", id: requestId++, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: text.trim() }] } };
        gemini.stdin.write(JSON.stringify(promptMsg) + '\n');
    });

    socket.on('disconnect', () => { if (gemini) gemini.kill(); });
});

httpServer.listen(PORT, () => console.log(`\n🚀 Meridian running at http://localhost:${PORT}`));
