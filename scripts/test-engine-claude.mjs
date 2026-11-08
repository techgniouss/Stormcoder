/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/engine/claudeEngine.ts: the options handed to the Claude Agent SDK, the
// environment of the harness process, and the translation of its message stream into chat UI
// callbacks. The SDK is a scripted fake; no process is started.
//   node scripts/build-tests.mjs && node scripts/test-engine-claude.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			Uri: { file: p => ({ fsPath: p, toString: () => p }), joinPath: (b, ...parts) => ({ fsPath: path.posix.join(b.fsPath, ...parts) }) },
			workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [], isTrusted: true },
			window: {}, commands: {}, env: {}, ConfigurationTarget: { Global: 1 }, EventEmitter: class { }, Disposable: class { },
		};
	}
	return originalLoad(request, parent, isMain);
};

const engineMod = await import(new URL('../out/engine/claudeEngine.js', import.meta.url));
const { ClaudeEngine, MessageMapper, buildEngineEnv, buildQueryOptions, buildPrompt, engineTools, findSdk, sdkCandidates, loadClaudeSdk, sdkMissingMessage, sandboxSettings, todosOf, TESTED_SDK_SERIES } = engineMod;
const { FileTracker } = await import(new URL('../out/engine/toolBridge.js', import.meta.url));
const { loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));
const { MAIN_ALIAS, FAST_ALIAS } = await import(new URL('../out/engine/modelMap.js', import.meta.url));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
const translatedRoute = { main: { providerId: 'openai', model: 'gpt-x' }, fast: { providerId: 'openai', model: 'gpt-mini' } };
const claudeRoute = { main: { providerId: 'anthropic', model: 'claude-sonnet-x' }, fast: { providerId: 'anthropic', model: 'claude-haiku-x' } };

function approver() {
	const asked = [];
	const writes = [];
	return { asked, writes, confirm: async r => { asked.push(r); return { approved: true }; }, ask: async () => '', recordWrite: w => writes.push(w) };
}

function turn(overrides = {}) {
	return {
		sessionId: 's1', prompt: 'fix the bug', cwd: root, route: translatedRoute, mode: 'agent',
		guardrails: { ...loadGuardrails(), approval: 'auto-edits' }, approver: approver(), trusted: true,
		signal: new AbortController().signal, contextWindow: 128_000, loadProjectSettings: true, auth: 'gateway',
		...overrides,
	};
}

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		console.error(`FAIL ${name}`);
		throw err;
	}
}

// --- environment ---------------------------------------------------------------------------------

await test('the harness environment keeps only the allow-list and never a provider key', () => {
	const parent = {
		PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:3128', SSH_AUTH_SOCK: '/tmp/agent',
		ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oat', GITHUB_TOKEN: 'ghp_x',
		AWS_SECRET_ACCESS_KEY: 'aws', ANTHROPIC_BASE_URL: 'https://elsewhere', NODE_OPTIONS: '--require /evil.js',
	};
	const env = buildEngineEnv(parent, { route: translatedRoute, auth: 'gateway', contextWindow: 128_000 }, { baseUrl: 'http://127.0.0.1:5555', token: 'sk-stormcoder-t' });
	assert.equal(env.PATH, '/usr/bin');
	assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
	for (const secret of ['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY']) {
		assert.equal(env[secret], undefined, `${secret} must not reach the harness`);
	}
	assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555', 'the gateway, not the parent value');
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-stormcoder-t');
	assert.equal(env.ANTHROPIC_MODEL, MAIN_ALIAS);
	assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, FAST_ALIAS);
	assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '128000');
	for (const flag of ['DISABLE_TELEMETRY', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) { assert.equal(env[flag], '1'); }
	assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false');
});

