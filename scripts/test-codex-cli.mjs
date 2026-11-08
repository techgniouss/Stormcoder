/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/providers/codexCli.ts: a read-only reviewer that runs `codex exec`. The
// child process is a stand-in; no CLI is ever started.
//   node scripts/build-tests.mjs && node scripts/test-codex-cli.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import Module from 'node:module';

const settings = {};
const workspace = { folders: [{ uri: { fsPath: '/work/project' } }], trusted: true };
let lastSpawn;
let spawnImpl = () => { throw new Error('spawnImpl not configured'); };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			workspace: {
				getConfiguration: () => ({ get: key => settings[key] }),
				get workspaceFolders() { return workspace.folders; },
				get isTrusted() { return workspace.trusted; },
			},
		};
	}
	if (request === 'child_process') {
		return { spawn: (binary, args, opts) => { lastSpawn = { binary, args, opts }; return spawnImpl(binary, args, opts); } };
	}
	return originalLoad(request, parent, isMain);
};

const { CodexCliProvider, CODEX_DEFAULT_MODEL } = await import(new URL('../out/providers/codexCli.js', import.meta.url));
const { allowlistedEnv } = await import(new URL('../out/providers/childEnv.js', import.meta.url));

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = Object.assign(new EventEmitter(), { setEncoding() { } });
		this.stderr = Object.assign(new EventEmitter(), { setEncoding() { } });
		this.killSignals = [];
		this.stdinText = '';
		this.stdin = Object.assign(new EventEmitter(), { end: text => { this.stdinText += text ?? ''; } });
	}
	kill(signal) { this.killSignals.push(signal); return true; }
}

const event = e => JSON.stringify(e) + '\n';
const answer = text => event({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });

function request(overrides = {}) {
	const chunks = [];
	return {
		messages: [{ role: 'system', content: 'Review this change.' }, { role: 'user', content: 'Diff: +1 -1' }],
		model: CODEX_DEFAULT_MODEL, apiKey: '', baseUrl: '', maxTokens: 1000,
		signal: new AbortController().signal, onToken: d => chunks.push(d), chunks, ...overrides,
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
	} finally {
		delete settings['codex-cli.cliPath'];
		workspace.trusted = true;
		workspace.folders = [{ uri: { fsPath: '/work/project' } }];
	}
}

await test('it is a text-only provider that the agent loop can never use', () => {
	const info = new CodexCliProvider().info;
	assert.equal(info.id, 'codex-cli');
	assert.equal(info.supportsTools, false);
	assert.equal(info.requiresApiKey, false);
	assert.equal(new CodexCliProvider().runAgentStep, undefined);
});

await test('it always runs read-only, non-interactively, in the project folder, with the prompt on stdin', async () => {
	const child = new FakeChild();
	spawnImpl = () => child;
	const r = request();
	const promise = new CodexCliProvider().streamChat(r);
	child.stdout.emit('data', answer('Looks fine.') + event({ type: 'turn.completed', usage: {} }));
	child.emit('close', 0, null);
	assert.deepEqual(await promise, { truncated: false });
	assert.equal(lastSpawn.binary, 'codex');
	assert.deepEqual(lastSpawn.args, ['exec', '--experimental-json', '--sandbox', 'read-only', '--skip-git-repo-check']);
	assert.equal(lastSpawn.opts.cwd, '/work/project');
	assert.match(child.stdinText, /read-only sandbox/);
	assert.match(child.stdinText, /System instructions:\nReview this change\./);
	assert.match(child.stdinText, /Diff: \+1 -1/);
	assert.equal(r.chunks.join(''), 'Looks fine.');
});

await test('no setting or model name can widen the sandbox', async () => {
	for (const model of ['gpt-5-codex', 'o3', 'vendor/model:tag']) {
		const child = new FakeChild();
		spawnImpl = () => child;
		const p = new CodexCliProvider().streamChat(request({ model }));
		child.stdout.emit('data', answer('ok'));
		child.emit('close', 0, null);
		await p;
		assert.deepEqual(lastSpawn.args.slice(0, 5), ['exec', '--experimental-json', '--sandbox', 'read-only', '--skip-git-repo-check']);
		assert.deepEqual(lastSpawn.args.slice(5), ['--model', model]);
		assert.ok(!lastSpawn.args.some(a => /danger|workspace-write|bypass|full-auto|yolo/i.test(a)));
	}
	for (const bad of ['x; rm -rf /', 'a b', '$(id)', '`id`', 'm"', 'a&b', '--sandbox danger-full-access']) {
		await assert.rejects(new CodexCliProvider().streamChat(request({ model: bad })), /not a valid model name/, bad);
	}
});

await test('the process gets an allow-listed environment: no provider key, but its own config folder', async () => {
	const saved = { ...process.env };
	Object.assign(process.env, { OPENAI_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'sk-ant', GITHUB_TOKEN: 'ghp', CODEX_HOME: '/home/u/.codex', CODEX_API_KEY: 'codex-key' });
	try {
		const child = new FakeChild();
		spawnImpl = () => child;
		const p = new CodexCliProvider().streamChat(request());
		child.stdout.emit('data', answer('ok'));
		child.emit('close', 0, null);
		await p;
		const env = lastSpawn.opts.env;
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.GITHUB_TOKEN, undefined);
		assert.equal(env.CODEX_HOME, '/home/u/.codex');
		assert.equal(env.CODEX_API_KEY, 'codex-key');
		assert.ok(env.PATH);
	} finally {
		for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME', 'CODEX_API_KEY']) { delete process.env[k]; }
		Object.assign(process.env, saved);
	}
	// Matching is case-insensitive: lowercase proxy variables are the norm on Linux and must survive.
	assert.deepEqual(allowlistedEnv({ PATH: '/p', SECRET: 'x', http_proxy: 'p', HTTPS_PROXY: 'q' }), { PATH: '/p', http_proxy: 'p', HTTPS_PROXY: 'q' });
	assert.deepEqual(allowlistedEnv({ PATH: '/p', MY_TOOL_HOME: 'h' }, ['my_tool_home']), { PATH: '/p', MY_TOOL_HOME: 'h' });
});

