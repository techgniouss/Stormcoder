/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/engine/gateway.ts and src/engine/anthropicWire.ts: the local Messages API
// server the Claude Code harness talks to. A fake Anthropic upstream and fake providers stand in
// for the network; nothing leaves the machine.
//   node scripts/build-tests.mjs && node scripts/test-engine-gateway.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import Module from 'node:module';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
	}
	return originalLoad(request, parent, isMain);
};

const { AnthropicGateway, UsageTap, MAX_BODY_BYTES } = await import(new URL('../out/engine/gateway.js', import.meta.url));
const wire = await import(new URL('../out/engine/anthropicWire.js', import.meta.url));
const { OPEN_MARK, CLOSE_MARK } = await import(new URL('../out/persona/thinking.js', import.meta.url));
const { resolveTarget, engineModelEnv, MAIN_ALIAS, FAST_ALIAS } = await import(new URL('../out/engine/modelMap.js', import.meta.url));
const { checkTarget, compactionEnv } = await import(new URL('../out/engine/capabilities.js', import.meta.url));

// --- fake Anthropic upstream ---------------------------------------------------------------------

/** Requests the fake upstream received: { path, headers, body (Buffer) }. */
const upstreamSeen = [];
/** What the fake upstream does with the next request; set per test. */
let upstreamBehavior = () => ({ status: 200, json: { id: 'msg_up', usage: { input_tokens: 1, output_tokens: 1 } } });
const upstream = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const record = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
		upstreamSeen.push(record);
		const behavior = upstreamBehavior(record, upstreamSeen.length);
		if (behavior.sse) {
			res.writeHead(behavior.status ?? 200, { 'content-type': 'text/event-stream', 'request-id': 'req_123', 'anthropic-ratelimit-requests-remaining': '41' });
			res.end(behavior.sse);
		} else {
			res.writeHead(behavior.status ?? 200, { 'content-type': 'application/json', ...(behavior.headers ?? {}) });
			res.end(JSON.stringify(behavior.json));
		}
	});
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

// --- fake registry and providers -----------------------------------------------------------------

const anthropicKeys = ['sk-ant-real-1', 'sk-ant-real-2'];
let activeKey = 0;
const cooldownLog = [];
const registry = {
	getProvider: id => providers[id],
	getBaseUrl: id => (id === 'anthropic' ? upstreamUrl : ''),
	getMaxTokens: () => 8192,
	getApiKey: async id => (id === 'anthropic' ? anthropicKeys[activeKey] : undefined),
	rotateApiKey: async () => { if (activeKey + 1 < anthropicKeys.length) { activeKey++; return true; } return false; },
	noteApiKeySuccess: () => { },
	getAccounts: async () => anthropicKeys.map((k, i) => ({ id: String(i) })),
	cooldowns: { markCooldown: (...a) => cooldownLog.push(a), clear: () => { } },
};

const baseInfo = { requiresApiKey: false, supportsTools: true, toolModelPatterns: [], visionModelPatterns: [], suggestedModels: [], apiKeyUrl: '' };
let lastAgentRequest;
let lastChatRequest;
/** What the fake tool-capable provider does; set per test. */
let agentBehavior = async () => ({ content: 'ok', toolCalls: [], finishReason: 'stop' });
const providers = {
	fake: {
		info: { ...baseInfo, id: 'fake', label: 'Fake' },
		streamChat: async request => { lastChatRequest = request; request.onToken('plain '); request.onToken('text'); return { truncated: false, finishReason: 'stop' }; },
		runAgentStep: async request => { lastAgentRequest = request; return agentBehavior(request); },
		listModels: async () => [],
	},
	notools: {
		info: { ...baseInfo, id: 'notools', label: 'No tools', supportsTools: false },
		streamChat: async () => ({ truncated: false }),
		listModels: async () => [],
	},
	tiny: {
		info: { ...baseInfo, id: 'tiny', label: 'Tiny' },
		streamChat: async () => ({ truncated: false }),
		runAgentStep: async () => ({ content: '', toolCalls: [] }),
		listModels: async () => [],
	},
};

const gateway = new AnthropicGateway({
	registry,
	catalog: id => (id === 'tiny' ? [{ id: 'tiny-model', contextLength: 40_000 }] : undefined),
	pingMs: 20,
});
await gateway.start();
const port = Number(new URL(gateway.baseUrl).port);

const usage = [];
const notices = [];
const route = {
	main: { providerId: 'fake', model: 'fake-big' },
	fast: { providerId: 'fake', model: 'fake-small' },
};
const session = gateway.registerSession({ id: 's1', route, onUsage: u => usage.push(u), onNotice: t => notices.push(t) });

