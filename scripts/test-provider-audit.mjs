/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Regression tests for the provider / OAuth audit: token-store single-flight, sign-in callback
// state handling, truncated tool-call arguments, Kiro's response path, reasoning-block closing,
// Antigravity history, ChatGPT routing and rate-limit retry budgets. Run:
//   node scripts/build-tests.mjs && node scripts/test-provider-audit.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import Module from 'node:module';

let openExternal = async () => true;
const vscodeStub = {
	env: { openExternal: url => openExternal(url) },
	Uri: { parse: s => s },
	ProgressLocation: { Notification: 15 },
	window: { withProgress: (_o, task) => task({}, { onCancellationRequested: () => ({ dispose() { } }) }) },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const out = p => import(new URL(`../out/${p}`, import.meta.url));
const oauth = await out('oauth.js');
const toolCalls = await out('providers/toolCalls.js');
const types = await out('providers/types.js');
const { KiroProvider } = await out('providers/kiro.js');
const { OpenAIProvider, usesChatGptBackend } = await out('providers/openai.js');
const { toContents } = await out('providers/antigravity.js');
const { OPEN_MARK, CLOSE_MARK } = await out('persona/thinking.js');

const realFetch = globalThis.fetch;
const sseResponse = chunks => new Response(new ReadableStream({
	start(c) {
		for (const chunk of chunks) {
			c.enqueue(new TextEncoder().encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`));
		}
		c.close();
	},
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

// 1. Token store: concurrent refreshes share one request; a dead-looking refresh does not wipe a rotated session.
{
	const data = new Map();
	const secrets = { get: async k => data.get(k), store: async (k, v) => { data.set(k, v); }, delete: async k => { data.delete(k); } };
	const store = new oauth.OAuthTokenStore(secrets);
	await store.set('anthropic', { type: 'anthropic', access: 'old', refresh: 'r1', expires: 0 });
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		await new Promise(r => setTimeout(r, 20));
		return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
	};
	const tokens = await Promise.all([store.getFreshAccessToken('anthropic'), store.getFreshAccessToken('anthropic'), store.getFreshAccessToken('anthropic')]);
	assert.deepEqual(tokens, ['new', 'new', 'new']);
	assert.equal(calls, 1, 'one refresh for concurrent callers');
	assert.equal((await store.get('anthropic')).refresh, 'r2');

	// A rejected refresh whose token was rotated meanwhile keeps the session.
	await store.set('anthropic', { type: 'anthropic', access: 'old', refresh: 'r2', expires: 0 });
	globalThis.fetch = async () => {
		await store.set('anthropic', { type: 'anthropic', access: 'winner', refresh: 'r3', expires: Date.now() + 3_600_000 });
		return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
	};
	assert.equal(await store.getFreshAccessToken('anthropic'), 'winner');
	assert.equal((await store.get('anthropic')).refresh, 'r3', 'winner session survives');

	// invalid_grant with an unchanged token clears; a bare 400 is a transient error that keeps the session.
	await store.set('anthropic', { type: 'anthropic', access: 'a', refresh: 'r9', expires: 0 });
	globalThis.fetch = async () => new Response(JSON.stringify({ error: 'server_busy' }), { status: 400 });
	await assert.rejects(store.getFreshAccessToken('anthropic'), /Could not refresh/);
	assert.ok(await store.get('anthropic'), 'bare 400 does not clear');
	globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
	await assert.rejects(store.getFreshAccessToken('anthropic'), /expired/);
	assert.equal(await store.get('anthropic'), undefined);
	assert.equal(oauth.isRefreshRejected(401, {}), true);
	assert.equal(oauth.isRefreshRejected(400, {}), false);
}

// 2. Callback server ignores a request with the wrong state and still accepts the real one.
{
	process.env.ANTIGRAVITY_CLIENT_SECRET = 'x';
	const data = new Map();
	const store = new oauth.OAuthTokenStore({ get: async k => data.get(k), store: async (k, v) => { data.set(k, v); }, delete: async k => { data.delete(k); } });
	const get = url => new Promise((resolve, reject) => http.get(url, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
	const statuses = [];
	openExternal = async authorizeUrl => {
		const state = new URL(authorizeUrl).searchParams.get('state');
		const base = 'http://127.0.0.1:51121/oauth-callback';
		setTimeout(async () => {
			statuses.push(await get(`${base}?code=evil&state=wrong`));
			statuses.push(await get(`${base}?code=evil`));
			statuses.push(await get(`${base}?code=good&state=${state}`));
		}, 50);
		return true;
	};
	let exchangedCode;
	globalThis.fetch = async (_url, init) => {
		exchangedCode = new URLSearchParams(init.body).get('code');
		return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 });
	};
	assert.equal(await oauth.signInAntigravity(store), true);
	await new Promise(r => setTimeout(r, 100));
	assert.deepEqual(statuses, [400, 400, 200]);
	assert.equal(exchangedCode, 'good');
}

// 3. Truncated steps never get their cut-off arguments completed.
{
	const cut = '{"path":"a.ts","content":"half of a fi';
	assert.ok(toolCalls.parseToolArgs(cut)['path'], 'untruncated: still recovered');
	assert.equal(toolCalls.parseToolArgs(cut, true)[toolCalls.MALFORMED_ARGS], cut);
	assert.deepEqual(toolCalls.parseToolArgs('{"a":1}', true), { a: 1 });
}

// 4. Kiro: a plain-text event-stream body and a JSON body both come through.
{
	const kiro = new KiroProvider();
	const apiKey = JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 3_600_000 });
	for (const [body, expected] of [
		['\u0000\u0001{"content":"Hello "}\u0002{"content":"world"}', 'Hello world'],
		[JSON.stringify({ completion: 'json answer' }), 'json answer'],
	]) {
		globalThis.fetch = async () => new Response(body, { status: 200 });
		let text = '';
		const result = await kiro.streamChat({
			messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey, baseUrl: '', maxTokens: 10,
			signal: new AbortController().signal, onToken: t => { text += t; },
		});
		assert.equal(text, expected);
		assert.equal(result.truncated, false);
	}
}

// 5. Reasoning followed by tool calls still closes the thinking block; truncated args are not repaired.
{
	const provider = new OpenAIProvider();
	const run = async chunks => {
		globalThis.fetch = async () => sseResponse(chunks);
		const tokens = [];
		const step = await provider.runAgentStep({
			messages: [{ role: 'user', content: 'go' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
			model: 'gpt-4o', apiKey: 'sk-plain', baseUrl: 'https://x.test/v1', maxTokens: 10,
			signal: new AbortController().signal, onToken: t => tokens.push(t),
		});
		return { tokens, step };
	};
	const call = (args, finish) => [
		{ choices: [{ delta: { reasoning_content: 'thinking' } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: args } }] } }] },
		{ choices: [{ delta: {}, finish_reason: finish }] },
		'[DONE]',
	];
	const ok = await run(call('{"a":1}', 'tool_calls'));
	assert.deepEqual(ok.tokens, [OPEN_MARK, 'thinking', CLOSE_MARK]);
	assert.deepEqual(ok.step.toolCalls[0].args, { a: 1 });
	const cut = await run(call('{"a":"unfini', 'length'));
	assert.equal(cut.step.truncated, true);
	assert.ok(cut.step.toolCalls[0].args[toolCalls.MALFORMED_ARGS] !== undefined, 'not repaired');
}

// 6. Antigravity: each step's tool results are named after that step's calls, not the last step's.
{
	const contents = toContents([
		{ role: 'user', content: 'go' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read_file', args: {} }] },
		{ role: 'tool', toolCallId: 'call_0', content: 'one' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'run_command', args: {} }] },
		{ role: 'tool', toolCallId: 'call_0', content: 'two' },
	]);
	const names = contents.flatMap(c => c.parts.filter(p => p.functionResponse).map(p => p.functionResponse.name));
	assert.deepEqual(names, ['read_file', 'run_command']);
}

// 7. A JWT-shaped key on a custom base URL is that endpoint's key, not a ChatGPT token.
{
	const jwt = 'eyJhbGciOi.payload.sig';
	assert.equal(usesChatGptBackend(jwt, 'https://api.openai.com/v1'), true);
	assert.equal(usesChatGptBackend(jwt, ''), true);
	assert.equal(usesChatGptBackend(jwt, 'https://gateway.example.com/v1'), false);
	assert.equal(usesChatGptBackend('sk-abc', 'https://api.openai.com/v1'), false);
}

// 8. Pooled keys give up on 429 quickly so rotation can happen; Retry-After: 0 still waits a little.
{
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response('', { status: 429, headers: { 'retry-after': '0' } });
	};
	types.notePooledKeys(['pool-key-1', 'pool-key-2']);
	const delays = [];
	const res = await types.apiFetch('https://x.test/a', { headers: { Authorization: 'Bearer pool-key-1' } }, new AbortController().signal, { onRetry: i => delays.push(i.delayMs) });
	assert.equal(res.status, 429);
	assert.equal(calls, 2, 'one retry only for a pooled key');
	assert.ok(delays[0] >= 500, 'Retry-After: 0 is floored');
}

globalThis.fetch = realFetch;
console.log('All provider-audit assertions passed.');
