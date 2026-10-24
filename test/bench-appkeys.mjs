// The benchmark reusing keys saved in the app, under real Electron: a key stored through the
// app's own codec is decrypted and sent, sign-in sessions and unrelated settings are not carried
// over, and the original app data is never modified. Needs a display (xvfb-run in CI).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import http from 'node:http';

const root = path.resolve(import.meta.dirname, '..');
const electron = createRequire(path.join(root, 'package.json'))('electron');
const KEY = 'sk-test-REAL-' + crypto.randomBytes(4).toString('hex');
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fakeapp-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fakeproj-'));

// A minimal OpenAI-compatible server that records who called it and what they sent. It answers
// task 10 (an Ask-mode question) correctly.
const mock = await new Promise(resolve => {
	const seen = [];
	const headers = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', c => body += c);
		req.on('end', () => {
			if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'my-groq-model' }] })); return; }
			headers.push(req.headers);
			seen.push(JSON.parse(body || '{}'));
			const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(chunk({ role: 'assistant', content: 'It retries up to 3 times; if every attempt throws it rethrows the last error.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
		});
	});
	server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, headers, close: () => server.close() }));
});

// 1. Save a key exactly as the app does: through the engine, with the real secret codec.
{
	const flags = process.platform === 'linux' ? ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] : [];
	const host = spawn(electron, [...flags, path.join(root, 'dist/dev-host.js')], { env: { ...process.env, MJ_APP_KEYS: '1', MJ_USER_DATA: app, MJ_FOLDER: project, MJ_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
	const url = await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('electron dev host did not start')), 30000);
		host.stdout.on('data', d => { const m = /STORMCODER_DEV (\S+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
	});
	const ws = new WebSocket(`ws://127.0.0.1:${new URL(url).port}`);
	await new Promise(r => ws.on('open', r));
	ws.send(JSON.stringify({ call: 'ready', args: [] }));
	ws.send(JSON.stringify({ call: 'sendToView', args: ['chat', { type: 'ready' }] }));
	await new Promise(r => setTimeout(r, 800));
	ws.send(JSON.stringify({ call: 'sendToView', args: ['chat', { type: 'saveKey', provider: 'groq', key: KEY }] }));
	await new Promise(r => setTimeout(r, 1500));
	ws.close(); host.kill();
	await new Promise(r => setTimeout(r, 500));
}
const secretsFile = path.join(app, 'secrets.json');
const stored = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
assert.ok(stored['stormcoder.apiKey.groq'], 'the key was saved by the app');
assert.ok(!fs.readFileSync(secretsFile, 'utf8').includes(KEY), 'and is not stored in the clear');

// 2. A user's data: a sign-in session, plus settings that must not leak into the benchmark.
stored['stormcoder.oauth.anthropic'] = Buffer.from('opaque-session').toString('base64');
fs.writeFileSync(secretsFile, JSON.stringify(stored));
fs.writeFileSync(path.join(app, 'settings.json'), JSON.stringify({
	'stormcoder.defaultProvider': 'groq',
	'stormcoder.groq.baseUrl': `http://127.0.0.1:${mock.port}/v1`,
	'stormcoder.groq.model': 'my-groq-model',
	'stormcoder.mcp.servers': { evil: { command: 'touch', args: [path.join(os.tmpdir(), 'mcp-ran-' + KEY)] } },
	'stormcoder.hooks': [{ event: 'PreToolUse', command: `touch ${path.join(os.tmpdir(), 'hook-ran-' + KEY)}` }],
	'stormcoder.systemPrompt': 'ALWAYS ANSWER IN FRENCH',
}));
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const before = ['secrets.json', 'settings.json'].map(f => sha(path.join(app, f)));
if (fs.existsSync(path.join(app, 'secret.key'))) { before.push(sha(path.join(app, 'secret.key'))); }

// Asynchronous on purpose: the mock server lives in this process and must keep answering.
const run = (...args) => new Promise(resolve => {
	const child = spawn(process.execPath, [path.join(root, 'bench/run.mjs'), ...args], { env: { ...process.env, GROQ_API_KEY: '', ANTHROPIC_API_KEY: '' } });
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', d => { stdout += d; });
	child.stderr.on('data', d => { stderr += d; });
	const timer = setTimeout(() => child.kill(), 180000);
	child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

// 3. Run with the app's key: it passes, the saved key (not an env var) is what reached the server,
//    and the configured model was used.
{
	const r = await run('--provider', 'groq', '--app-data', app, '--tasks', '10-ask');
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /10-ask-no-change #1 \.\.\. PASS/);
	const auth = mock.headers.map(h => h.authorization).filter(Boolean);
	assert.ok(auth.length && auth.every(a => a === `Bearer ${KEY}`), `the saved key was sent: ${JSON.stringify(auth)}`);
	assert.ok(mock.seen.some(q => q.model === 'my-groq-model'), 'the model from the app settings was used');
	assert.ok(!mock.seen.some(q => JSON.stringify(q.messages).includes('ALWAYS ANSWER IN FRENCH')), 'the user\'s system prompt was not carried over');
	await new Promise(r => setTimeout(r, 500));
	assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'mcp-ran-' + KEY)), 'the user\'s MCP servers were not started');
	assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'hook-ran-' + KEY)), 'the user\'s hooks did not run');
}

// 4. Refusals that protect the user.
{
	const signedIn = await run('--provider', 'anthropic', '--app-data', app, '--tasks', '10-ask');
	assert.equal(signedIn.status, 2);
	assert.match(signedIn.stderr, /web session/);
	const none = await run('--provider', 'openai', '--app-data', app, '--tasks', '10-ask');
	assert.equal(none.status, 2);
	assert.match(none.stderr, /no saved key for openai.*groq/s);
	assert.equal((await run('--provider', 'groq', '--app-data', path.join(app, 'nope'))).status, 2);
}

// 5. The original is untouched, including the sign-in session.
{
	const after = ['secrets.json', 'settings.json'].map(f => sha(path.join(app, f)));
	if (fs.existsSync(path.join(app, 'secret.key'))) { after.push(sha(path.join(app, 'secret.key'))); }
	assert.deepEqual(after, before, 'the app data was not modified');
	assert.ok(JSON.parse(fs.readFileSync(secretsFile, 'utf8'))['stormcoder.oauth.anthropic'], 'the sign-in session is still there');
}

mock.close();
fs.rmSync(app, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });
console.log('bench-appkeys: ok');
process.exit(0);