await test('a Claude model keeps its real ids and needs no compaction override; own-login sets no gateway at all', () => {
	const env = buildEngineEnv({ PATH: '/p' }, { route: claudeRoute, auth: 'gateway', contextWindow: 200_000 }, { baseUrl: 'http://127.0.0.1:1', token: 't' });
	assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-x');
	assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
	const own = buildEngineEnv({ PATH: '/p' }, { route: claudeRoute, auth: 'own-login', contextWindow: 200_000 }, undefined);
	assert.equal(own.ANTHROPIC_BASE_URL, undefined);
	assert.equal(own.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(own.DISABLE_TELEMETRY, '1');
});

// --- options -------------------------------------------------------------------------------------

function options(t, extra = {}) {
	const abort = new AbortController();
	const tracker = new FileTracker(t.cwd, t.approver);
	return buildQueryOptions(t, { env: { PATH: '/p' }, abort, tracker, stderr: () => { }, ...extra });
}

await test('options never pick a permission bypass or a classifier, and never load user or local settings', () => {
	for (const mode of ['ask', 'plan', 'agent']) {
		for (const trusted of [true, false]) {
			for (const loadProjectSettings of [true, false]) {
				for (const route of [translatedRoute, claudeRoute]) {
					const o = options(turn({ mode, trusted, loadProjectSettings, route }));
					assert.ok(['default', 'plan'].includes(o.permissionMode), `mode ${o.permissionMode}`);
					assert.equal(o.allowDangerouslySkipPermissions, undefined);
					assert.ok(Array.isArray(o.settingSources));
					assert.ok(!o.settingSources.includes('user') && !o.settingSources.includes('local'));
					assert.equal(o.strictMcpConfig, true);
					assert.equal(o.mcpServers, undefined);
					assert.equal(o.plugins, undefined);
				}
			}
		}
	}
	assert.equal(options(turn({ mode: 'plan' })).permissionMode, 'plan');
	assert.equal(options(turn({ mode: 'agent' })).permissionMode, 'default');
});

await test('project settings load only in a trusted folder and only when asked for', () => {
	assert.deepEqual(options(turn({ trusted: true, loadProjectSettings: true })).settingSources, ['project']);
	assert.deepEqual(options(turn({ trusted: true, loadProjectSettings: false })).settingSources, []);
	assert.deepEqual(options(turn({ trusted: false, loadProjectSettings: true })).settingSources, []);
});

await test('every background model-call feature is switched off', () => {
	const o = options(turn());
	assert.equal(o.promptSuggestions, false);
	assert.equal(o.agentProgressSummaries, false);
	assert.equal(o.settings.autoMemoryEnabled, false);
	assert.equal(o.settings.autoDreamEnabled, false);
	assert.equal(o.settings.promptSuggestionEnabled, false);
	assert.equal(options(turn({ title: 'Fix the bug' })).title, 'Fix the bug', 'a given title spares a title-generation call');
});

await test('Claude features are kept for Claude and stripped for other models only', () => {
	const other = options(turn({ route: translatedRoute }));
	assert.deepEqual(other.thinking, { type: 'disabled' });
	assert.equal(other.settings.includeCoAuthoredBy, false, 'no "Co-Authored-By: Claude" on another model\'s commits');
	assert.deepEqual(other.disallowedTools, ['WebSearch']);
	assert.ok(!other.tools.includes('WebSearch'));
	const claude = options(turn({ route: claudeRoute }));
	assert.equal(claude.thinking, undefined, 'the harness decides thinking for Claude');
	assert.equal(claude.settings.includeCoAuthoredBy, undefined);
	assert.deepEqual(claude.disallowedTools, []);
	assert.ok(claude.tools.includes('WebSearch'));
	assert.deepEqual(engineTools('anthropic').slice(0, -1), engineTools('translated'));
});

await test('system prompt is the harness preset, with Stormcoder text only when asked', () => {
	assert.deepEqual(options(turn()).systemPrompt, { type: 'preset', preset: 'claude_code', snapshot: true });
	assert.equal(options(turn({ appendPrompt: 'Project facts: ...' })).systemPrompt.append, 'Project facts: ...');
});

await test('resume, turn limit and binary path are passed through', () => {
	const o = options(turn({ resumeId: 'sess-1', title: 'ignored', maxTurns: 40, cliPath: '/opt/claude' }));
	assert.equal(o.resume, 'sess-1');
	assert.equal(o.title, undefined, 'a resumed chat keeps its own title');
	assert.equal(o.maxTurns, 40);
	assert.equal(o.pathToClaudeCodeExecutable, '/opt/claude');
	assert.equal(options(turn()).resume, undefined);
});

await test('the PreToolUse hook fails closed and enforces the guardrails', async () => {
	const t = turn();
	const o = options(t);
	const [matcher] = o.hooks.PreToolUse;
	assert.equal(matcher.onFailure, 'block');
	assert.ok(matcher.timeout >= 600, 'long enough for a human to answer an approval card');
	const hook = matcher.hooks[0];

	const blocked = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'a' });
	assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
	assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /guardrail/);
	const unknown = await hook({ tool_name: 'Monitor', tool_input: {}, tool_use_id: 'b' });
	assert.equal(unknown.hookSpecificOutput.permissionDecision, 'deny');

	// An allowed edit is snapshotted before and recorded after, so Undo works.
	const file = path.join(root, 'x.ts');
	fs.writeFileSync(file, 'one');
	const ok = await hook({ tool_name: 'Edit', tool_input: { file_path: 'x.ts', old_string: 'one', new_string: 'two' }, tool_use_id: 'c' });
	assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
	fs.writeFileSync(file, 'two');
	await o.hooks.PostToolUse[0].hooks[0]({ tool_use_id: 'c' }, 'c');
	assert.equal(t.approver.writes.length, 1);
	assert.equal(t.approver.writes[0].before, 'one');
	assert.equal(t.approver.writes[0].after, 'two');

	// A failed tool call still reconciles, and records nothing when nothing changed.
	await hook({ tool_name: 'Edit', tool_input: { file_path: 'x.ts', old_string: 'q', new_string: 'r' }, tool_use_id: 'd' });
	await o.hooks.PostToolUseFailure[0].hooks[0]({ tool_use_id: 'd' }, 'd');
	assert.equal(t.approver.writes.length, 1);
});

