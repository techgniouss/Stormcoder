// Shared plumbing for the browser tests and the design showcase: a mock OpenAI-compatible
// model server, and the dev host pointed at it with a throwaway project and data directory.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** Starts a mock model. `reply(request)` returns text, or `{ tool: { name, args } }` for a tool call. */
export async function startMock(reply, { chunkDelay = 0 } = {}) {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', c => body += c);
		req.on('end', async () => {
			if (req.method === 'GET') {
				res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ['mock-model', 'qwen3-coder-480b', 'llama-3.3-70b-instruct', 'deepseek-r1-distill', 'mistral-large-2', 'gpt-oss-120b', 'gemma-3-27b-it', 'kimi-k2-instruct', 'glm-4.6', 'phi-4-reasoning', 'command-r-plus', 'nemotron-70b', 'yi-lightning'].map(id => ({ id })) }));
				return;
			}
			const json = JSON.parse(body || '{}');
			seen.push(json);
			const out = await reply(json);
			const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			if (typeof out === 'string') {
				// Streamed in small pieces so the UI's incremental rendering is exercised.
				for (let i = 0; i < out.length; i += 24) {
					send({ role: 'assistant', content: out.slice(i, i + 24) });
					if (chunkDelay) { await new Promise(r => setTimeout(r, chunkDelay)); }
				}
				send({}, 'stop');
			} else {
				if (out.text) { send({ role: 'assistant', content: out.text }); }
				send({ tool_calls: [{ index: 0, id: 'call_' + seen.length, type: 'function', function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args) } }] });
				send({}, 'tool_calls');
			}
			res.write('data: [DONE]\n\n');
			res.end();
		});
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	return { port: server.address().port, seen, close: () => server.close() };
}

/** Starts the dev host on a temp project and data dir, configured to use the mock model. */
export async function startHost({ mockPort, settings = {}, files = {} } = {}) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
	const project = path.join(work, 'project');
	const data = path.join(work, 'data');
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
		fs.writeFileSync(path.join(project, name), content);
	}
	fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
		'stormcoder.defaultProvider': 'custom',
		'stormcoder.custom.baseUrl': `http://127.0.0.1:${mockPort}/v1`,
		'stormcoder.custom.model': 'mock-model',
		'stormcoder.guardrails.approval': 'yolo',
		...settings,
	}));
	const host = spawn(process.execPath, [path.join(root, 'dist/dev-host.js')], {
		env: { ...process.env, MJ_USER_DATA: data, MJ_FOLDER: project, MJ_PORT: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let log = '';
	host.stderr.on('data', d => { log += d; });
	const url = await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('dev host did not start\n' + log)), 15000);
		host.stdout.on('data', d => { const m = /(?:MJOLNIR|STORMCODER)_DEV (\S+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
	});
	return { url, project, data, log: () => log, stop: () => { host.kill(); fs.rmSync(work, { recursive: true, force: true }); } };
}
