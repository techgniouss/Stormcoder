// End-to-end for the Claude Code engine: the real app engine and UI in Chromium, with
// `stormcoder.engine` set to `claude-code`. A fake Claude Agent SDK stands in for the harness: like
// the real one it calls the local gateway over HTTP (Anthropic Messages API, streamed), runs the
// PreToolUse / PostToolUse hooks it was given, and executes tools. A mock OpenAI-compatible server
// is the model behind the gateway and counts every request it receives.
//
// What this proves, that unit tests cannot:
//  - the setting routes chats to the engine and nowhere else (no Stormcoder prompt, no Stormcoder tools);
//  - a turn costs exactly the model requests the harness made (no compaction, memory or title calls);
//  - the harness never sees provider keys, only a gateway token;
//  - guardrails stop a dangerous command made by the harness;
//  - a follow-up continues the same engine session.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- the fake SDK --------------------------------------------------------------------------------

const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
const sdkDir = path.join(sdkRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdkDir, { recursive: true });
const callsFile = path.join(sdkDir, 'calls.jsonl');
fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
	name: '@anthropic-ai/claude-agent-sdk', version: '0.3.999', type: 'module', exports: { '.': { default: './sdk.mjs' } },
}));
fs.writeFileSync(path.join(sdkDir, 'sdk.mjs'), `
import fs from 'node:fs';
import path from 'node:path';

const TOOLS = [
	{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
	{ name: 'Bash', description: 'Runs a command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
	{ name: 'Write', description: 'Writes a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
];

export function query({ prompt, options }) {
	const text = typeof prompt === 'string' ? prompt : '[stream]';
	fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
		prompt: text, resume: options.resume, title: options.title, permissionMode: options.permissionMode,
		settingSources: options.settingSources, tools: options.tools, env: options.env, systemPrompt: options.systemPrompt,
		cwd: options.cwd, hookOnFailure: options.hooks.PreToolUse[0].onFailure,
	}) + '\\n');
	return {
		close() {},
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			const sessionId = options.resume ?? 'FAKE-SESSION-1';
			yield { type: 'system', subtype: 'init', session_id: sessionId };
			const { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model } = options.env;
			const messages = [{ role: 'user', content: text }];
			let last = '';
			for (let step = 0; step < 4; step++) {
				const res = await fetch(base + '/v1/messages?beta=true', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
					body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: [{ type: 'text', text: 'FAKE HARNESS SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages }),
				});
				if (!res.ok) {
					yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [await res.text()], session_id: sessionId };
					return;
				}
				const blocks = [];
				yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
				let buffer = '';
				for await (const chunk of res.body) {
					buffer += Buffer.from(chunk).toString('utf8');
					let cut;
					while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
						const frame = buffer.slice(0, cut);
						buffer = buffer.slice(cut + 2);
						const data = /^data: (.+)$/m.exec(frame)?.[1];
						if (!data) { continue; }
						const e = JSON.parse(data);
						if (e.type === 'content_block_start') {
							blocks[e.index] = e.content_block.type === 'text' ? { type: 'text', text: '' } : { ...e.content_block, json: '' };
						} else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
							blocks[e.index].text += e.delta.text;
							yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: e.delta } };
						} else if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') {
							blocks[e.index].json += e.delta.partial_json;
						}
					}
				}
				for (const b of blocks) { if (b.type === 'tool_use') { b.input = JSON.parse(b.json || '{}'); delete b.json; } }
				for (const b of blocks) { yield { type: 'assistant', parent_tool_use_id: null, message: { content: [b] } }; }
				yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
				last = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
				messages.push({ role: 'assistant', content: blocks });
				const uses = blocks.filter(b => b.type === 'tool_use');
				if (!uses.length) { break; }
				const results = [];
				for (const use of uses) {
					const pre = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: use.name, tool_input: use.input, tool_use_id: use.id }, use.id);
					const out = pre.hookSpecificOutput;
					let content;
					let isError = false;
					if (out.permissionDecision === 'deny') {
						content = out.permissionDecisionReason;
						isError = true;
					} else if (use.name === 'Read') {
						content = fs.readFileSync(path.join(options.cwd, use.input.file_path), 'utf8');
					} else if (use.name === 'Write') {
						fs.writeFileSync(path.join(options.cwd, use.input.file_path), use.input.content);
						content = 'wrote ' + use.input.file_path;
					} else {
						content = 'ran: ' + use.input.command;
					}
					await options.hooks.PostToolUse[0].hooks[0]({ tool_use_id: use.id }, use.id);
					results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: isError });
				}
				yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: results } };
				messages.push({ role: 'user', content: results });
			}
			yield { type: 'result', subtype: 'success', is_error: false, result: last, session_id: sessionId, total_cost_usd: 0.001 };
		},
	};
}
`);