await test('a read-only chat denies writes through the hook', async () => {
	const o = options(turn({ mode: 'ask' }));
	const v = await o.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'n.ts', content: 'x' }, tool_use_id: 'a' });
	assert.equal(v.hookSpecificOutput.permissionDecision, 'deny');
	const r = await o.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'x.ts' }, tool_use_id: 'b' });
	assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

await test('prompt: plain text, a one-time seed, and images as a message stream', async () => {
	assert.equal(buildPrompt({ prompt: 'hi' }), 'hi');
	const seeded = buildPrompt({ prompt: 'now this', transcriptSeed: 'we fixed X' });
	assert.match(seeded, /we fixed X/);
	assert.match(seeded, /My request now:\nnow this/);
	const stream = buildPrompt({ prompt: 'see', images: [{ mimeType: 'image/png', data: 'AAAA' }] });
	assert.equal(typeof stream[Symbol.asyncIterator], 'function');
	const messages = [];
	for await (const m of stream) { messages.push(m); }
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
	assert.deepEqual(messages[0].message.content[1], { type: 'text', text: 'see' });
});

// --- message mapping -----------------------------------------------------------------------------

function recorder() {
	const events = [];
	return {
		events,
		cb: {
			onStepStart: () => events.push(['stepStart']),
			onToken: d => events.push(['token', d]),
			onStepEnd: c => events.push(['stepEnd', c]),
			onToolStart: (c, p) => events.push(['toolStart', c.name, c.id, p]),
			onToolEnd: (c, r, e, p) => events.push(['toolEnd', c.name, r, e, p]),
			onNote: t => events.push(['note', t]),
			onTodos: items => events.push(['todos', items]),
		},
	};
}

