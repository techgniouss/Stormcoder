// Turning the Claude Code engine off again: use the engine, restart the app with the setting back on
// "builtin", and keep working in the same project. The built-in agent must take over cleanly: its own
// prompt and tools reach the model, the harness is not touched, and the chat from before is still there.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
const sdkDir = path.join(sdkRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdkDir, { recursive: true });
const callsFile = path.join(sdkDir, 'calls.jsonl');
fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.999', type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
// A minimal harness: one non-streaming request to the gateway, then the answer.
fs.writeFileSync(path.join(sdkDir, 'sdk.mjs'), `
import fs from 'node:fs';
export function query({ prompt, options }) {
	fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ prompt: String(prompt) }) + '\\n');
	return {
		close() {}, async interrupt() {},
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', session_id: 'S1' };
			const { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model } = options.env;
			const res = await fetch(base + '/v1/messages', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify({ model, max_tokens: 256, stream: false, system: 'FAKE HARNESS SYSTEM PROMPT', messages: [{ role: 'user', content: String(prompt) }] }),
			});
			const json = await res.json();
			const text = (json.content ?? []).map(b => b.text ?? '').join('');
			yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } };
			yield { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'S1', total_cost_usd: 0 };
		},
	};
}
`);

const mock = await startMock(req => {
	const first = String(req.messages[0]?.content ?? '');
	return first.includes('FAKE HARNESS SYSTEM PROMPT') ? 'Engine reply.' : 'Built-in reply.';
});

const host = await startHost({
	mockPort: mock.port,
	settings: { 'stormcoder.engine': 'claude-code', 'stormcoder.engine.claudeCode.sdkPath': sdkRoot },
	files: { 'hello.txt': 'hi\n' },
});
const browser = await launchChromium();
let failed = false;
try {
	const open = async url => {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		const errors = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(url);
		const chat = page.frameLocator('#view-chat');
		await chat.locator('#input').waitFor();
		await chat.locator('.seg-btn[data-value=agent]').click();
		return { page, chat, errors };
	};
	const send = async (chat, text) => {
		await chat.locator('#input').fill(text);
		await chat.locator('#input').press('Enter');
	};
	const harnessCalls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);

	// 1. On the engine.
	let ui = await open(host.url);
	await send(ui.chat, 'hello one');
	await ui.chat.getByText('Engine reply.').first().waitFor({ timeout: 30000 });
	assert.equal(harnessCalls(), 1);
	const requestsOnEngine = mock.seen.length;
	assert.ok(String(mock.seen[0].messages[0].content).includes('FAKE HARNESS SYSTEM PROMPT'));
	await ui.page.close();

	// 2. The setting goes back and the app restarts.
	const url = await host.restart({ 'stormcoder.engine': 'builtin' });
	ui = await open(url);
	await send(ui.chat, 'hello two');
	await ui.chat.getByText('Built-in reply.').first().waitFor({ timeout: 30000 });

	// The built-in agent served it: its own prompt and tools, no harness involved.
	const request = mock.seen[requestsOnEngine];
	assert.ok(!String(request.messages[0].content).includes('FAKE HARNESS SYSTEM PROMPT'), 'the model was not reached through the harness');
	assert.ok(request.tools?.some(t => ['read_file', 'write_file', 'run_command'].includes(t.function?.name)), 'the built-in agent\'s tools were offered');
	assert.equal(harnessCalls(), 1, 'the harness was not started again');
	assert.equal(await ui.chat.getByText(/Claude Code engine · /).count(), 0, 'no engine banner');
	assert.equal(await ui.chat.getByText(/engine is not available|handled by the built-in agent instead/).count(), 0, 'no fallback notice: this is the default path, not a fallback');

	// 3. The earlier conversation survived the switch.
	assert.ok(await ui.chat.getByText('Engine reply.').count() >= 1, 'the chat from the engine session is still there');

	// 4. The panel agrees.
	assert.deepEqual(ui.errors, []);
	console.log('engine switch-back e2e: all assertions passed');
} catch (err) {
	failed = true;
	console.error(err);
	console.error(host.log());
} finally {
	await browser.close();
	host.stop();
	mock.close();
	fs.rmSync(sdkRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
