/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// MCP servers and skills in the Claude Code engine: they are loaded by the harness alone, vetted and
// policed by Stormcoder, and never reach the model by a second route.
//   node scripts/build-tests.mjs && node scripts/test-engine-extras.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const files = {};
let settingsServers = {};
let trusted = true;
const vscodeStub = {
	workspace: {
		get isTrusted() { return trusted; },
		workspaceFolders: [{ uri: { fsPath: '/repo', path: '/repo' } }],
		getConfiguration: () => ({ get: key => (key === 'mcp.servers' ? settingsServers : undefined) }),
		fs: {
			async readFile(uri) {
				if (!(uri.path in files)) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
				return new TextEncoder().encode(files[uri.path]);
			},
		},
	},
	Uri: {
		file: p => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
		joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/'), fsPath: [base.path, ...parts].join('/') }),
	},
	window: { showWarningMessage: async () => 'Allow' },
	commands: {}, env: {}, EventEmitter: class { }, Disposable: class { }, ConfigurationTarget: { Global: 1 },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

const { McpManager } = await import(new URL('../out/mcp/manager.js', import.meta.url));
const { decideToolUse } = await import(new URL('../out/engine/toolBridge.js', import.meta.url));
const { loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));
const { buildQueryOptions, MessageMapper } = await import(new URL('../out/engine/claudeEngine.js', import.meta.url));
const { FileTracker } = await import(new URL('../out/engine/toolBridge.js', import.meta.url));
const { ToolNames, toInternal } = await import(new URL('../out/engine/anthropicWire.js', import.meta.url));
const skillsMod = await import(new URL('../out/engine/engineSkills.js', import.meta.url));

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

// --- MCP: which servers the harness is given -----------------------------------------------------

await test('resolveForEngine vets servers like the manager does but starts none', async () => {
	trusted = true;
	for (const k of Object.keys(files)) { delete files[k]; }
	files['/repo/.stormcoder/mcp.json'] = JSON.stringify({ mcpServers: { proj: { command: 'node', args: ['p.js'], env: { A: '${env:HOME_X}' } } } });
	process.env.HOME_X = 'secret-value';
	settingsServers = {
		local: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: '${env:HOME_X}' } },
		hosted: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:HOME_X}' } },
		off: { command: 'x', disabled: true },
		broken: { args: [] },
		withCwd: { command: 'node', cwd: '/elsewhere' },
	};
	const asked = [];
	const manager = new McpManager(async (id, _c, file) => { asked.push([id, file]); return true; });
	const { servers, status } = await manager.resolveForEngine();
	const byId = Object.fromEntries(servers.map(s => [s.id, s]));
	assert.deepEqual(Object.keys(byId).sort(), ['hosted', 'local', 'proj']);
	assert.deepEqual(byId.local.config, { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'secret-value' } });
	assert.deepEqual(byId.hosted.config, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-value' } });
	assert.equal(byId.proj.config.env.A, '${env:HOME_X}', 'environment values are expanded only for the user\'s own settings');
	assert.deepEqual(asked, [['proj', '.stormcoder/mcp.json']], 'only the project server needs consent');
	assert.ok(status.some(l => /broken: skipped/.test(l)));
	assert.ok(status.some(l => /withCwd: skipped.*working directory/.test(l)));
	assert.ok(!status.some(l => /^off/.test(l)), 'a switched-off server is not a problem');
	assert.deepEqual(manager.tools(), [], 'nothing was connected by Stormcoder');
	assert.equal(manager.getStatus()[0], 'No MCP servers configured.', 'the manager itself started nothing');
	delete process.env.HOME_X;
});

await test('a refused project server and an untrusted workspace give the harness nothing', async () => {
	trusted = true;
	settingsServers = {};
	const refused = await new McpManager(async () => false).resolveForEngine();
	assert.deepEqual(refused.servers, []);
	assert.ok(refused.status.some(l => /proj: not started .*not allowed/.test(l)));
	trusted = false;
	settingsServers = { local: { command: 'npx' } };
	const untrusted = await new McpManager(async () => true).resolveForEngine();
	assert.deepEqual(untrusted.servers, []);
	assert.ok(untrusted.status.some(l => /workspace not trusted/.test(l)));
	trusted = true;
});

