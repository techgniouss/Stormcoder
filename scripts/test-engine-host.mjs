/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/engine/engineHost.ts: which engine is selected (once, at start), how a chat's
// model choice becomes a route, the history seed, and the gateway's lifecycle.
//   node scripts/build-tests.mjs && node scripts/test-engine-host.mjs
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

/** Settings the stub serves; tests change these between calls. */
const settings = {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			Uri: { file: p => ({ fsPath: p }) },
			workspace: { getConfiguration: () => ({ get: key => settings[key] }), workspaceFolders: [], isTrusted: true },
			window: {}, commands: {}, env: {}, ConfigurationTarget: { Global: 1 }, EventEmitter: class { }, Disposable: class { },
		};
	}
	return originalLoad(request, parent, isMain);
};

const host = await import(new URL('../out/engine/engineHost.js', import.meta.url));
const { EngineHost, buildTranscriptSeed, engineSelectedAtStart, parseTarget, readEngineSetting } = host;

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

await test('the engine setting: only the exact value selects Claude Code; anything else is the built-in engine', () => {
	for (const [value, expected] of [[undefined, 'builtin'], ['', 'builtin'], ['builtin', 'builtin'], ['claude-code', 'claude-code'], ['Claude-Code', 'builtin'], ['codex', 'builtin'], [42, 'builtin']]) {
		settings.engine = value;
		assert.equal(readEngineSetting(), expected, String(value));
	}
});

await test('the engine is fixed at the value it had at start, even if the setting changes later', () => {
	settings.engine = 'builtin';
	assert.equal(engineSelectedAtStart(), 'builtin');
	settings.engine = 'claude-code';
	assert.equal(readEngineSetting(), 'claude-code', 'the live setting changed');
	assert.equal(engineSelectedAtStart(), 'builtin', 'the selected engine did not');
	const h = new EngineHost(options());
	assert.equal(h.id, 'builtin');
	assert.equal(h.enabled, false);
});

await test('parseTarget', () => {
	assert.deepEqual(parseTarget('openai:gpt-4o-mini'), { providerId: 'openai', model: 'gpt-4o-mini' });
	assert.deepEqual(parseTarget(' openrouter : meta/llama-3.3-70b:free '), { providerId: 'openrouter', model: 'meta/llama-3.3-70b:free' });
	for (const bad of [undefined, '', 'gpt-4o', ':model', 'openai:', '   ']) {
		assert.equal(parseTarget(bad), undefined, String(bad));
	}
});