// --- the model behind the gateway ----------------------------------------------------------------

const mock = await startMock(req => {
	// The independent reviewer (Stormcoder's own request, not the harness's).
	if (String(req.messages[0]?.content).includes('You are the REVIEWER')) {
		if (String(req.messages[1]?.content).includes('Review my uncommitted changes')) { return 'Slash review done.\nVERDICT: PASS'; }
		return 'The change adds notes.txt as asked.\nVERDICT: ISSUES\n- No test covers it.';
	}
	const lastMessage = req.messages.at(-1);
	if (lastMessage?.role === 'tool') {
		return `Tool said: ${String(lastMessage.content).trim()}`;
	}
	const prompt = String(lastMessage?.content ?? '');
	if (/create notes/.test(prompt)) { return { text: 'Writing it.', tool: { name: 'Write', args: { file_path: 'notes.txt', content: 'remember the milk\n' } } }; }
	if (/danger/.test(prompt)) { return { text: 'Cleaning up.', tool: { name: 'Bash', args: { command: 'rm -rf build' } } }; }
	if (/read/.test(prompt)) { return { text: 'Reading it.', tool: { name: 'Read', args: { file_path: 'hello.txt' } } }; }
	return 'A plain answer.';
});

// The parent environment holds a provider key; it must never reach the harness.
const host = await startHost({
	mockPort: mock.port,
	settings: {
		'stormcoder.engine': 'claude-code',
		'stormcoder.engine.claudeCode.sdkPath': sdkRoot,
		// Would make an extra model request after a run under the built-in engine.
		'stormcoder.memory.autoPropose': true,
		// An explicit reviewer: the only way a second model is ever called after an engine run.
		'stormcoder.auto.reviewModel': 'custom:mock-model',
	},
	files: { 'hello.txt': 'hi there\n' },
	env: { OPENAI_API_KEY: 'sk-parent-secret' },
});

const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: host.project, encoding: 'utf8' });
git('init', '-q');
fs.writeFileSync(path.join(host.project, '.gitignore'), '.stormcoder/\n.openvs/\n');
git('add', '-A');
git('commit', '-qm', 'baseline');