/** One HTTP call to the gateway. `host` overrides the Host header; `token` the credential. */
function call(path, { method = 'POST', body, token = session.token, host, rawBody, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
		const req = http.request({
			host: '127.0.0.1', port, path, method,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(host ? { host } : {}),
				...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
				...headers,
			},
		}, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let json;
				try { json = JSON.parse(text); } catch { /* an event stream */ }
				resolve({ status: res.statusCode, headers: res.headers, text, json, raw: Buffer.concat(chunks) });
			});
		});
		req.on('error', reject);
		if (payload !== undefined) { req.write(payload); }
		req.end();
	});
}

/** Parses an SSE body into [{ event, data }]. */
function frames(text) {
	return text.split('\n\n').filter(Boolean).map(block => {
		const event = /^event: (.+)$/m.exec(block)?.[1];
		const data = /^data: (.+)$/m.exec(block)?.[1];
		return { event, data: data ? JSON.parse(data) : undefined };
	});
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

// --- auth and routing ----------------------------------------------------------------------------

await test('rejects a missing token', async () => {
	const r = await call('/v1/messages', { token: '', body: { model: 'x', messages: [] } });
	assert.equal(r.status, 401);
	assert.equal(r.json.type, 'error');
	assert.equal(r.json.error.type, 'authentication_error');
});

await test('rejects a wrong token', async () => {
	assert.equal((await call('/v1/messages', { token: 'sk-stormcoder-nope', body: { model: 'x', messages: [] } })).status, 401);
});

await test('accepts the token as x-api-key too', async () => {
	const r = await call('/v1/models', { method: 'GET', token: '', headers: { 'x-api-key': session.token } });
	assert.equal(r.status, 200);
});

await test('rejects a foreign Host header (DNS rebinding)', async () => {
	assert.equal((await call('/v1/models', { method: 'GET', host: 'evil.example:80' })).status, 403);
	assert.equal((await call('/v1/models', { method: 'GET', host: `localhost:${port}` })).status, 200);
});

await test('unknown endpoints are 404 and sends no CORS headers', async () => {
	const r = await call('/v1/nope', { method: 'GET' });
	assert.equal(r.status, 404);
	assert.equal(r.headers['access-control-allow-origin'], undefined);
});

await test('lists the aliases the engine may use', async () => {
	const r = await call('/v1/models', { method: 'GET' });
	assert.deepEqual(r.json.data.map(m => m.id).sort(), [FAST_ALIAS, MAIN_ALIAS].sort());
});

await test('an unmapped model is a loud 404, never a guess', async () => {
	const r = await call('/v1/messages', { body: { model: 'gpt-9000', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
	assert.equal(r.status, 404);
	assert.match(r.json.error.message, /not mapped/);
});

await test('malformed JSON and missing fields are 400', async () => {
	assert.equal((await call('/v1/messages', { rawBody: '{nope' })).status, 400);
	assert.equal((await call('/v1/messages', { body: { model: MAIN_ALIAS } })).status, 400);
});

await test('an oversized body is 413', async () => {
	assert.ok(MAX_BODY_BYTES > 1024 * 1024);
	const small = new AnthropicGateway({ registry, maxBodyBytes: 1024 });
	await small.start();
	const s = small.registerSession({ id: 'big', route });
	const p = Number(new URL(small.baseUrl).port);
	const status = await new Promise((resolve, reject) => {
		const body = JSON.stringify({ model: MAIN_ALIAS, messages: [], pad: 'x'.repeat(5000) });
		const req = http.request({ host: '127.0.0.1', port: p, path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
		req.on('error', reject);
		req.end(body);
	});
	assert.equal(status, 413);
	await small.stop();
});

// --- pass-through (Anthropic upstream): the cost-parity guarantees --------------------------------

const claudeRoute = { main: { providerId: 'anthropic', model: 'claude-sonnet-x' }, fast: { providerId: 'anthropic', model: 'claude-haiku-x' } };
const claudeSession = gateway.registerSession({ id: 'c1', route: claudeRoute, onUsage: u => usage.push(u) });

const streamBody = [
	'event: message_start',
	`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 1 } } })}`,
	'',
	'event: content_block_delta',
	`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}`,
	'',
	'event: message_delta',
	`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 77 } })}`,
	'',
	'',
].join('\n');

await test('pass-through forwards the body byte for byte (cache_control, thinking, hosted tools, unknown fields)', async () => {
	upstreamSeen.length = 0;
	upstreamBehavior = () => ({ status: 200, sse: streamBody });
	// Odd spacing and key order on purpose: a re-serialization would change these bytes.
	const exact = '{"model":"claude-sonnet-x",  "max_tokens":512,"stream":true,"system":[{"type":"text","text":"You are Claude Code","cache_control":{"type":"ephemeral"}}],"thinking":{"type":"enabled","budget_tokens":2048},"tools":[{"type":"web_search_20250305","name":"web_search"}],"future_field":{"a":1},"messages":[{"role":"user","content":"hi"}]}';
	const r = await call('/v1/messages?beta=true', { token: claudeSession.token, rawBody: exact, headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05', 'user-agent': 'claude-cli/9' } });
	assert.equal(r.status, 200);
	assert.equal(upstreamSeen.length, 1);
	assert.equal(upstreamSeen[0].body.toString('utf8'), exact, 'forwarded body must be byte-identical');
	assert.equal(upstreamSeen[0].path, '/v1/messages?beta=true', 'query string is kept');
	assert.equal(upstreamSeen[0].headers['x-api-key'], 'sk-ant-real-1');
	assert.ok(!JSON.stringify(upstreamSeen[0].headers).includes(claudeSession.token), 'the session token must never reach Anthropic');
	assert.match(upstreamSeen[0].headers['anthropic-beta'], /interleaved-thinking-2025-05-14/);
	assert.match(upstreamSeen[0].headers['anthropic-beta'], /prompt-caching-scope-2026-01-05/);
	assert.equal(upstreamSeen[0].headers['user-agent'], 'claude-cli/9');
	assert.equal(r.text, streamBody, 'the response is relayed unchanged');
	assert.equal(r.headers['request-id'], 'req_123');
	assert.equal(r.headers['anthropic-ratelimit-requests-remaining'], '41');
});

await test('pass-through reports real usage, cache tokens included', async () => {
	const u = usage.find(x => x.sessionId === 'c1' && x.path === 'passthrough');
	assert.ok(u);
	assert.equal(u.inputTokens, 1200);
	assert.equal(u.cacheReadTokens, 9000);
	assert.equal(u.cacheWriteTokens, 300);
	assert.equal(u.outputTokens, 77);
	assert.equal(u.estimated, false);
});

await test('pass-through rewrites only the model name when an alias must become the real id', async () => {
	upstreamSeen.length = 0;
	upstreamBehavior = () => ({ status: 200, json: { id: 'm', usage: { input_tokens: 5, output_tokens: 6 } } });
	const original = { model: 'claude-haiku-4-5-20251001', max_tokens: 9, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'x' }] };
	const r = await call('/v1/messages', { token: claudeSession.token, body: original });
	assert.equal(r.status, 200);
	const sent = JSON.parse(upstreamSeen[0].body.toString('utf8'));
	assert.equal(sent.model, 'claude-haiku-x', 'a haiku-family name maps to the fast model');
	assert.deepEqual({ ...sent, model: undefined }, { ...original, model: undefined }, 'everything else is untouched');
});

await test('pass-through rotates to the next key on 429 before any byte reaches the engine', async () => {
	upstreamSeen.length = 0;
	activeKey = 0;
	cooldownLog.length = 0;
	upstreamBehavior = (rec, n) => (n === 1 ? { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } } : { status: 200, json: { id: 'ok', usage: { input_tokens: 1, output_tokens: 1 } } });
	const r = await call('/v1/messages', { token: claudeSession.token, body: { model: 'claude-sonnet-x', max_tokens: 9, messages: [{ role: 'user', content: 'x' }] } });
	assert.equal(r.status, 200);
	assert.deepEqual(upstreamSeen.map(s => s.headers['x-api-key']), ['sk-ant-real-1', 'sk-ant-real-2']);
	activeKey = 0;
});

await test('pass-through hands a final 429 back with its headers when no key is left', async () => {
	upstreamSeen.length = 0;
	activeKey = 1; // the last key
	upstreamBehavior = () => ({ status: 429, headers: { 'retry-after': '7' }, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });
	const r = await call('/v1/messages', { token: claudeSession.token, body: { model: 'claude-sonnet-x', max_tokens: 9, messages: [{ role: 'user', content: 'x' }] } });
	assert.equal(r.status, 429);
	assert.equal(r.headers['retry-after'], '7');
	activeKey = 0;
});

await test('pass-through count_tokens goes to the real endpoint', async () => {
	upstreamSeen.length = 0;
	upstreamBehavior = () => ({ status: 200, json: { input_tokens: 4321 } });
	const r = await call('/v1/messages/count_tokens', { token: claudeSession.token, body: { model: 'claude-sonnet-x', messages: [{ role: 'user', content: 'x' }] } });
	assert.equal(r.json.input_tokens, 4321);
	assert.equal(upstreamSeen[0].path, '/v1/messages/count_tokens');
});

await test('a client that disconnects mid-stream aborts the upstream request', async () => {
	let upstreamClosed = false;
	const slow = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('event: ping\ndata: {"type":"ping"}\n\n');
		res.on('close', () => { upstreamClosed = true; });
	});
	await new Promise(r => slow.listen(0, '127.0.0.1', r));
	const g = new AnthropicGateway({ registry: { ...registry, getBaseUrl: () => `http://127.0.0.1:${slow.address().port}/v1` } });
	await g.start();
	const s = g.registerSession({ id: 'a', route: claudeRoute });
	await new Promise(resolve => {
		const body = JSON.stringify({ model: 'claude-sonnet-x', stream: true, messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, res => {
			res.once('data', () => { req.destroy(); resolve(); });
		});
		req.on('error', () => { });
		req.end(body);
	});
	for (let i = 0; i < 50 && !upstreamClosed; i++) { await new Promise(r => setTimeout(r, 20)); }
	assert.ok(upstreamClosed, 'the upstream connection must be torn down');
	await g.stop();
	slow.close();
});

// --- translated path -----------------------------------------------------------------------------

const readFileTool = { name: 'Read', description: 'Reads a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };

await test('translated: Anthropic messages become provider messages, tools and tool results', async () => {
	agentBehavior = async () => ({ content: 'Let me look.', toolCalls: [{ id: 'toolu_2', name: 'Read', args: { file_path: 'b.ts' } }], finishReason: 'tool_calls' });
	const r = await call('/v1/messages', {
		body: {
			model: MAIN_ALIAS, max_tokens: 4096, stream: false,
			system: [{ type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Be brief.' }],
			tools: [readFileTool, { type: 'web_search_20250305', name: 'web_search' }],
			thinking: { type: 'enabled', budget_tokens: 1000 },
			messages: [
				{ role: 'user', content: 'read a.ts' },
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'const a = 1;' }] }, { type: 'text', text: 'now b.ts' }] },
			],
		},
	});
	assert.equal(r.status, 200);
	const m = lastAgentRequest.messages;
	assert.deepEqual(m.map(x => x.role), ['system', 'user', 'assistant', 'tool', 'user']);
	assert.equal(m[0].content, 'You are an agent.\nBe brief.');
	assert.deepEqual(m[2].toolCalls, [{ id: 'toolu_1', name: 'Read', args: { file_path: 'a.ts' } }]);
	assert.equal(m[2].content, 'Reading.', 'signed thinking is not replayed to a non-Claude model');
	assert.equal(m[3].toolCallId, 'toolu_1');
	assert.equal(m[3].content, 'const a = 1;');
	assert.equal(m[4].content, 'now b.ts');
	assert.deepEqual(lastAgentRequest.tools.map(t => t.name), ['Read'], 'the hosted web_search tool is dropped');
	assert.equal(lastAgentRequest.model, 'fake-big', 'the alias is replaced by the real model');
	assert.equal(lastAgentRequest.apiKey, '', 'a provider with no saved key is called with an empty one');
	assert.equal(r.json.type, 'message');
	assert.equal(r.json.stop_reason, 'tool_use');
	assert.deepEqual(r.json.content, [
		{ type: 'text', text: 'Let me look.' },
		{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'b.ts' } },
	]);
	assert.ok(notices.some(n => /hosted tool "web_search"/.test(n)), 'the user is told a tool was left out');
});

await test('translated: a dropped item is reported once per session, not on every request', async () => {
	notices.length = 0;
	const once = gateway.registerSession({ id: 'dedupe', route, onNotice: t => notices.push(t) });
	agentBehavior = async () => ({ content: 'x', toolCalls: [], finishReason: 'stop' });
	const body = { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool, { type: 'code_execution_20250522', name: 'code_execution' }], messages: [{ role: 'user', content: 'go' }] };
	await call('/v1/messages', { token: once.token, body });
	await call('/v1/messages', { token: once.token, body });
	await call('/v1/messages', { token: once.token, body: { ...body, tools: [readFileTool, { type: 'web_search_20250305', name: 'web_search' }] } });
	assert.equal(notices.length, 2, `one notice per distinct item, got: ${notices.join(' | ')}`);
	assert.match(notices[0], /code_execution/);
	assert.match(notices[1], /web_search/);
});

