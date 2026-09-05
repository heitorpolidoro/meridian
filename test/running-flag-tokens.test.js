const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'plugins', 'meridian', 'scripts', 'running-flag.sh');

// A stub for MERIDIAN_URL: answers everything 200, and records every request
// body so a test can assert on what the script actually posted.
function startStubServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, body });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
    });
}

function stopStubServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// Uses async spawn (not spawnSync): the stub server lives in this same
// process, and a synchronous spawn would block the event loop for the whole
// child's lifetime, starving the very server the child's curl calls talk to.
function runPost(input, env) {
    return new Promise((resolve) => {
        const child = spawn('bash', [SCRIPT, 'post'], {
            env: { ...process.env, ...env }
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

test('post exits 0 and posts nothing when the payload lacks transcript_path', async () => {
    const { server, requests, port } = await startStubServer();
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hook-'));
        const input = {
            session_id: 'sess-no-transcript',
            cwd: '/tmp/some-project',
            tool_input: { prompt: 'MERIDIAN_TASK: TST-1 do the thing' }
        };
        const result = await runPost(input, { MERIDIAN_URL: `http://127.0.0.1:${port}`, TMPDIR: tmp });
        assert.equal(result.status, 0);
        const eventsPosts = requests.filter(r => r.url === '/api/projects/events');
        assert.equal(eventsPosts.length, 0);
    } finally {
        await stopStubServer(server);
    }
});

test('post exits 0 and posts nothing when the derived subagents/ directory does not exist', async () => {
    const { server, requests, port } = await startStubServer();
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hook-'));
        const transcriptDir = path.join(tmp, 'transcripts');
        fs.mkdirSync(transcriptDir, { recursive: true });
        const input = {
            session_id: 'sess-no-subdir',
            cwd: '/tmp/some-project',
            transcript_path: path.join(transcriptDir, 'main.jsonl'),
            tool_input: { prompt: 'MERIDIAN_TASK: TST-1 do the thing' }
        };
        const result = await runPost(input, { MERIDIAN_URL: `http://127.0.0.1:${port}`, TMPDIR: tmp });
        assert.equal(result.status, 0);
        const eventsPosts = requests.filter(r => r.url === '/api/projects/events');
        assert.equal(eventsPosts.length, 0);
    } finally {
        await stopStubServer(server);
    }
});

test('post exits 0 and posts nothing when subagents/ exists but has no agent-*.jsonl file', async () => {
    const { server, requests, port } = await startStubServer();
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hook-'));
        const transcriptDir = path.join(tmp, 'transcripts');
        const subdir = path.join(transcriptDir, 'sess-empty-subdir', 'subagents');
        fs.mkdirSync(subdir, { recursive: true });
        const input = {
            session_id: 'sess-empty-subdir',
            cwd: '/tmp/some-project',
            transcript_path: path.join(transcriptDir, 'main.jsonl'),
            tool_input: { prompt: 'MERIDIAN_TASK: TST-1 do the thing' }
        };
        const result = await runPost(input, { MERIDIAN_URL: `http://127.0.0.1:${port}`, TMPDIR: tmp });
        assert.equal(result.status, 0);
        const eventsPosts = requests.filter(r => r.url === '/api/projects/events');
        assert.equal(eventsPosts.length, 0);
    } finally {
        await stopStubServer(server);
    }
});

test('post reports summed output_tokens and last-line context_tokens for a transcript newer than the ledger', async () => {
    const { server, requests, port } = await startStubServer();
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hook-'));
        const sessionId = 'sess-happy';
        const transcriptDir = path.join(tmp, 'transcripts');
        const subdir = path.join(transcriptDir, sessionId, 'subagents');
        fs.mkdirSync(subdir, { recursive: true });

        // Ledger written well before the subagent transcript.
        const ledgerPath = path.join(tmp, `meridian-running-${sessionId}`);
        fs.writeFileSync(ledgerPath, 'TST-1\t"/tmp/some-project"\n');
        const oldTime = new Date(Date.now() - 60_000);
        fs.utimesSync(ledgerPath, oldTime, oldTime);

        const transcript = path.join(subdir, 'agent-1.jsonl');
        const lines = [
            { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } },
            { type: 'assistant', message: { usage: { input_tokens: 120, output_tokens: 70, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 } } }
        ];
        fs.writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        const newTime = new Date();
        fs.utimesSync(transcript, newTime, newTime);

        const input = {
            session_id: sessionId,
            cwd: '/tmp/some-project',
            transcript_path: path.join(transcriptDir, 'main.jsonl'),
            tool_input: { prompt: 'MERIDIAN_TASK: TST-1 do the thing', subagent_type: 'developer' }
        };
        const result = await runPost(input, { MERIDIAN_URL: `http://127.0.0.1:${port}`, TMPDIR: tmp });
        assert.equal(result.status, 0, result.stderr);

        const eventsPosts = requests.filter(r => r.url === '/api/projects/events');
        assert.equal(eventsPosts.length, 1);
        const body = JSON.parse(eventsPosts[0].body);
        assert.equal(body.task, 'TST-1');
        assert.equal(body.type, 'dispatch_tokens');
        assert.equal(body.agent, 'developer');
        assert.equal(body.output_tokens, 120, 'sum of usage.output_tokens across both lines');
        assert.equal(body.context_tokens, 131, 'last line input_tokens + cache_read + cache_creation');
    } finally {
        await stopStubServer(server);
    }
});