const browser = await launchChromium();
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();
	await chat.locator('.seg-btn[data-value=agent]').click();

	const send = async text => {
		await chat.locator('#input').fill(text);
		await chat.locator('#input').press('Enter');
	};
	const calls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));

	// 1. A turn that uses a tool: two model requests, and nothing else.
	await send('please read the file');
	await chat.getByText('Tool said: hi there').first().waitFor({ timeout: 30000 });
	await chat.getByText('Claude Code engine').first().waitFor({ timeout: 5000 });
	assert.equal(mock.seen.length, 2, `a tool turn is exactly two model requests, saw ${mock.seen.length}`);

	// It was the harness's request, not Stormcoder's: its system prompt and its tools.
	const first = mock.seen[0];
	assert.equal(first.messages[0].role, 'system');
	assert.equal(first.messages[0].content, 'FAKE HARNESS SYSTEM PROMPT', 'the harness prompt, with no Stormcoder text added');
	assert.deepEqual(first.tools.map(t => t.function.name).sort(), ['Bash', 'Read', 'Write']);
	assert.ok(!mock.seen.some(r => r.tools?.some(t => ['write_file', 'run_command', 'update_todos'].includes(t.function?.name))), 'no built-in agent tools were offered');

	// What the harness process was given.
	const [turn1] = calls();
	assert.equal(turn1.permissionMode, 'default');
	assert.deepEqual(turn1.settingSources, ['project']);
	assert.equal(turn1.hookOnFailure, 'block');
	assert.equal(turn1.env.OPENAI_API_KEY, undefined, 'a provider key from the parent environment must not reach the harness');
	assert.match(turn1.env.ANTHROPIC_AUTH_TOKEN, /^sk-stormcoder-/);
	assert.match(turn1.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.equal(turn1.env.ANTHROPIC_MODEL, 'stormcoder-main');
	assert.equal(turn1.env.DISABLE_TELEMETRY, '1');
	assert.equal(turn1.title, 'please read the file', 'a title is supplied so the harness spends no model call on one');
	assert.equal(turn1.resume, undefined);
	assert.ok(!JSON.stringify(mock.seen).includes(turn1.env.ANTHROPIC_AUTH_TOKEN), 'the gateway token is never forwarded to a provider');

	// No side calls, even with the settings that trigger them under the built-in engine.
	await new Promise(r => setTimeout(r, 1500));
	assert.equal(mock.seen.length, 2, 'no memory proposal or compaction request after the run');
	assert.ok(!mock.seen.some(r => String(r.messages.at(-1)?.content).includes('You maintain a short project memory')));
	assert.ok(!fs.existsSync(path.join(host.project, '.stormcoder/proposals.json')), 'nothing was proposed to memory');

	// 2. A follow-up continues the same engine session.
	await send('and a plain question');
	await chat.getByText('A plain answer.').first().waitFor({ timeout: 30000 });
	assert.equal(mock.seen.length, 3);
	const turn2 = calls()[1];
	assert.equal(turn2.resume, 'FAKE-SESSION-1', 'the second turn resumes the engine session');
	assert.equal(turn2.title, undefined, 'a resumed chat is not re-titled');

	// 3. A dangerous command by the harness is stopped by the guardrails, and the model is told why.
	await send('do something danger');
	await chat.getByText(/Tool said: .*guardrail/).first().waitFor({ timeout: 30000 });
	assert.equal(mock.seen.length, 5);
	const toolMessage = mock.seen.at(-1).messages.at(-1);
	assert.equal(toolMessage.role, 'tool');
	assert.match(String(toolMessage.content), /blocked by a guardrail/);
	assert.ok(!fs.existsSync(path.join(host.project, 'build')));

	// 4. A run that changes files is reviewed once, by the pinned reviewer, and only that run.
	assert.equal(mock.seen.length, 5, 'no review ran for the turns that changed nothing, though a reviewer is pinned');
	// Uncommitted work that was already there; the run below does not touch it.
	fs.writeFileSync(path.join(host.project, 'hello.txt'), 'hi there\nDIRTY BEFORE RUN\n');
	await send('please create notes');
	await chat.getByText('Tool said: wrote notes.txt').first().waitFor({ timeout: 30000 });
	await chat.getByText('No test covers it.').first().waitFor({ timeout: 30000 });
	assert.equal(fs.readFileSync(path.join(host.project, 'notes.txt'), 'utf8'), 'remember the milk\n');
	assert.equal(mock.seen.length, 8, 'the turn is two harness requests plus exactly one review request');
	const reviewRequest = mock.seen.at(-1);
	assert.match(String(reviewRequest.messages[0].content), /You are the REVIEWER/);
	assert.match(String(reviewRequest.messages[1].content), /\+remember the milk/, 'the reviewer is given the actual change');
	assert.match(String(reviewRequest.messages[1].content), /create notes/, 'and the request it answered');
	assert.equal(reviewRequest.tools, undefined, 'the reviewer has no tools');
	assert.ok(!String(reviewRequest.messages[1].content).includes('DIRTY BEFORE RUN'), 'work that was there before the run is not charged to it');

	// 5. A follow-up changes nothing: no second review, and the findings reach the engine once.
	await send('thanks, add a test');
	await chat.getByText('A plain answer.').nth(1).waitFor({ timeout: 30000 });
	assert.equal(mock.seen.length, 9, 'a follow-up that changes nothing costs one request and no review');
	assert.match(calls().at(-1).prompt, /A second reviewer examined your last changes/);
	assert.match(calls().at(-1).prompt, /No test covers it\./);
	await send('and one more thing');
	await chat.getByText('A plain answer.').nth(2).waitFor({ timeout: 30000 });
	assert.ok(!calls().at(-1).prompt.includes('second reviewer'), 'the findings are passed on once, not every turn');
	assert.equal(mock.seen.length, 10);

	// 6. /review goes straight to the pinned reviewer, over everything uncommitted; the harness is not asked.
	const harnessCalls = calls().length;
	await send('/review');
	await chat.getByText('Slash review done.').first().waitFor({ timeout: 30000 });
	assert.equal(mock.seen.length, 11, '/review is exactly one request, to the reviewer');
	assert.equal(calls().length, harnessCalls, 'the harness did not run');
	assert.match(String(mock.seen.at(-1).messages[1].content), /DIRTY BEFORE RUN/, '/review covers all uncommitted work');
	assert.match(String(mock.seen.at(-1).messages[1].content), /remember the milk/);

	// The gateway served everything on its translated path; nothing else was reached.
	assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
	console.log('engine e2e: all assertions passed');
} catch (err) {
	failed = true;
	console.error(err);
	console.error('--- host log ---\n' + host.log().slice(-3000));
} finally {
	await browser.close();
	host.stop();
	mock.close();
	fs.rmSync(sdkRoot, { recursive: true, force: true });
}

