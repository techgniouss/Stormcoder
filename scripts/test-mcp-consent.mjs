/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/mcp/manager.ts's consent gate on servers a *project* defines.
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-mcp-consent.mjs
//
// Workspace trust alone used to let cloning a repository and opening the chat spawn whatever
// command its `.vscode/mcp.json` named. Servers from the user's own settings are not asked about.
import assert from 'node:assert/strict';
import Module from 'node:module';

// Nothing listens here, so an attempted connection fails fast — which is how the test tells a
// server that was *attempted* from one that was never started.
const DEAD = 'http://127.0.0.1:9/mcp';
const files = {
	'/repo/.vscode/mcp.json': JSON.stringify({ servers: { fromRepo: { url: DEAD } } }),
};
const shown = [];
let settingsServers = { fromSettings: { url: DEAD } };
const vscodeStub = {
	workspace: {
		isTrusted: true,
		workspaceFolders: [{ uri: { fsPath: '/repo', path: '/repo' } }],
		getConfiguration: () => ({ get: key => (key === 'mcp.servers' ? settingsServers : undefined) }),
		fs: {
			async readFile(uri) {
				if (!(uri.path in files)) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
				return new TextEncoder().encode(files[uri.path]);
			},
		},
	},
	Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
	window: {
		showWarningMessage: async (message, options) => { shown.push({ message, detail: options?.detail }); return 'Allow'; },
	},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { McpManager, promptingConsent, normalizeToolSchema, stripJsonComments } = await import(new URL('../out/mcp/manager.js', import.meta.url));

// Refused: the repository's server never starts; the user's own server is tried without asking.
{
	const asked = [];
	const manager = new McpManager(async (id, config, file) => { asked.push({ id, url: config.url, file }); return false; });
	await manager.ensureStarted();
	assert.deepStrictEqual(asked, [{ id: 'fromRepo', url: DEAD, file: '.vscode/mcp.json' }], 'only the project server is asked about');
	const status = manager.getStatus().join('\n');
	assert.match(status, /fromRepo: not started \(defined by \.vscode\/mcp\.json; not allowed\)/);
	assert.match(status, /fromSettings: failed/, 'the user\'s own server was attempted');
	manager.dispose();
}

// Allowed: it is attempted like any other.
{
	const manager = new McpManager(async () => true);
	await manager.ensureStarted();
	assert.match(manager.getStatus().join('\n'), /fromRepo: failed/);
	manager.dispose();
}

// With nothing wired in, the default is to refuse.
{
	const manager = new McpManager();
	await manager.ensureStarted();
	assert.match(manager.getStatus().join('\n'), /fromRepo: not started/);
	manager.dispose();
}

// --- robustness of the config itself -------------------------------------------------------
{
	const unhandled = [];
	process.on('unhandledRejection', e => unhandled.push(e));
	settingsServers = JSON.parse('{"nullOne":null,"arr":[],"str":"x","__proto__":{"url":"http://127.0.0.1:9/x"},"badArgs":{"command":"x","args":"nope"},"good":{"url":"' + DEAD + '"}}');
	files['/repo/.vscode/mcp.json'] = '{ "servers": { "fromRepo": { "url": "' + DEAD + '" }, }, // trailing comma and a comment\n}';
	const manager = new McpManager(async () => true);
	await manager.ensureStarted();
	const status = manager.getStatus().join('\n');
	assert.match(status, /nullOne: skipped \(the config must be an object, not null\)/);
	assert.match(status, /arr: skipped \(the config must be an object, not an array\)/);
	assert.match(status, /str: skipped/);
	assert.match(status, /badArgs: skipped \(.*args/);
	assert.match(status, /__proto__/);
	assert.match(status, /good: failed/, 'valid servers still run after invalid ones');
	assert.match(status, /fromRepo: failed/, 'JSONC comments and trailing commas are tolerated');
	manager.dispose();

	files['/repo/.vscode/mcp.json'] = '{ "servers": [] }';
	settingsServers = {};
	const m2 = new McpManager(async () => true);
	await m2.ensureStarted();
	assert.match(m2.getStatus().join('\n'), /mcp\.json: ignored/, 'array servers are reported');
	m2.dispose();

	files['/repo/.vscode/mcp.json'] = '{ "servers": { oops';
	const m3 = new McpManager(async () => true);
	await m3.ensureStarted();
	assert.match(m3.getStatus().join('\n'), /\.vscode\/mcp\.json: .*not valid JSON/, 'a malformed file is reported, not silently dropped');
	m3.dispose();

	delete files['/repo/.vscode/mcp.json'];
	const m4 = new McpManager(async () => true);
	await m4.ensureStarted();
	assert.equal(m4.getStatus().join('\n'), 'No MCP servers configured.', 'a missing file is not an error');
	m4.dispose();
	await new Promise(r => setTimeout(r, 20));
	assert.deepStrictEqual(unhandled, []);
	assert.deepStrictEqual(normalizeToolSchema({ $schema: 'x', type: 'object', properties: { a: {} } }), { type: 'object', properties: { a: {} } });
	assert.deepStrictEqual(normalizeToolSchema({ type: 'string' }), { type: 'object', properties: {} });
	assert.deepStrictEqual(normalizeToolSchema({ properties: { a: {} } }), { type: 'object', properties: { a: {} } });
	assert.equal(stripJsonComments('{"a": "// not a comment", /* x */ "b": [1,],}'), '{"a": "// not a comment",  "b": [1]}');
}

// --- the consent dialog names env keys, header names and cwd (never values) ------------------
{
	const memento = { store: new Map(), get(k) { return this.store.get(k); }, async update(k, v) { this.store.set(k, v); } };
	const consent = promptingConsent(memento);
	await consent('srv', { command: 'node', args: ['s.js'], cwd: '/elsewhere', env: { API_KEY: 'sekret-value' }, headers: { Authorization: 'Bearer sekret-token' } }, '.vscode/mcp.json');
	const { message, detail } = shown.at(-1);
	assert.match(message, /run: node s\.js/);
	assert.match(detail, /Working directory: \/elsewhere/);
	assert.match(detail, /Environment variables set: API_KEY/);
	assert.match(detail, /Request headers sent: Authorization/);
	assert.doesNotMatch(message + detail, /sekret/);
	// The remembered answer still covers the secrets: changing one asks again.
	await consent('srv', { command: 'node', args: ['s.js'], cwd: '/elsewhere', env: { API_KEY: 'changed' }, headers: { Authorization: 'Bearer sekret-token' } }, '.vscode/mcp.json');
	assert.equal(shown.length, 2, 'a changed env value is asked about again');
}

// --- lifecycle against a real stdio server ---------------------------------------------------
{
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mgr-'));
	const script = path.join(dir, 'server.cjs');
	fs.writeFileSync(script, `
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
if (process.env.PIDFILE) { require('fs').appendFileSync(process.env.PIDFILE, process.pid + '\\n'); }
require('readline').createInterface({ input: process.stdin }).on('line', line => {
	const m = JSON.parse(line);
	const delay = Number(process.env.DELAY || 0);
	if (m.method === 'initialize') {
		setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }), delay);
	} else if (m.method === 'tools/list') {
		send({ jsonrpc: '2.0', id: m.id, result: { tools: [
			{ name: 'envtool', description: process.env.X || '', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} } },
			{ name: 'weird', description: 5, inputSchema: 'nope' },
		] } });
	}
});
`);
	const pidFile = path.join(dir, 'pids');
	const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
	const base = { command: process.execPath, args: [script], cwd: dir };
	process.env.MCP_TEST_VALUE = 'expanded-ok';

	// ${env:} is expanded in the user's own config but not in a project's.
	settingsServers = { user: { ...base, env: { X: 'v=${env:MCP_TEST_VALUE}' } } };
	files['/repo/.vscode/mcp.json'] = JSON.stringify({ servers: { proj: { ...base, env: { X: 'v=${env:MCP_TEST_VALUE}' } } } });
	const env = new McpManager(async () => true);
	await env.ensureStarted();
	const specs = Object.fromEntries(env.tools().map(t => [t.name, t]));
	assert.equal(specs.mcp__user__envtool.description, '[MCP:user] v=expanded-ok');
	assert.equal(specs.mcp__proj__envtool.description, '[MCP:proj] v=${env:MCP_TEST_VALUE}', 'project config does not get the process environment');
	assert.match(env.getStatus().join('\n'), /proj: note/);
	assert.equal(specs.mcp__user__weird.description, '[MCP:user] weird', 'a non-string description falls back to the name');
	assert.deepStrictEqual(specs.mcp__user__weird.parameters, { type: 'object', properties: {} });
	assert.deepStrictEqual(specs.mcp__user__envtool.parameters, { type: 'object', properties: {} }, '$schema is stripped');
	env.dispose();

	// dispose() during a start: nothing is published and the child does not outlive it.
	settingsServers = { slow: { ...base, env: { DELAY: '600', PIDFILE: pidFile } } };
	files['/repo/.vscode/mcp.json'] = '{}';
	const disposed = new McpManager(async () => true);
	const startP = disposed.ensureStarted();
	await new Promise(r => setTimeout(r, 300));
	disposed.dispose();
	await startP;
	assert.deepStrictEqual(disposed.tools(), [], 'a disposed manager publishes no tools');
	assert.deepStrictEqual(disposed.getStatus(), ['No MCP servers configured.'], 'a stale start adds no status');
	await new Promise(r => setTimeout(r, 400));
	for (const pid of fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)) {
		assert.equal(alive(pid), false, 'the in-flight child was killed');
	}

	// reconnect() mid-start: the caller that was waiting gets the NEW generation's tools.
	settingsServers = { slow: { ...base, env: { DELAY: '400' } } };
	const re = new McpManager(async () => true);
	const first = re.ensureStarted();
	await new Promise(r => setTimeout(r, 150));
	re.reconnect();
	await first;
	assert.equal(re.tools().length, 2, 'ensureStarted waited for the restarted connection');
	assert.equal(re.getStatus().filter(l => l.startsWith('slow: connected')).length, 1);
	re.dispose();
}

console.log('test-mcp-consent: all assertions passed');