await test('a streamed reply with a tool call and its result maps to the UI callbacks in order', () => {
	const { events, cb } = recorder();
	const m = new MessageMapper(cb);
	const feed = [
		{ type: 'system', subtype: 'init', session_id: 'sess-9' },
		{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } },
		{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me ' } } },
		{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } } },
		{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'look.' } } },
		{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Let me look.' }] } },
		{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } }] } },
		{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
		{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'const a = 1;' }] }] } },
		{ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-9', total_cost_usd: 0.0123 },
	];
	for (const msg of feed) { m.handle(msg); }
	assert.deepEqual(events, [
		['stepStart'], ['token', 'Let me '], ['token', 'look.'],
		['toolStart', 'read_file', 'tu1', undefined],
		['stepEnd', 'Let me look.'],
		['toolEnd', 'read_file', 'const a = 1;', false, undefined],
	]);
	assert.equal(m.sessionId, 'sess-9');
	assert.equal(m.result.reason, 'done');
	assert.equal(m.result.costUsd, 0.0123);
});

await test('without partial messages the reply text is shown whole', () => {
	const { events, cb } = recorder();
	const m = new MessageMapper(cb);
	m.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'All done.' }] } });
	assert.deepEqual(events, [['stepStart'], ['token', 'All done.'], ['stepEnd', 'All done.']]);
});

await test('a sub-agent\'s tool calls nest under the call that started it and its text stays out', () => {
	const { events, cb } = recorder();
	const m = new MessageMapper(cb);
	m.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { prompt: 'explore' } }] } });
	m.handle({ type: 'stream_event', parent_tool_use_id: 'agent1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'inner thoughts' } } });
	m.handle({ type: 'assistant', parent_tool_use_id: 'agent1', message: { content: [{ type: 'text', text: 'inner thoughts' }, { type: 'tool_use', id: 'inner1', name: 'Grep', input: { pattern: 'x' } }] } });
	m.handle({ type: 'user', parent_tool_use_id: 'agent1', message: { content: [{ type: 'tool_result', tool_use_id: 'inner1', content: 'match' }] } });
	assert.deepEqual(events, [
		['toolStart', 'Agent', 'agent1', undefined],
		['toolStart', 'search_files', 'inner1', 'agent1'],
		['toolEnd', 'search_files', 'match', false, 'agent1'],
	]);
});

await test('TodoWrite updates the checklist; a failed tool result is flagged', () => {
	const { events, cb } = recorder();
	const m = new MessageMapper(cb);
	m.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }, { content: 'b', status: 'bogus' }, { content: 'c', status: 'completed' }] } }] } });
	assert.deepEqual(events.find(e => e[0] === 'todos')[1], [{ content: 'a', status: 'in_progress' }, { content: 'c', status: 'completed' }]);
	m.handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] } });
	assert.deepEqual(events.at(-1), ['toolEnd', 'TodoWrite', 'boom', true, undefined]);
	assert.deepEqual(todosOf(undefined), []);
});

await test('results map to stop reasons', () => {
	const run = message => { const m = new MessageMapper(recorder().cb); m.handle({ type: 'result', ...message }); return m.result; };
	assert.equal(run({ subtype: 'success', is_error: false }).reason, 'done');
	assert.equal(run({ subtype: 'error_max_turns' }).reason, 'limit');
	const failed = run({ subtype: 'error_during_execution', errors: ['bad', 'worse'] });
	assert.equal(failed.reason, 'error');
	assert.equal(failed.detail, 'bad; worse');
	assert.ok(failed.failure instanceof Error);
	const api = run({ subtype: 'success', is_error: true, result: 'API Error: 401' });
	assert.equal(api.reason, 'error');
	assert.match(api.detail, /401/);
});