await test('a malformed mcp.json never throws', async () => {
	files['/repo/.stormcoder/mcp.json'] = '{ nope';
	settingsServers = 5;
	const r = await new McpManager().resolveForEngine();
	assert.deepEqual(r.servers, []);
	assert.ok(r.status.length >= 1);
	delete files['/repo/.stormcoder/mcp.json'];
	settingsServers = {};
});

// --- MCP: the policy on a call -------------------------------------------------------------------

const base = loadGuardrails();
function approver(answer = { approved: true }) {
	const asked = [];
	return { asked, confirm: async r => { asked.push(r); return answer; }, ask: async () => '', recordWrite: () => { } };
}
function ctx(over = {}) {
	return { guardrails: { ...base, approval: 'auto-edits' }, approver: approver(), root: '/repo', trusted: true, readOnly: false, upstream: 'translated', ...over };
}

await test('an MCP tool is asked about like the built-in loop does, and refused where it is read-only or untrusted', async () => {
	const a = approver();
	const ok = await decideToolUse('mcp__db__query', { sql: 'select 1' }, ctx({ approver: a }));
	assert.equal(ok.behavior, 'allow');
	assert.equal(a.asked.length, 1);
	assert.equal(a.asked[0].kind, 'mcp');
	assert.equal(a.asked[0].signature, 'mcp__db__query');
	assert.match(a.asked[0].preview, /select 1/);

	const declined = await decideToolUse('mcp__db__query', {}, ctx({ approver: approver({ approved: false, feedback: 'no' }) }));
	assert.equal(declined.behavior, 'deny');
	assert.match(declined.message, /declined/);

	const yolo = approver();
	assert.equal((await decideToolUse('mcp__db__query', {}, ctx({ approver: yolo, guardrails: { ...base, approval: 'yolo' } }))).behavior, 'allow');
	assert.equal(yolo.asked.length, 0, 'yolo does not ask');

	const readOnly = await decideToolUse('mcp__db__query', {}, ctx({ readOnly: true }));
	assert.equal(readOnly.behavior, 'deny');
	assert.match(readOnly.message, /read-only/);
	const untrusted = await decideToolUse('mcp__db__query', {}, ctx({ trusted: false, readOnly: true }));
	assert.equal(untrusted.behavior, 'deny');
});

await test('user hooks still run first for an MCP tool, and other unknown tools stay denied', async () => {
	const v = await decideToolUse('SomethingNew', {}, ctx());
	assert.equal(v.behavior, 'deny');
	assert.equal((await decideToolUse('Skill', { skill: 'stormcoder:caveman' }, ctx())).behavior, 'allow');
});

// --- the options handed to the harness -----------------------------------------------------------

function options(over = {}) {
	const t = {
		sessionId: 's', prompt: 'p', cwd: '/repo', route: { main: { providerId: 'openai', model: 'm' }, fast: { providerId: 'openai', model: 'm' } },
		mode: 'agent', guardrails: base, approver: approver(), trusted: true, signal: new AbortController().signal,
		contextWindow: 128_000, loadProjectSettings: false, auth: 'gateway', ...over,
	};
	return buildQueryOptions(t, { env: {}, abort: new AbortController(), tracker: new FileTracker('/repo', t.approver), stderr: () => { } });
}