await test('buildTranscriptSeed: oldest first, clipped, bounded, no system or tool noise', () => {
	assert.equal(buildTranscriptSeed([]), '');
	const history = [
		{ role: 'system', content: 'You are Stormcoder' },
		{ role: 'user', content: 'first question' },
		{ role: 'assistant', content: 'first answer' },
		{ role: 'tool', content: 'tool output' },
		{ role: 'user', content: '   ' },
		{ role: 'user', content: 'x'.repeat(2000) },
	];
	const seed = buildTranscriptSeed(history);
	const lines = seed.split('\n');
	assert.equal(lines[0], 'User: first question');
	assert.equal(lines[1], 'Assistant: first answer');
	assert.equal(lines[2], `User: ${'x'.repeat(600)}…`);
	assert.equal(lines.length, 3);
	const long = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i} `.repeat(30) }));
	const bounded = buildTranscriptSeed(long, 2000, 300);
	assert.ok(bounded.length <= 2000 + 400, 'stays near its budget');
	assert.ok(bounded.includes('message number 49'), 'keeps the most recent messages');
	assert.ok(!bounded.includes('message number 0 '), 'drops the oldest first');
});

// --- routes --------------------------------------------------------------------------------------

const info = { requiresApiKey: false, supportsTools: true, toolModelPatterns: [], visionModelPatterns: [], suggestedModels: [], apiKeyUrl: '' };
const providers = {
	openai: { info: { ...info, id: 'openai', label: 'OpenAI' }, runAgentStep: async () => ({}), streamChat: async () => ({}) },
	groq: { info: { ...info, id: 'groq', label: 'Groq' }, runAgentStep: async () => ({}), streamChat: async () => ({}) },
	plain: { info: { ...info, id: 'plain', label: 'Plain', supportsTools: false }, streamChat: async () => ({}) },
	anthropic: { info: { ...info, id: 'anthropic', label: 'Anthropic' }, runAgentStep: async () => ({}), streamChat: async () => ({}) },
};
const catalogs = { groq: [{ id: 'small-model', contextLength: 8_000 }] };
function options() {
	return {
		context: { globalStorageUri: { fsPath: path.join('/data', 'globalStorage', 'stormcoder') }, extensionPath: '/app' },
		registry: { getProvider: id => providers[id] },
		catalog: id => catalogs[id],
		log: () => { },
	};
}

await test('resolveRoute: the fast model defaults to the main model', () => {
	delete settings['engine.fastModel'];
	const r = new EngineHost(options()).resolveRoute({ providerId: 'openai', model: 'gpt-4o' });
	assert.equal(r.problems.length, 0);
	assert.equal(r.route.main, r.route.fast);
	assert.equal(r.contextWindow, 128_000);
	assert.ok(r.warnings.some(w => /translation layer/.test(w)));
});

await test('resolveRoute: a configured fast model is used, and a bad one is reported as the fast model', () => {
	settings['engine.fastModel'] = 'openai:gpt-4o-mini';
	const ok = new EngineHost(options()).resolveRoute({ providerId: 'anthropic', model: 'claude-sonnet-x' });
	assert.deepEqual(ok.route.fast, { providerId: 'openai', model: 'gpt-4o-mini' });
	assert.deepEqual(ok.route.main, { providerId: 'anthropic', model: 'claude-sonnet-x' });
	assert.equal(ok.warnings.length, 0, 'Claude on the Anthropic API carries no caveats');

	settings['engine.fastModel'] = 'plain:tiny';
	const bad = new EngineHost(options()).resolveRoute({ providerId: 'openai', model: 'gpt-4o' });
	assert.equal(bad.route, undefined);
	assert.match(bad.problems[0], /^Fast model: .*tool calling/);

	settings['engine.fastModel'] = 'not a target';
	assert.ok(new EngineHost(options()).resolveRoute({ providerId: 'openai', model: 'gpt-4o' }).route, 'an unparseable fast model falls back to the main model');
	delete settings['engine.fastModel'];
});

await test('resolveRoute: a main model that cannot run the harness is refused with the reason', () => {
	const h = new EngineHost(options());
	const noTools = h.resolveRoute({ providerId: 'plain', model: 'm' });
	assert.equal(noTools.route, undefined);
	assert.match(noTools.problems.join(' '), /does not support tool calling/);
	const small = h.resolveRoute({ providerId: 'groq', model: 'small-model' });
	assert.equal(small.route, undefined);
	assert.match(small.problems.join(' '), /8,000-token context window/);
	assert.equal(h.resolveRoute({ providerId: 'ghost', model: 'm' }).route, undefined);
});

await test('sdkLocation reads the setting and derives the data and app folders', () => {
	settings['engine.claudeCode.sdkPath'] = '/my/sdk';
	const loc = new EngineHost(options()).sdkLocation();
	assert.equal(loc.sdkPath, '/my/sdk');
	assert.equal(loc.userDataDir, path.join('/data', 'globalStorage'));
	assert.equal(loc.appRoot, '/app');
});

await test('the gateway starts once, on demand, and stops on dispose', async () => {
	const h = new EngineHost({ ...options(), registry: { getProvider: id => providers[id] } });
	const [a, b] = await Promise.all([h.ensureStarted(), h.ensureStarted()]);
	assert.equal(a, b, 'concurrent callers share one gateway');
	assert.equal(a.listening, true);
	assert.match(a.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.equal(await h.ensureStarted(), a);
	await h.dispose();
	assert.equal(a.listening, false);
	const again = await h.ensureStarted();
	assert.notEqual(again, a, 'a new gateway after a stop');
	await h.dispose();
});

await test('preflight: ok when the SDK is on disk and the gateway can start, otherwise a one-line reason and nothing changed', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
	const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	fs.mkdirSync(pkg, { recursive: true });
	try {
		settings['engine.claudeCode.sdkPath'] = dir;
		const h = new EngineHost(options());
		const missing = await h.preflight();
		assert.equal(missing.ok, false);
		assert.match(missing.reason, /needs the Claude Agent SDK/);
		assert.ok(!missing.reason.includes('\n'), 'a single line, safe to show in a chat note');
		assert.equal(h.gatewayRunning, false, 'a failed preflight starts nothing');

		fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.1', type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
		fs.writeFileSync(path.join(pkg, 'sdk.mjs'), 'export function query() {}\n');
		assert.deepEqual(await h.preflight(), { ok: true });
		assert.equal(h.gatewayRunning, true);
		await h.dispose();

		settings['engine.claudeCode.auth'] = 'own-login';
		assert.deepEqual(await h.preflight(), { ok: true });
		assert.equal(h.gatewayRunning, false, 'the engine\'s own login needs no gateway');

		// A different install (ES modules are cached by path, so a rewritten file would not be re-read).
		const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pf2-'));
		try {
			const pkg2 = path.join(other, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
			fs.mkdirSync(pkg2, { recursive: true });
			fs.writeFileSync(path.join(pkg2, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.1', type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
			fs.writeFileSync(path.join(pkg2, 'sdk.mjs'), 'export const nothing = 1;\n');
			settings['engine.claudeCode.sdkPath'] = other;
			const broken = await new EngineHost(options()).preflight();
			assert.equal(broken.ok, false);
			assert.match(broken.reason, /does not export query/);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	} finally {
		delete settings['engine.claudeCode.sdkPath'];
		delete settings['engine.claudeCode.auth'];
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await test('settings that a hand edit made nonsense are treated as unset', () => {
	settings['engine.claudeCode.sdkPath'] = 42;
	assert.equal(new EngineHost(options()).sdkLocation().sdkPath, '');
	settings['engine.claudeCode.sdkPath'] = { path: '/x' };
	assert.equal(new EngineHost(options()).sdkLocation().sdkPath, '');
	delete settings['engine.claudeCode.sdkPath'];
});

console.log(`engine host: ${passed} tests, all assertions passed`);