await test('in a folder the user has not trusted it runs in an empty temporary folder, which is removed afterwards', async () => {
	workspace.trusted = false;
	const child = new FakeChild();
	spawnImpl = () => child;
	const p = new CodexCliProvider().streamChat(request());
	const folder = lastSpawn.opts.cwd;
	assert.notEqual(folder, '/work/project');
	assert.ok(fs.existsSync(folder), 'the temporary folder exists while it runs');
	assert.deepEqual(fs.readdirSync(folder), []);
	child.stdout.emit('data', answer('ok'));
	child.emit('close', 0, null);
	await p;
	assert.ok(!fs.existsSync(folder), 'and is gone after');
	workspace.trusted = true;
	workspace.folders = [];
	const child2 = new FakeChild();
	spawnImpl = () => child2;
	const p2 = new CodexCliProvider().streamChat(request());
	assert.notEqual(lastSpawn.opts.cwd, undefined, 'no folder open also gets a temporary one');
	child2.stdout.emit('data', answer('ok'));
	child2.emit('close', 0, null);
	await p2;
});

await test('events split across chunks are reassembled; several answers are joined; other lines are ignored', async () => {
	const child = new FakeChild();
	spawnImpl = () => child;
	const r = request();
	const p = new CodexCliProvider().streamChat(r);
	const first = answer('Part one.');
	child.stdout.emit('data', 'warning: not json\n' + event({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }) + first.slice(0, 20));
	child.stdout.emit('data', first.slice(20) + event({ type: 'item.completed', item: { type: 'reasoning', text: 'private thoughts' } }) + answer('Part two.'));
	child.emit('close', 0, null);
	await p;
	assert.equal(r.chunks.join(''), 'Part one.\n\nPart two.');
	assert.ok(!r.chunks.join('').includes('private thoughts'));
});

await test('a final line without a newline is still read', async () => {
	const child = new FakeChild();
	spawnImpl = () => child;
	const r = request();
	const p = new CodexCliProvider().streamChat(r);
	child.stdout.emit('data', answer('Done.').trimEnd());
	child.emit('close', 0, null);
	await p;
	assert.equal(r.chunks.join(''), 'Done.');
});

await test('failures: exit code with stderr, a failed turn, no answer, and the sign-in hint', async () => {
	let child = new FakeChild();
	spawnImpl = () => child;
	let p = new CodexCliProvider().streamChat(request());
	child.stderr.emit('data', 'boom: sandbox error');
	child.emit('close', 3, null);
	await assert.rejects(p, /exited with code 3: boom: sandbox error\./);

	child = new FakeChild();
	p = new CodexCliProvider().streamChat(request());
	child.stdout.emit('data', event({ type: 'turn.failed', error: { message: 'You are not logged in' } }));
	child.emit('close', 1, null);
	await assert.rejects(p, err => /not logged in/.test(err.message) && /codex login/.test(err.message));

	child = new FakeChild();
	p = new CodexCliProvider().streamChat(request());
	child.stdout.emit('data', event({ type: 'turn.completed', usage: {} }));
	child.emit('close', 0, null);
	await assert.rejects(p, /returned no answer/);

	child = new FakeChild();
	p = new CodexCliProvider().streamChat(request());
	child.stdout.emit('data', event({ type: 'error', message: 'rate limited' }));
	child.emit('close', 0, null);
	await assert.rejects(p, /returned no answer: rate limited/);
});

await test('a missing binary names the install step and the setting', async () => {
	settings['codex-cli.cliPath'] = '/opt/codex';
	const child = new FakeChild();
	spawnImpl = () => child;
	const p = new CodexCliProvider().streamChat(request());
	assert.equal(lastSpawn.binary, '/opt/codex');
	const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
	child.emit('error', enoent);
	await assert.rejects(p, err => /was not found/.test(err.message) && /stormcoder\.codex-cli\.cliPath/.test(err.message));
});

await test('Stop kills the process politely, then hard, and reports an abort', async () => {
	const child = new FakeChild();
	spawnImpl = () => child;
	const controller = new AbortController();
	const p = new CodexCliProvider().streamChat(request({ signal: controller.signal }));
	controller.abort();
	assert.deepEqual(child.killSignals, ['SIGTERM']);
	child.emit('close', null, 'SIGTERM');
	await assert.rejects(p, err => err.name === 'AbortError');

	const pre = new AbortController();
	pre.abort();
	await assert.rejects(new CodexCliProvider().streamChat(request({ signal: pre.signal })), err => err.name === 'AbortError');
});

await test('the model list is just the CLI default', async () => {
	assert.deepEqual(await new CodexCliProvider().listModels(), [{ id: 'default' }]);
});

console.log(`codex cli: ${passed} tests, all assertions passed`);
