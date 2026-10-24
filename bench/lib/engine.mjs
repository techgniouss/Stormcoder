// Drives the real engine headlessly: the same dev host the browser UI talks to, spoken to over
// its WebSocket as a minimal chat client. Nothing here reimplements the agent; it sends the
// messages the chat UI would send and records what comes back.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { benchRoot } from './tasks.mjs';

const repoRoot = path.resolve(benchRoot, '..');

/** Starts the dev host on `project` with a private data dir and `settings`, and connects to it. */
export async function startEngine({ project, settings, engineRoot = repoRoot }) {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-'));
	fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
	const host = spawn(process.execPath, [path.join(engineRoot, 'dist/dev-host.js')], {
		env: { ...process.env, MJ_USER_DATA: data, MJ_FOLDER: project, MJ_PORT: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let log = '';
	host.stderr.on('data', d => { log += d; });
	const url = await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('dev host did not start\n' + log)), 20_000);
		host.stdout.on('data', d => { const m = /STORMCODER_DEV (\S+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
		host.on('exit', code => { clearTimeout(t); reject(new Error(`dev host exited (${code})\n${log}`)); });
	});
	const port = new URL(url).port;
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

	/** @type {Set<(m: any) => void>} */
	const listeners = new Set();
	ws.on('message', raw => {
		let m; try { m = JSON.parse(String(raw)); } catch { return; }
		if (m.channel === 'view:message' && m.payload?.view === 'chat') { listeners.forEach(l => l(m.payload.message)); }
	});
	const call = (name, ...args) => ws.send(JSON.stringify({ call: name, args }));
	const toChat = message => call('sendToView', 'chat', message);
	call('ready');
	toChat({ type: 'ready' });
	await new Promise(r => setTimeout(r, 800));

	return {
		log: () => log,
		/** Sends one user turn and resolves with everything the run did, once it reports `done`. */
		async send({ sessionId, mode, provider, model, text, timeoutMs }) {
			const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
			const events = [];
			let tokens = '';
			const startedAt = Date.now();
			let timedOut = false;
			await new Promise(resolve => {
				const timer = setTimeout(() => { timedOut = true; toChat({ type: 'stop', sessionId }); }, timeoutMs);
				const hardStop = setTimeout(resolve, timeoutMs + 20_000);
				const onMessage = m => {
					if (m.type === 'promptCancel' || m.type === 'token') {
						if (m.type === 'token') { tokens += m.delta ?? ''; }
						return;
					}
					events.push(m);
					// Nobody is at the keyboard: approvals are granted (the benchmark runs with the
					// approval policy it was given), and a question gets its first option, which is
					// counted so a model that asks instead of working is visible in the report.
					if (m.type === 'approvalRequest') {
						toChat({ type: 'promptResponse', promptId: m.id, response: { approved: true } });
					} else if (m.type === 'askRequest') {
						toChat({ type: 'promptResponse', promptId: m.id, response: { answer: m.options?.[0]?.label ?? 'Use your best judgment and continue.' } });
					}
					if (m.type === 'done' && (!m.runId || m.runId === runId)) {
						clearTimeout(timer); clearTimeout(hardStop); listeners.delete(onMessage); resolve();
					}
				};
				listeners.add(onMessage);
				toChat({ type: 'send', sessionId, runId, mode, provider, model, text, inline: false });
			});
			return summarize(events, tokens, Date.now() - startedAt, timedOut);
		},
		async stop() {
			ws.close();
			host.kill();
			await new Promise(r => setTimeout(r, 200));
			fs.rmSync(data, { recursive: true, force: true });
		},
	};
}

/** Reduces a run's message stream to the numbers the report needs. */
function summarize(events, tokens, ms, timedOut) {
	const tools = {};
	let toolErrors = 0;
	let steps = 0;
	let asked = 0;
	let lastText = '';
	const errors = [];
	const notes = [];
	let estInputTokens = 0;
	let requests = 0;
	for (const m of events) {
		if (m.type === 'agentStepStart') { steps++; }
		else if (m.type === 'toolStart' && !m.parentCallId) { tools[m.name] = (tools[m.name] ?? 0) + 1; if (m.name === 'ask_user') { asked++; } }
		else if (m.type === 'toolEnd' && m.isError && !m.parentCallId) { toolErrors++; }
		else if (m.type === 'agentStepEnd' && typeof m.content === 'string' && m.content.trim()) { lastText = m.content; }
		else if (m.type === 'error') { errors.push(String(m.message)); }
		else if (m.type === 'info') {
			notes.push(String(m.message));
			const run = /~([\d.]+)k estimated input tokens over (\d+) request/.exec(String(m.message));
			if (run) { estInputTokens = Math.round(Number(run[1]) * 1000); requests = Number(run[2]); }
		}
	}
	return {
		text: lastText || tokens,
		steps,
		tools,
		toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
		toolErrors,
		asked,
		estInputTokens,
		requests,
		ms,
		timedOut,
		errors,
		notes,
	};
}