await test('translated: streams text, then tool calls, in the Messages event order', async () => {
	agentBehavior = async request => {
		request.onToken('Hel');
		request.onToken('lo');
		return { content: 'Hello', toolCalls: [{ id: 'toolu_9', name: 'Read', args: { file_path: 'x' } }], finishReason: 'tool_calls' };
	};
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: true, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(r.status, 200);
	assert.match(r.headers['content-type'], /text\/event-stream/);
	const f = frames(r.text);
	assert.deepEqual(f.map(x => x.event), [
		'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
		'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
	]);
	assert.equal(f[1].data.content_block.type, 'text');
	assert.equal(f[2].data.delta.text, 'Hel');
	assert.equal(f[5].data.content_block.type, 'tool_use');
	assert.equal(f[5].data.index, 1);
	assert.deepEqual(JSON.parse(f[6].data.delta.partial_json), { file_path: 'x' });
	assert.equal(f[8].data.delta.stop_reason, 'tool_use');
	assert.equal(f[0].data.message.model, MAIN_ALIAS, 'the engine sees the model name it asked for');
});

await test('translated: a tool-only reply still opens the stream correctly', async () => {
	agentBehavior = async () => ({ content: '', toolCalls: [{ id: 't', name: 'Read', args: {} }], finishReason: 'tool_calls' });
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: true, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.deepEqual(frames(r.text).map(x => x.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

await test('translated: calls with unparseable arguments become an empty input the harness reports back', async () => {
	agentBehavior = async () => ({ content: '', toolCalls: [{ id: 't', name: 'Read', args: { __malformedArgs: '{oops' } }], finishReason: 'tool_calls' });
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.deepEqual(r.json.content[0].input, {});
});

await test('translated: no tools means a plain chat stream', async () => {
	const r = await call('/v1/messages', { body: { model: FAST_ALIAS, stream: false, max_tokens: 50, messages: [{ role: 'user', content: 'title this' }] } });
	assert.equal(r.json.content[0].text, 'plain text');
	assert.equal(lastChatRequest.model, 'fake-small', 'the fast alias reaches the fast model');
});

await test('translated: max_tokens is capped by the app setting', async () => {
	agentBehavior = async () => ({ content: 'x', toolCalls: [], finishReason: 'stop' });
	await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 64000, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(lastAgentRequest.maxTokens, 8192);
});

await test('translated: finish reasons map to stop reasons', async () => {
	for (const [finish, expected] of [['length', 'max_tokens'], ['refused', 'refusal'], ['stop', 'end_turn']]) {
		agentBehavior = async () => ({ content: 'x', toolCalls: [], finishReason: finish });
		const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
		assert.equal(r.json.stop_reason, expected);
	}
	agentBehavior = async () => ({ content: 'x', toolCalls: [], truncated: true });
	const cut = await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(cut.json.stop_reason, 'max_tokens');
});

await test('translated: provider failures keep a status the engine can retry on', async () => {
	agentBehavior = async () => { throw new Error('rate limited (HTTP 429)'); };
	const limited = await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(limited.status, 429);
	assert.equal(limited.json.error.type, 'rate_limit_error');
	agentBehavior = async () => { throw new Error('upstream exploded (HTTP 502)'); };
	const bad = await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(bad.status, 503);
});

await test('translated: an error after streaming started is an SSE error event', async () => {
	agentBehavior = async request => { request.onToken('partial'); throw new Error('stream died (HTTP 500)'); };
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: true, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	const f = frames(r.text);
	assert.equal(f.at(-1).event, 'error');
	assert.equal(f.at(-1).data.type, 'error');
});

await test('translated: a model without tool calling is refused with a reason', async () => {
	const r = gateway.registerSession({ id: 'n', route: { main: { providerId: 'notools', model: 'm' }, fast: { providerId: 'notools', model: 'm' } } });
	const res = await call('/v1/messages', { token: r.token, body: { model: MAIN_ALIAS, max_tokens: 100, messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(res.status, 400);
	assert.match(res.json.error.message, /does not support tool calling/);
});

await test('translated: a prompt larger than the real window gets the error the harness recovers from', async () => {
	const r = gateway.registerSession({ id: 't', route: { main: { providerId: 'tiny', model: 'tiny-model' }, fast: { providerId: 'tiny', model: 'tiny-model' } } });
	const res = await call('/v1/messages', { token: r.token, body: { model: MAIN_ALIAS, max_tokens: 100, messages: [{ role: 'user', content: 'x'.repeat(200_000) }] } });
	assert.equal(res.status, 400);
	assert.match(res.json.error.message, /^prompt is too long: \d+ tokens > 40000 maximum$/);
});

await test('translated: count_tokens is answered locally with an estimate', async () => {
	const r = await call('/v1/messages/count_tokens', { body: { model: MAIN_ALIAS, messages: [{ role: 'user', content: 'x'.repeat(4000) }] } });
	assert.equal(r.status, 200);
	assert.ok(r.json.input_tokens > 500 && r.json.input_tokens < 2000);
});

await test('translated: usage is reported and flagged as estimated', async () => {
	usage.length = 0;
	agentBehavior = async () => ({ content: 'done', toolCalls: [], finishReason: 'stop' });
	await call('/v1/messages', { body: { model: MAIN_ALIAS, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.equal(usage.length, 1);
	assert.equal(usage[0].path, 'translated');
	assert.equal(usage[0].estimated, true);
	assert.ok(usage[0].inputTokens > 0 && usage[0].outputTokens > 0);
});

await test('translated: a client disconnect aborts the provider call', async () => {
	let aborted = false;
	agentBehavior = request => new Promise((_, reject) => {
		request.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
	});
	await new Promise(resolve => {
		const body = JSON.stringify({ model: MAIN_ALIAS, stream: true, max_tokens: 10, tools: [readFileTool], messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-length': Buffer.byteLength(body) } });
		req.on('error', () => { });
		req.end(body);
		setTimeout(() => { req.destroy(); resolve(); }, 80);
	});
	for (let i = 0; i < 50 && !aborted; i++) { await new Promise(r => setTimeout(r, 20)); }
	assert.ok(aborted);
});

await test('translated: a slow model gets its stream opened early, so the harness does not retry (and bill) the request', async () => {
	let finished = false;
	const slowProvider = {
		info: { ...baseInfo, id: 'slow', label: 'Slow' },
		streamChat: async () => ({ truncated: false }),
		runAgentStep: async () => { await new Promise(r => setTimeout(r, 400)); finished = true; return { content: 'late', toolCalls: [], finishReason: 'stop' }; },
		listModels: async () => [],
	};
	providers.slow = slowProvider;
	const g = new AnthropicGateway({ registry, earlyStartMs: 40, pingMs: 30 });
	await g.start();
	const s = g.registerSession({ id: 'slow', route: { main: { providerId: 'slow', model: 'm' }, fast: { providerId: 'slow', model: 'm' } } });
	const timeline = await new Promise((resolve, reject) => {
		const body = JSON.stringify({ model: MAIN_ALIAS, stream: true, max_tokens: 50, tools: [readFileTool], messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, res => {
			const headersBeforeModelDone = !finished;
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ headersBeforeModelDone, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end(body);
	});
	assert.equal(timeline.status, 200);
	assert.equal(timeline.headersBeforeModelDone, true, 'response headers arrived while the model was still working');
	const events = frames(timeline.text).map(f => f.event);
	assert.equal(events[0], 'message_start');
	assert.ok(events.includes('ping'), 'keep-alive frames while it waits');
	assert.equal(events.at(-1), 'message_stop');
	await g.stop();
	delete providers.slow;
});

await test('translated: a failure inside the grace period is still a real HTTP status, so key rotation and retry logic work', async () => {
	providers.flaky = {
		info: { ...baseInfo, id: 'flaky', label: 'Flaky' },
		streamChat: async () => ({ truncated: false }),
		runAgentStep: async () => { throw new Error('authentication failed (HTTP 401)'); },
		listModels: async () => [],
	};
	const g = new AnthropicGateway({ registry, earlyStartMs: 5_000 });
	await g.start();
	const s = g.registerSession({ id: 'f', route: { main: { providerId: 'flaky', model: 'm' }, fast: { providerId: 'flaky', model: 'm' } } });
	const res = await new Promise((resolve, reject) => {
		const body = JSON.stringify({ model: MAIN_ALIAS, stream: true, max_tokens: 50, tools: [readFileTool], messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, r => {
			const chunks = [];
			r.on('data', c => chunks.push(c));
			r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
		});
		req.on('error', reject);
		req.end(body);
	});
	assert.equal(res.status, 401);
	assert.equal(res.body.error.type, 'authentication_error');
	await g.stop();
	delete providers.flaky;
});

await test('reasoning a provider streams inline never reaches the harness, even with marks split across chunks', async () => {
	agentBehavior = async request => {
		const wholeStream = `${OPEN_MARK}step by step: the secret reasoning${CLOSE_MARK}The answer is 42.`;
		for (let i = 0; i < wholeStream.length; i += 3) { request.onToken(wholeStream.slice(i, i + 3)); }
		return { content: wholeStream, toolCalls: [], finishReason: 'stop' };
	};
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: true, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	const text = frames(r.text).filter(f => f.event === 'content_block_delta').map(f => f.data.delta.text).join('');
	assert.equal(text, 'The answer is 42.');
	assert.ok(!r.text.includes('secret reasoning') && !r.text.includes('Thinking'));
	const plain = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: false, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	assert.deepEqual(plain.json.content, [{ type: 'text', text: 'The answer is 42.' }]);
});

await test('an answer a provider returns without streaming any of it is still delivered', async () => {
	agentBehavior = async () => ({ content: `${OPEN_MARK}thinking${CLOSE_MARK}Delivered whole.`, toolCalls: [], finishReason: 'stop' });
	const r = await call('/v1/messages', { body: { model: MAIN_ALIAS, stream: true, max_tokens: 100, tools: [readFileTool], messages: [{ role: 'user', content: 'go' }] } });
	const f = frames(r.text);
	assert.equal(f.filter(x => x.event === 'content_block_delta').map(x => x.data.delta.text).join(''), 'Delivered whole.');
	assert.equal(f.at(-1).event, 'message_stop');
	assert.ok(!r.text.includes('thinking'));
});

await test('a rotated key that turns out to be the same one keeps the real error, with a body', async () => {
	upstreamSeen.length = 0;
	upstreamBehavior = () => ({ status: 429, headers: { 'retry-after': '3' }, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });
	const stuck = { ...registry, rotateApiKey: async () => true, getApiKey: async id => (id === 'anthropic' ? 'sk-ant-only' : undefined) };
	const g = new AnthropicGateway({ registry: stuck });
	await g.start();
	const s = g.registerSession({ id: 'stuck', route: claudeRoute });
	const res = await new Promise((resolve, reject) => {
		const body = JSON.stringify({ model: 'claude-sonnet-x', max_tokens: 9, messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, r => {
			const chunks = [];
			r.on('data', c => chunks.push(c));
			r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end(body);
	});
	assert.equal(res.status, 429);
	assert.equal(res.headers['retry-after'], '3');
	assert.equal(JSON.parse(res.text).error.message, 'slow down', 'the harness gets the provider\'s own explanation');
	assert.equal(upstreamSeen.length, 1, 'the same key is not tried twice');
	await g.stop();
});

await test('an oversized chunked upload is answered with a 413, not a dropped connection', async () => {
	const small = new AnthropicGateway({ registry, maxBodyBytes: 1024 });
	await small.start();
	const s = small.registerSession({ id: 'chunked', route });
	const out = await new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(small.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'transfer-encoding': 'chunked' } }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		for (let i = 0; i < 6; i++) { req.write('x'.repeat(500)); }
		req.end();
	});
	assert.equal(out.status, 413);
	assert.equal(out.connection, 'close');
	assert.equal(JSON.parse(out.body).error.type, 'request_too_large');
	await small.stop();
});

await test('ThinkingFilter: every split point, an unclosed block, and text that merely looks like a mark', () => {
	const whole = `Before. ${OPEN_MARK}hidden${CLOSE_MARK}After.`;
	for (let cut = 0; cut <= whole.length; cut++) {
		const f = new wire.ThinkingFilter();
		const out = f.push(whole.slice(0, cut)) + f.push(whole.slice(cut)) + f.flush();
		assert.equal(out, 'Before. After.', `cut at ${cut}`);
	}
	const unclosed = new wire.ThinkingFilter();
	assert.equal(unclosed.push(`Hi ${OPEN_MARK}reasoning that never ends`) + unclosed.flush(), 'Hi ', 'a block that never closes is all reasoning');
	const lookalike = new wire.ThinkingFilter();
	assert.equal(lookalike.push('a\n\n--') + lookalike.push('-b') + lookalike.flush(), 'a\n\n---b', 'a rule outside reasoning is ordinary text');
	const partial = new wire.ThinkingFilter();
	assert.equal(partial.push('ends with 🤔 *Thi') + partial.flush(), 'ends with 🤔 *Thi', 'a held partial mark is released if the stream ends');
	const two = new wire.ThinkingFilter();
	assert.equal(two.push(`${OPEN_MARK}a${CLOSE_MARK}x${OPEN_MARK}b${CLOSE_MARK}y`), 'xy');
});

await test('a disposed session stops working', async () => {
	const s = gateway.registerSession({ id: 'gone', route });
	assert.equal((await call('/v1/models', { method: 'GET', token: s.token })).status, 200);
	s.dispose();
	assert.equal((await call('/v1/models', { method: 'GET', token: s.token })).status, 401);
});

// --- wire helpers and policy ---------------------------------------------------------------------

await test('toInternal drops URL images and notes why; keeps inline ones for a vision model', () => {
	const req = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'see' }] }] };
	const withImages = wire.toInternal(req, { allowImages: true });
	assert.equal(withImages.messages[0].images.length, 1);
	assert.ok(withImages.dropped.some(d => /URL/.test(d)));
	const without = wire.toInternal(req, { allowImages: false });
	assert.equal(without.messages[0].images, undefined);
	assert.ok(without.dropped.some(d => /does not accept images/.test(d)));
});

await test('toInternal marks a failed tool result and keeps its images', () => {
	const req = { model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] }] };
	assert.equal(wire.toInternal(req, { allowImages: true }).messages[0].content, 'Error: boom');
});

await test('statusForFailure and stopReasonFor', () => {
	assert.equal(wire.statusForFailure('authentication failed (HTTP 401)'), 401);
	assert.equal(wire.statusForFailure('fetch failed'), 503);
	assert.equal(wire.statusForFailure('something odd'), 500);
	assert.equal(wire.stopReasonFor('stop', true), 'tool_use');
	assert.equal(wire.stopReasonFor(undefined, false), 'end_turn');
	assert.equal(wire.errorTypeFor(529), 'overloaded_error');
});

await test('model resolution: exact, family, bracket suffix and refusal', () => {
	assert.equal(resolveTarget(MAIN_ALIAS, route).target, route.main);
	assert.equal(resolveTarget(MAIN_ALIAS, route).rewrite, true);
	assert.equal(resolveTarget('fake-big', route).rewrite, false);
	assert.equal(resolveTarget('claude-opus-4-8[1m]', route).target, route.main);
	assert.equal(resolveTarget('claude-3-5-haiku-latest', route).target, route.fast);
	assert.equal(resolveTarget('gpt-4o', route), undefined);
});

await test('engineModelEnv gives Anthropic targets their real ids and others an alias', () => {
	const env = engineModelEnv(claudeRoute);
	assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-x');
	assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-haiku-x');
	const other = engineModelEnv(route);
	assert.equal(other.ANTHROPIC_MODEL, MAIN_ALIAS);
	assert.equal(other.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST_ALIAS);
	assert.equal(other.CLAUDE_CODE_SUBAGENT_MODEL, MAIN_ALIAS);
	const mixed = engineModelEnv({ main: claudeRoute.main, fast: route.fast });
	assert.equal(mixed.ANTHROPIC_MODEL, 'claude-sonnet-x');
	assert.equal(mixed.ANTHROPIC_SMALL_FAST_MODEL, FAST_ALIAS);
});

await test('checkTarget and compactionEnv', () => {
	assert.equal(checkTarget({ providerId: 'anthropic', model: 'claude-x' }, providers.fake, undefined).warnings.length, 0, 'no warnings for Claude on Anthropic');
	const small = checkTarget({ providerId: 'tiny', model: 'tiny-model' }, providers.tiny, [{ id: 'tiny-model', contextLength: 16_000 }]);
	assert.equal(small.ok, false);
	const mid = checkTarget({ providerId: 'tiny', model: 'tiny-model' }, providers.tiny, [{ id: 'tiny-model', contextLength: 64_000 }]);
	assert.equal(mid.ok, true);
	assert.ok(mid.warnings.some(w => /small context window/.test(w)));
	assert.ok(mid.warnings.some(w => /translation layer/.test(w)));
	assert.equal(checkTarget({ providerId: 'x', model: 'm' }, undefined, undefined).ok, false);
	assert.deepEqual(compactionEnv({ providerId: 'anthropic', model: 'c' }, 200_000), {});
	assert.deepEqual(compactionEnv({ providerId: 'fake', model: 'm' }, 128_000), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '128000' });
});

await test('UsageTap reads split streaming frames and a JSON body', () => {
	const tap = new UsageTap(true);
	const bytes = new TextEncoder().encode(streamBody);
	tap.push(bytes.slice(0, 50));
	tap.push(bytes.slice(50, 200));
	tap.push(bytes.slice(200));
	assert.deepEqual(tap.result(), { input: 1200, output: 77, cacheRead: 9000, cacheWrite: 300 });
	const json = new UsageTap(false);
	json.push(new TextEncoder().encode(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 } })));
	assert.deepEqual(json.result(), { input: 3, output: 4, cacheRead: 5, cacheWrite: 0 });
	const broken = new UsageTap(false);
	broken.push(new TextEncoder().encode('not json'));
	assert.deepEqual(broken.result(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

await test('UsageTap drops an enormous line without a newline instead of buffering it forever', () => {
	const tap = new UsageTap(true);
	tap.push(new TextEncoder().encode('data: ' + 'x'.repeat(2 * 1024 * 1024)));
	tap.push(new TextEncoder().encode('\n' + streamBody));
	assert.equal(tap.result().output, 77, 'it recovers and reads the next frames');
});

await test('a client that stops reading and then leaves does not strand the upstream or the gateway', async () => {
	let upstreamClosed = false;
	const flood = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunk = 'data: ' + 'y'.repeat(60_000) + '\n\n';
		const timer = setInterval(() => { if (!res.destroyed) { res.write(chunk); } }, 1);
		res.on('close', () => { upstreamClosed = true; clearInterval(timer); });
	});
	await new Promise(r => flood.listen(0, '127.0.0.1', r));
	const g = new AnthropicGateway({ registry: { ...registry, getBaseUrl: () => `http://127.0.0.1:${flood.address().port}/v1` } });
	await g.start();
	const s = g.registerSession({ id: 'bp', route: claudeRoute });
	await new Promise(resolve => {
		const body = JSON.stringify({ model: 'claude-sonnet-x', stream: true, messages: [{ role: 'user', content: 'x' }] });
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-length': Buffer.byteLength(body) } }, res => {
			res.pause(); // never reads: the gateway's write buffer fills and it must wait for a drain
			setTimeout(() => { req.destroy(); resolve(); }, 300);
		});
		req.on('error', () => { });
		req.end(body);
	});
	for (let i = 0; i < 100 && !upstreamClosed; i++) { await new Promise(r => setTimeout(r, 20)); }
	assert.ok(upstreamClosed, 'the upstream stream is torn down once the client is gone');
	const other = await new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: Number(new URL(g.baseUrl).port), path: '/v1/models', method: 'GET', headers: { authorization: `Bearer ${s.token}` } }, r => { r.resume(); resolve(r.statusCode); });
		req.on('error', reject);
		req.end();
	});
	assert.equal(other, 200, 'and the gateway still serves other requests');
	await g.stop();
	flood.close();
});

await test('stopping closes the server', async () => {
	await gateway.stop();
	assert.equal(gateway.listening, false);
	await assert.rejects(call('/v1/models', { method: 'GET' }));
});

upstream.close();
console.log(`engine gateway: ${passed} tests, all assertions passed`);