await test('compaction and API retries become notes', () => {
	const { events, cb } = recorder();
	const m = new MessageMapper(cb);
	m.handle({ type: 'system', subtype: 'compact_boundary' });
	m.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 529 });
	assert.match(events[0][1], /compacted/);
	assert.match(events[1][1], /HTTP 529.*attempt 2 of 10/);
});

// --- the engine ----------------------------------------------------------------------------------

function fakeGateway() {
	const state = { registered: [], disposed: 0 };
	return {
		state,
		baseUrl: 'http://127.0.0.1:7777',
		registerSession(reg) {
			state.registered.push(reg);
			return { token: 'sk-stormcoder-fake', dispose: () => { state.disposed++; } };
		},
	};
}

/** A fake SDK whose query() replays `script` and records what it was given. */
function fakeSdk(script, { throwAfter } = {}) {
	const calls = [];
	return {
		calls,
		sdk: {
			query(params) {
				calls.push(params);
				let closed = false;
				return {
					close: () => { closed = true; },
					interrupt: async () => { },
					get closed() { return closed; },
					async *[Symbol.asyncIterator]() {
						for (const msg of script) { yield msg; }
						if (throwAfter) { throw throwAfter; }
					},
				};
			},
		},
	};
}

const okScript = [
	{ type: 'system', subtype: 'init', session_id: 'S1' },
	{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } },
	{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'S1', total_cost_usd: 0.5 },
];

await test('run: registers a gateway session, hands the SDK a scrubbed env and token, and cleans up', async () => {
	const gateway = fakeGateway();
	const { sdk, calls } = fakeSdk(okScript);
	const engine = new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: { PATH: '/p', OPENAI_API_KEY: 'sk-secret' } });
	const { cb, events } = recorder();
	const result = await engine.run(turn(), cb);
	assert.equal(result.reason, 'done');
	assert.equal(result.sessionId, 'S1');
	assert.equal(result.costUsd, 0.5);
	assert.equal(gateway.state.registered.length, 1);
	assert.equal(gateway.state.registered[0].id, 's1');
	assert.deepEqual(gateway.state.registered[0].route, translatedRoute);
	assert.equal(gateway.state.disposed, 1, 'the gateway token is retired when the turn ends');
	const env = calls[0].options.env;
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-stormcoder-fake');
	assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7777');
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(calls[0].prompt, 'fix the bug');
	assert.deepEqual(events.map(e => e[0]), ['stepStart', 'token', 'stepEnd']);
});

await test('run: gateway usage and notices reach the UI callbacks', async () => {
	const gateway = fakeGateway();
	const { sdk } = fakeSdk(okScript);
	const engine = new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: {} });
	const usage = [];
	const { cb, events } = recorder();
	await engine.run(turn(), { ...cb, onUsage: u => usage.push(u) });
	gateway.state.registered[0].onUsage({ inputTokens: 5 });
	gateway.state.registered[0].onNotice('Left out an image');
	assert.deepEqual(usage, [{ inputTokens: 5 }]);
	assert.ok(events.some(e => e[0] === 'note' && e[1] === 'Left out an image'));
});

await test('run: own-login mode starts no gateway session and sets no gateway env', async () => {
	const gateway = fakeGateway();
	const { sdk, calls } = fakeSdk(okScript);
	const engine = new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: { PATH: '/p' } });
	await engine.run(turn({ auth: 'own-login', route: claudeRoute }), recorder().cb);
	assert.equal(gateway.state.registered.length, 0);
	assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, undefined);
	const noGateway = new ClaudeEngine({ gateway: () => undefined, load: async () => sdk, env: {} });
	await assert.rejects(noGateway.run(turn(), recorder().cb), /gateway is not running/);
});

