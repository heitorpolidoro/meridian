import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

const GEMINI_CMD = 'gemini';
const GEMINI_ARGS = [
    '--experimental-acp', 
    '--output-format', 'stream-json',
    '--resume', 'latest',
    '-y',
    '--extensions', ''
];

const SYSTEM_INSTRUCTION = `
Você é o Conselho de Asgard. Responda como dois agentes distintos debatendo:
1. ODIN (Engineering Manager): Focado em prazos, viabilidade técnica e decisão final.
2. MIMIR (Product Manager): Focado em valor para o usuário e regras de negócio.

Sempre que eu enviar uma diretriz, simule um breve debate entre eles e termine com um veredito.
Use o formato:
[MIMIR]: (mensagem)
[ODIN]: (mensagem)
[VEREDITO]: (conclusão final)
`;

function log(msg: string, level: 'OUT' | 'IN' | 'INFO' | 'ERROR' = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const colors = { INFO: '\x1b[32m', ERROR: '\x1b[31m', OUT: '\x1b[34m', IN: '\x1b[35m' };
    console.error(`${colors[level]}[${timestamp}] [${level}] ${msg}\x1b[0m`);
}

async function runBridge() {
    log('Iniciando Monitoramento FULL ACP (Odin & Mimir)...');

    const gemini = spawn(GEMINI_CMD, GEMINI_ARGS, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    const geminiOut = readline.createInterface({ input: gemini.stdout });
    let sessionId: string | null = null;
    let requestId = 3;

    // 1. Handshake: Initialize
    const initMsg = {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 0, clientInfo: { name: "asgard-council", version: "1.0" }, capabilities: {} }
    };
    log(JSON.stringify(initMsg), 'OUT');
    gemini.stdin.write(JSON.stringify(initMsg) + '\n');

    // 2. Handshake: New Session
    setTimeout(() => {
        const sessionMsg = {
            jsonrpc: "2.0", id: 2, method: "session/new",
            params: { cwd: process.cwd(), mcpServers: [] }
        };
        log(JSON.stringify(sessionMsg), 'OUT');
        gemini.stdin.write(JSON.stringify(sessionMsg) + '\n');
    }, 500);

    geminiOut.on('line', (line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;
        
        // LOG FULL ACP RESPONSE
        log(trimmedLine, 'IN');

        try {
            const data = JSON.parse(trimmedLine);
            
            if (data.id === 2 && data.result?.sessionId) {
                sessionId = data.result.sessionId;
                log(`Sessão Ativa: ${sessionId}`, 'INFO');
                
                const setupMsg = {
                    jsonrpc: "2.0", id: requestId++, method: "session/prompt",
                    params: { sessionId, prompt: [{ type: "text", text: SYSTEM_INSTRUCTION }] }
                };
                log(JSON.stringify(setupMsg), 'OUT');
                gemini.stdin.write(JSON.stringify(setupMsg) + '\n');
                
                process.stdout.write('\n--- CONSELHO PRONTO ---\nDIRETRIZ > ');
            }

            if (data.method === 'session/update') {
                const update = data.params?.update;
                if (update?.sessionUpdate === 'agent_message_chunk') {
                    const text = update.content?.text || '';
                    const styledText = text
                        .replace('[ODIN]', '\x1b[33m[ODIN]\x1b[0m')
                        .replace('[MIMIR]', '\x1b[35m[MIMIR]\x1b[0m')
                        .replace('[VEREDITO]', '\x1b[32m[VEREDITO]\x1b[0m');
                    process.stdout.write(styledText);
                }
            }

            if (data.id >= 3 && data.result) {
                process.stdout.write('\n\n[DELIBERAÇÃO CONCLUÍDA]\nDIRETRIZ > ');
            }
        } catch (e) {}
    });

    const terminalIn = readline.createInterface({ input: process.stdin });
    terminalIn.on('line', (input) => {
        if (!sessionId || !input.trim()) return;

        const promptMsg = {
            jsonrpc: "2.0",
            id: requestId++,
            method: "session/prompt",
            params: {
                sessionId: sessionId,
                prompt: [{ type: "text", text: input.trim() }]
            }
        };

        log(JSON.stringify(promptMsg), 'OUT');
        gemini.stdin.write(JSON.stringify(promptMsg) + '\n');
    });

    gemini.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('cached credentials')) log(msg, 'ERROR');
    });
}

runBridge().catch(console.error);