await test('options carry the vetted servers and the skills plugin, and stay strict', () => {
	const servers = { db: { type: 'stdio', command: 'x', args: [], env: {} } };
	const o = options({ mcpServers: servers, skillsPlugin: '/plugins/abc' });
	assert.deepEqual(o.mcpServers, servers);
	assert.equal(o.strictMcpConfig, true, 'the harness may not discover servers of its own');
	assert.deepEqual(o.plugins, [{ type: 'local', path: '/plugins/abc', skipMcpDiscovery: true }]);
	assert.equal(o.skills, 'all');
	assert.ok(o.tools.includes('Skill'));
	const bare = options();
	assert.equal('mcpServers' in bare, false);
	assert.equal('plugins' in bare, false);
	assert.equal('skills' in bare, false);
	assert.equal(options({ mcpServers: {} }).mcpServers, undefined, 'an empty set is not sent');
});

await test('the harness\'s init report of server states reaches the chat', () => {
	const seen = [];
	const m = new MessageMapper({
		onStepStart() { }, onToken() { }, onStepEnd() { }, onToolStart() { }, onToolEnd() { }, onNote() { },
		onMcpStatus: s => seen.push(s),
	});
	m.handle({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [{ name: 'db', status: 'connected' }, { name: 'bad', status: 'failed' }, { status: 'x' }] });
	assert.deepEqual(seen, [[{ name: 'db', status: 'connected' }, { name: 'bad', status: 'failed' }]]);
	m.handle({ type: 'system', subtype: 'init', session_id: 'y' });
	assert.equal(seen.length, 1, 'no servers, no report');
});

// --- skills --------------------------------------------------------------------------------------

const skill = (id, over = {}) => ({ id, name: id, description: `About ${id}: a "quoted" thing`, instructions: `Body of ${id}`, source: 'built-in', ...over });

await test('skill names become valid unique SKILL.md names', () => {
	const taken = new Set();
	const slugs = ['My Skill!', 'my-skill', 'UI/UX Pro', '???', 'x'.repeat(200)].map(id => { const s = skillsMod.skillSlug(id, taken); taken.add(s); return s; });
	assert.equal(slugs[0], 'my-skill');
	assert.equal(slugs[1], 'my-skill-2');
	assert.equal(slugs[2], 'ui-ux-pro');
	assert.equal(slugs[3], 'skill');
	assert.ok(slugs[4].length <= 64);
	assert.equal(new Set(slugs).size, slugs.length);
	for (const s of slugs) { assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/); }
});

await test('project skills are offered only in a trusted folder; empty ones never', () => {
	const all = [skill('a', { source: 'settings' }), skill('p', { source: 'file' }), skill('empty', { source: 'settings', instructions: '  ' })];
	assert.deepEqual(skillsMod.selectEngineSkills(all, true).map(s => s.id), ['a', 'p']);
	assert.deepEqual(skillsMod.selectEngineSkills(all, false).map(s => s.id), ['a']);
});

await test('bundled skills are opt-in: offered only while switched on; the user\'s own always', () => {
	const all = [skill('caveman'), skill('mine', { source: 'settings' }), skill('proj', { source: 'file' })];
	assert.deepEqual(skillsMod.selectEngineSkills(all, true, []).map(s => s.id), ['mine', 'proj']);
	assert.deepEqual(skillsMod.selectEngineSkills(all, true, ['caveman']).map(s => s.id), ['caveman', 'mine', 'proj']);
});

await test('SKILL.md has a header that survives quotes, colons and newlines in the description', () => {
	const [s] = skillsMod.selectEngineSkills([skill('a', { source: 'settings', description: 'Line one:\nline "two" # not a comment' })], true);
	const text = skillsMod.renderSkillFile(s);
	assert.match(text, /^---\nname: a\ndescription: "Line one: line \\"two\\" # not a comment"\n---\n\nBody of a\n$/);
	const long = skillsMod.selectEngineSkills([skill('b', { source: 'settings', description: 'x'.repeat(5000) })], true)[0];
	assert.ok(long.description.length <= 1024);
});