await test('run: a failing SDK is a reported error with the process stderr, and the session is still retired', async () => {
	const gateway = fakeGateway();
	const { sdk } = fakeSdk([], { throwAfter: new Error('Claude Code process exited with code 1') });
	const engine = new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: {} });
	const result = await engine.run(turn(), recorder().cb);
	assert.equal(result.reason, 'error');
	assert.match(result.detail, /exited with code 1/);
	assert.ok(result.failure instanceof Error);
	assert.equal(gateway.state.disposed, 1);
});

await test('run: a stream that ends without a result is an error, not a silent success', async () => {
	const { sdk } = fakeSdk([{ type: 'system', subtype: 'init', session_id: 'S' }]);
	const result = await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => sdk, env: {} }).run(turn(), recorder().cb);
	assert.equal(result.reason, 'error');
	assert.match(result.detail, /without a result/);
});

await test('run: Stop aborts the harness and surfaces an AbortError', async () => {
	const gateway = fakeGateway();
	const controller = new AbortController();
	let queryOptions;
	const sdk = {
		query(params) {
			queryOptions = params.options;
			return {
				close: () => { },
				interrupt: async () => { },
				async *[Symbol.asyncIterator]() {
					controller.abort();
					yield { type: 'system', subtype: 'init', session_id: 'S' };
				},
			};
		},
	};
	await assert.rejects(new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: {} }).run(turn({ signal: controller.signal }), recorder().cb), err => err.name === 'AbortError');
	assert.equal(queryOptions.abortController.signal.aborted, true, 'the SDK is told to stop too');
	assert.equal(gateway.state.disposed, 1);
});

await test('run: an already-aborted turn never starts a model request', async () => {
	const controller = new AbortController();
	controller.abort();
	const { sdk } = fakeSdk(okScript);
	await assert.rejects(new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => sdk, env: {} }).run(turn({ signal: controller.signal }), recorder().cb), err => err.name === 'AbortError');
});

// --- parity: sandbox, rewritten input, hook feedback, run limit ---------------------------------

await test('the OS sandbox setting becomes the harness sandbox, failing closed; off sets nothing', () => {
	assert.equal(sandboxSettings({ sandbox: 'off' }), undefined);
	assert.equal(sandboxSettings({}), undefined);
	const workspace = sandboxSettings({ sandbox: 'workspace', sandboxWritablePaths: ['/cache'] });
	assert.equal(workspace.enabled, true);
	assert.equal(workspace.failIfUnavailable, true, 'no silent fall back to running unprotected');
	assert.equal(workspace.allowUnsandboxedCommands, false);
	assert.deepEqual(workspace.filesystem, { allowWrite: ['/cache'] });
	assert.equal(workspace.network, undefined);
	const offline = sandboxSettings({ sandbox: 'workspace-offline' });
	assert.deepEqual(offline.network, { allowedDomains: [], strictAllowlist: true });
	assert.equal(offline.filesystem, undefined);

	const g = { ...loadGuardrails(), sandbox: 'workspace-offline' };
	assert.equal(options(turn({ guardrails: g })).settings.sandbox.enabled, true);
	assert.equal(options(turn()).settings.sandbox, undefined);
});

await test('the hook hands the harness a clamped timeout, and tells the bridge a call came from a sub-agent', async () => {
	const t = turn({ guardrails: { ...loadGuardrails(), approval: 'yolo', commandTimeoutMs: 15_000, maxSubagentDepth: 1 } });
	const pre = options(t).hooks.PreToolUse[0].hooks[0];
	const out = await pre({ tool_name: 'Bash', tool_input: { command: 'ls', timeout: 600_000 }, tool_use_id: 'x' });
	assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
	assert.deepEqual(out.hookSpecificOutput.updatedInput, { command: 'ls', timeout: 15_000 });
	assert.equal((await pre({ tool_name: 'Read', tool_input: { file_path: 'x.ts' }, tool_use_id: 'y' })).hookSpecificOutput.updatedInput, undefined);
	assert.equal((await pre({ tool_name: 'Agent', tool_input: {}, tool_use_id: 'a' })).hookSpecificOutput.permissionDecision, 'allow');
	const nested = await pre({ tool_name: 'Agent', tool_input: {}, tool_use_id: 'b', agent_id: 'sub-1' });
	assert.equal(nested.hookSpecificOutput.permissionDecision, 'deny');
});