// --- the engine is selected but cannot start: the app keeps working on the built-in agent ----------

if (!failed) {
	const mock2 = await startMock(req => (req.tools?.length ? 'Built-in agent answered.' : 'Built-in agent answered.'));
	const host2 = await startHost({
		mockPort: mock2.port,
		settings: { 'stormcoder.engine': 'claude-code', 'stormcoder.engine.claudeCode.sdkPath': path.join(os.tmpdir(), 'no-such-sdk-folder') },
	});
	const browser2 = await launchChromium();
	try {
		const page = await browser2.newPage({ viewport: { width: 1280, height: 800 } });
		const errors = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(host2.url);
		const chat = page.frameLocator('#view-chat');
		await chat.locator('#input').waitFor();
		await chat.locator('.seg-btn[data-value=agent]').click();
		await chat.locator('#input').fill('hello there');
		await chat.locator('#input').press('Enter');
		await chat.getByText('Built-in agent answered.').first().waitFor({ timeout: 30000 });
		await chat.getByText(/Claude Code engine is not available/).first().waitFor({ timeout: 5000 });
		assert.ok(String(mock2.seen[0].messages[0].content).length > 200, 'the built-in agent\'s own prompt was used');
		assert.ok(!String(mock2.seen[0].messages[0].content).includes('FAKE HARNESS'));
		// The note is shown once per chat, not on every message.
		await chat.locator('#input').fill('and again');
		await chat.locator('#input').press('Enter');
		await chat.getByText('Built-in agent answered.').nth(1).waitFor({ timeout: 30000 });
		assert.equal(await chat.getByText(/Claude Code engine is not available/).count(), 1);
		assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
		console.log('engine e2e (fallback): all assertions passed');
	} catch (err) {
		failed = true;
		console.error(err);
		console.error('--- host log ---\n' + host2.log().slice(-3000));
	} finally {
		await browser2.close();
		host2.stop();
		mock2.close();
	}
}
process.exit(failed ? 1 : 0);