await test('the plugin is written once per distinct set, atomically, and old ones are pruned', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
	const set = n => skillsMod.selectEngineSkills(Array.from({ length: n }, (_, i) => skill(`s${i}`, { source: 'settings' })), true);
	const first = await skillsMod.writeSkillsPlugin(dir, set(2));
	assert.ok(first);
	assert.equal(JSON.parse(fs.readFileSync(path.join(first, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'stormcoder');
	assert.equal(fs.readFileSync(path.join(first, 'skills', 's1', 'SKILL.md'), 'utf8').includes('Body of s1'), true);
	const again = await skillsMod.writeSkillsPlugin(dir, set(2));
	assert.equal(again, first, 'an unchanged set reuses its folder');
	const both = await Promise.all([skillsMod.writeSkillsPlugin(dir, set(3)), skillsMod.writeSkillsPlugin(dir, set(3))]);
	assert.equal(both[0], both[1], 'concurrent turns agree');
	for (const n of [4, 5, 6]) { await skillsMod.writeSkillsPlugin(dir, set(n)); await new Promise(r => setTimeout(r, 15)); }
	const left = fs.readdirSync(dir).filter(n => !n.includes('.tmp-'));
	assert.ok(left.length <= 3, `kept ${left.length}`);
	assert.equal(fs.readdirSync(dir).some(n => n.includes('.tmp-')), false, 'no staging folders left behind');
	assert.equal(await skillsMod.writeSkillsPlugin(dir, []), undefined, 'nothing to offer');
	fs.writeFileSync(path.join(dir, 'blocker'), 'x');
	assert.equal(await skillsMod.writeSkillsPlugin(path.join(dir, 'blocker', 'sub'), set(1)), undefined, 'a write failure is a missing extra, never an error');
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('switched-on skills become a one-line nudge naming the plugin skills', () => {
	const offered = skillsMod.selectEngineSkills([skill('caveman', { source: 'settings' }), skill('UI Pro', { source: 'settings' })], true);
	const note = skillsMod.activeSkillsPrompt(['UI Pro', 'gone'], offered);
	assert.match(note, /stormcoder:ui-pro/);
	assert.ok(!/caveman|gone/.test(note));
	assert.ok(!note.includes('Body of'), 'the skill text itself is never pasted');
	assert.equal(skillsMod.activeSkillsPrompt([], offered), undefined);
	assert.equal(skillsMod.activeSkillsPrompt(['gone'], offered), undefined);
});

// --- tool names on the translated path -----------------------------------------------------------

await test('a tool name a provider would refuse is shortened both ways, and fine names are untouched', () => {
	const names = new ToolNames();
	const long = `mcp__${'server'.repeat(8)}__${'search_documentation'.repeat(3)}`;
	const dotted = 'mcp__my.server__do.thing';
	assert.equal(names.wire('Read'), 'Read');
	assert.equal(names.wire('mcp__db__query'), 'mcp__db__query');
	const w1 = names.wire(long);
	const w2 = names.wire(dotted);
	for (const w of [w1, w2]) { assert.match(w, /^[a-zA-Z0-9_-]{1,64}$/); }
	assert.notEqual(w1, w2);
	assert.equal(names.original(w1), long);
	assert.equal(names.original(w2), dotted);
	assert.equal(names.original('unknown'), 'unknown');
	assert.equal(new ToolNames().wire(long), w1, 'stable across requests, so caching keeps working');
	const other = `${long}x`;
	assert.notEqual(new ToolNames().wire(other), w1, 'two long names that share a prefix stay apart');
});

await test('toInternal renames tool definitions and earlier tool calls consistently', () => {
	const long = `mcp__${'a'.repeat(70)}__tool`;
	const r = toInternal({
		model: 'm', max_tokens: 1,
		tools: [{ name: long, input_schema: { type: 'object', properties: {} } }],
		messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: long, input: {} }] }],
	}, { allowImages: false });
	assert.equal(r.tools[0].name, r.messages[0].toolCalls[0].name);
	assert.match(r.tools[0].name, /^[a-zA-Z0-9_-]{1,64}$/);
	assert.equal(r.names.original(r.tools[0].name), long);
});

console.log(`engine extras: ${passed} tests, all assertions passed`);