await test('user PostToolUse hook feedback reaches the model, and hook warnings reach the user', async () => {
	const notes = [];
	const hook = script => `"${process.execPath}" -e "${script}"`;
	const g = {
		...loadGuardrails(), approval: 'yolo',
		hooks: [
			{ event: 'PostToolUse', command: hook("console.log('tests are red');process.exit(2)") },
			{ event: 'PreToolUse', command: hook('process.exit(9)') },
		],
	};
	const o = options(turn({ guardrails: g }), { note: t => notes.push(t) });
	await o.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'x.ts' }, tool_use_id: 'r' });
	assert.equal(notes.length, 1);
	assert.match(notes[0], /exited with code 9/);
	const post = await o.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Edit', tool_input: { file_path: 'x.ts' }, tool_response: 'ok', tool_use_id: 'e' }, 'e');
	assert.equal(post.hookSpecificOutput.hookEventName, 'PostToolUse');
	assert.match(post.hookSpecificOutput.additionalContext, /tests are red/);
	const failed = await o.hooks.PostToolUseFailure[0].hooks[0]({ tool_name: 'Edit', tool_input: {}, error: 'boom', tool_use_id: 'f' }, 'f');
	assert.equal(failed.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
});

await test('run: a turn that outlasts the wall-clock limit is stopped and reported as a limit, not an error', async () => {
	const gateway = fakeGateway();
	let interrupted = false;
	const sdk = {
		query(params) {
			return {
				close: () => { },
				interrupt: async () => { interrupted = true; },
				async *[Symbol.asyncIterator]() {
					yield { type: 'system', subtype: 'init', session_id: 'LIM' };
					await new Promise(resolve => params.options.abortController.signal.addEventListener('abort', resolve));
					throw new Error('Claude Code process aborted by user');
				},
			};
		},
	};
	const started = Date.now();
	const result = await new ClaudeEngine({ gateway: () => gateway, load: async () => sdk, env: {} }).run(turn({ maxRunMs: 60 }), recorder().cb);
	assert.equal(result.reason, 'limit');
	assert.match(result.detail, /stopped after \d+ minutes/);
	assert.equal(result.sessionId, 'LIM', 'the session can be continued');
	assert.ok(interrupted, 'the harness is asked to stop');
	assert.ok(Date.now() - started < 3000);
	assert.equal(gateway.state.disposed, 1);
});

await test('run: the user pressing Stop wins over the wall-clock limit', async () => {
	const controller = new AbortController();
	const sdk = {
		query(params) {
			return {
				close: () => { }, interrupt: async () => { },
				async *[Symbol.asyncIterator]() {
					setTimeout(() => controller.abort(), 20);
					await new Promise(resolve => params.options.abortController.signal.addEventListener('abort', resolve));
					yield { type: 'system', subtype: 'init', session_id: 'S' };
				},
			};
		},
	};
	await assert.rejects(new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => sdk, env: {} }).run(turn({ signal: controller.signal, maxRunMs: 5_000 }), recorder().cb), err => err.name === 'AbortError');
});

await test('run: a finished turn leaves no timer running', async () => {
	const { sdk } = fakeSdk(okScript);
	await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => sdk, env: {} }).run(turn({ maxRunMs: 3_600_000 }), recorder().cb);
	// An hour-long timer left behind would keep the process alive; the test exiting promptly is the proof.
});

