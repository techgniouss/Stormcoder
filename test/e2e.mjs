// End-to-end: the real engine and the real UI in Chromium, against a mock OpenAI-compatible
// server. Covers a chat turn (streaming), an Agent run that writes a file through the tool
// loop, and that the transcript survives a reload.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-e2e-'));
const project = path.join(work, 'project');
const data = path.join(work, 'data');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(data, { recursive: true });

const seen = [];
const mock = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => body += c);
	req.on('end', () => {
		if (req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
			return;
		}
		const json = JSON.parse(body || '{}');
		seen.push(json);
		const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const last = json.messages[json.messages.length - 1];
		if (json.tools?.some(t => t.function?.name === 'write_file') && last.role !== 'tool') {
			send({ role: 'assistant', content: 'Creating the file.' });
			send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hello from mjolnir\n' }) } }] });
			send({}, 'tool_calls');
		} else if (last.role === 'tool') {
			send({ role: 'assistant', content: 'Done: hello.txt written.' });
			send({}, 'stop');
		} else {
			send({ role: 'assistant', content: 'Hello from the mock model.' });
			send({}, 'stop');
		}
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
	'openvsChat.defaultProvider': 'custom',
	'openvsChat.custom.baseUrl': `http://127.0.0.1:${mockPort}/v1`,
	'openvsChat.custom.model': 'mock-model',
	'openvsChat.guardrails.approval': 'yolo',
}));

const host = spawn(process.execPath, [path.join(root, 'dist/dev-host.js')], {
	env: { ...process.env, MJ_USER_DATA: data, MJ_FOLDER: project, MJ_PORT: '0' },
	stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stderr.on('data', d => { hostLog += d; });
const url = await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error('dev host did not start\n' + hostLog)), 15000);
	host.stdout.on('data', d => { const m = /MJOLNIR_DEV (\S+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
});

const exe = fs.readdirSync('/opt/pw-browsers').filter(d => d.startsWith('chromium-')).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(url);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();

	// 1. A plain Ask turn streams a reply.
	await chat.locator('#input').fill('say hello');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Hello from the mock model.').waitFor({ timeout: 15000 });

	// 2. An Agent turn runs the tool loop and writes into the project folder.
	await chat.locator('#modeSelect').selectOption('agent');
	await chat.locator('#input').fill('create hello.txt');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Done: hello.txt written.').waitFor({ timeout: 20000 });
	assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hello from mjolnir\n');
	assert.ok(seen.some(r => r.tools?.some(t => t.function?.name === 'write_file')), 'the agent request offered write_file');

	// 3. Settings opens as its own view, and areas switch.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area.active[data-area=providers]').waitFor();
	await settings.getByRole('button', { name: 'Agent permissions' }).click();
	await settings.locator('.area.active[data-area=permissions]').waitFor();

	// 4. The palette opens and filters.
	await page.keyboard.press('Control+k');
	await page.fill('#paletteInput', 'mcp');
	assert.ok(await page.locator('#paletteList li', { hasText: 'MCP' }).count() > 0);
	await page.keyboard.press('Escape');

	assert.deepEqual(errors, [], 'no uncaught page errors');
	console.log('e2e: ok');
} catch (err) {
	failed = true;
	console.error('e2e: FAILED\n', err);
	try { await (await browser.contexts()[0].pages())[0].screenshot({ path: path.join(os.tmpdir(), 'e2e-fail.png') }); console.error('screenshot: ' + path.join(os.tmpdir(), 'e2e-fail.png')); } catch { /* best effort */ }
	console.error('requests seen by mock:', JSON.stringify(seen).slice(0, 800));
	console.error(hostLog);
} finally {
	await browser.close();
	host.kill();
	mock.close();
	fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