await test('run: a harness that never produced anything is reported as not started; one that did is not', async () => {
	const dead = { query: () => ({ close: () => { }, interrupt: async () => { }, async *[Symbol.asyncIterator]() { throw new Error('spawn claude ENOENT'); } }) };
	const r1 = await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => dead, env: {} }).run(turn(), recorder().cb);
	assert.equal(r1.reason, 'error');
	assert.equal(r1.started, false, 'nothing came from it');
	const empty = fakeSdk([]);
	assert.equal((await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => empty.sdk, env: {} }).run(turn(), recorder().cb)).started, false, 'a stream that ends at once never started either');

	const dies = fakeSdk([{ type: 'system', subtype: 'init', session_id: 'S' }], { throwAfter: new Error('API Error: 401') });
	const r2 = await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => dies.sdk, env: {} }).run(turn(), recorder().cb);
	assert.equal(r2.reason, 'error');
	assert.equal(r2.started, true, 'it started; the model call failed afterwards');
	assert.equal((await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => fakeSdk(okScript).sdk, env: {} }).run(turn(), recorder().cb)).started, true);
});

await test('run: a callback that throws on one message does not end the run', async () => {
	const seen = [];
	const cb = { ...recorder().cb, onStepStart: () => { throw new Error('UI hiccup'); }, onToolStart: c => seen.push(c.name) };
	const script = [
		{ type: 'system', subtype: 'init', session_id: 'S' },
		{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }] } },
		{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: 'a' } }] } },
		{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'S' },
	];
	const result = await new ClaudeEngine({ gateway: () => fakeGateway(), load: async () => fakeSdk(script).sdk, env: {} }).run(turn(), cb);
	assert.equal(result.reason, 'done');
	assert.deepEqual(seen, ['read_file'], 'later messages were still handled');
});

// --- finding and loading the SDK -----------------------------------------------------------------

await test('SDK discovery order and version note', () => {
	const dirs = sdkCandidates({ sdkPath: '/custom', userDataDir: '/ud', appRoot: '/app' });
	assert.equal(dirs[0], '/custom');
	assert.ok(dirs.some(d => d === path.join('/ud', 'engines', 'claude', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')));
	assert.equal(dirs.at(-1), path.join('/app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
	assert.deepEqual(sdkCandidates({}), []);

	const files = {
		[path.join('/ud', 'engines', 'claude', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')]: JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: `${TESTED_SDK_SERIES}.319`, exports: { '.': { default: './sdk.mjs' } } }),
		[path.join('/app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')]: JSON.stringify({ name: 'something-else' }),
	};
	const read = f => files[f];
	const found = findSdk({ userDataDir: '/ud', appRoot: '/app' }, read);
	assert.equal(found.compat, 'ok');
	assert.equal(path.basename(found.entry), 'sdk.mjs');
	files[Object.keys(files)[0]] = JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '9.0.0', main: 'index.js' });
	assert.equal(findSdk({ userDataDir: '/ud' }, read).compat, 'untested');
	assert.equal(findSdk({ appRoot: '/app' }, read), undefined, 'a package with another name is not the SDK');
	assert.equal(findSdk({ sdkPath: '/nowhere' }, () => undefined), undefined);
	assert.match(sdkMissingMessage({ userDataDir: '/ud' }), /npm install --prefix ".*engines.claude" @anthropic-ai\/claude-agent-sdk/);
});

await test('loadClaudeSdk imports a real ES module through the compiled build, and rejects a non-SDK', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-'));
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: `${TESTED_SDK_SERIES}.1`, type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
	fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export function query() { return "q"; }\n');
	const loaded = await loadClaudeSdk({ sdkPath: dir });
	assert.equal(typeof loaded.sdk.query, 'function');
	assert.equal(loaded.sdk.query(), 'q');
	fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export const other = 1;\n');
	await assert.rejects(loadClaudeSdk({ sdkPath: dir }, url => import(`${url}?v=2`)), /does not export query/);
	await assert.rejects(loadClaudeSdk({ sdkPath: path.join(dir, 'missing') }), /needs the Claude Agent SDK/);
	fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`engine claude: ${passed} tests, all assertions passed`);
