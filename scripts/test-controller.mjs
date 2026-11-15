// Controller: which files the built-in editor may touch, settings validation, and a failed
// engine start not poisoning later ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ctl-'));
// One bundle holds both modules, so the test reads the same host environment the Controller installs.
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(root, 'host/controller.ts'))};
export { host as hostEnvOf } from ${JSON.stringify(path.join(root, 'host/env.ts'))};
`);
await esbuild.build({ entryPoints: [entry], outfile: path.join(tmp, 'controller.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const { Controller, hostEnvOf } = createRequire(import.meta.url)(path.join(tmp, 'controller.cjs'));

const data = path.join(tmp, 'data');
const project = path.join(tmp, 'project');
const secret = path.join(tmp, 'outside');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(secret, { recursive: true });
fs.writeFileSync(path.join(data, 'secrets.json'), '{}');
fs.writeFileSync(path.join(data, 'settings.json'), '{}');

let activations = 0;
let failNext = false;
const engine = { activate: () => { hostEnv = hostEnvOf(); activations++; if (failNext) { failNext = false; throw new Error('boom'); } }, deactivate: () => undefined };
const fatals = [];
const attention = [];
const attentionChats = [];
let hostEnv;
const c = new Controller({
	appRoot: root, userDataDir: data, uriScheme: 'stormcoder', appVersion: 't', platform: process.platform, secureStorage: false,
	codec: { encrypt: s => Buffer.from(s), decrypt: b => String(b) },
	send: () => undefined, openExternal: async () => true, readClipboard: async () => '', writeClipboard: async () => undefined,
	pickFolder: async () => undefined, pickFiles: async () => undefined, confirmTrust: async () => 'trust', showFatal: (t, d) => fatals.push([t, d]), attention: (k, id) => { attention.push(k); attentionChats.push(id); },
}, engine, h => h);

const can = async (name, file, text) => { try { await c.handleCall(name, text === undefined ? [file] : [file, text]); return true; } catch { return false; } };

assert.equal(await can('readFile', path.join(data, 'settings.json')), true);
assert.equal(await can('readFile', path.join(data, 'secrets.json')), false);
assert.equal(await can('readFile', path.join(data, 'secret.key')), false);
assert.equal(await can('readFile', path.join(data, 'app-state.json')), false);
assert.equal(await can('writeFile', path.join(data, 'settings.json'), '{ nope'), false, 'invalid settings JSON is refused');
assert.equal(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'), '{}');
assert.equal(await can('writeFile', path.join(data, 'settings.json'), '{"a":1}'), true);

// Project paths need a trusted folder, and a symlinked config folder must not escape.
assert.equal(await can('readFile', path.join(project, '.vscode', 'mcp.json')), false, 'no folder open');
await c.openFolder(project);
assert.equal(await can('writeFile', path.join(project, '.openvs', 'mcp.json'), '{}'), true);
assert.equal(await can('writeFile', path.join(project, 'src.txt'), 'x'), false);
assert.equal(await can('writeFile', path.join(project, '.openvs', 'skills', 'x.md'), '# x'), true, 'project skills are editable');
if (process.platform !== 'win32') {
	fs.symlinkSync(secret, path.join(project, '.vscode'));
	assert.equal(await can('writeFile', path.join(project, '.vscode', 'mcp.json'), '{}'), false, 'symlinked .vscode is refused');
	assert.ok(!fs.existsSync(path.join(secret, 'mcp.json')));
}

// A throwing activation is reported and later starts still run.
failNext = true;
await c.start();
const before = activations;
await c.start();
assert.equal(activations, before + 1);

// Desktop notifications: only chat messages that block a run reach the embedder at the default
// level, only the kind is passed on, and a burst is throttled to one.
assert.ok(hostEnv, 'the engine saw a configured host');
attention.length = 0;
hostEnv.postToView('chat', { type: 'token', text: 'x' });
hostEnv.postToView('settings', { type: 'approvalRequest' });
hostEnv.postToView('chat', { type: 'done' });
assert.deepEqual(attention, [], 'tokens, other views and a finished run are silent by default');
hostEnv.postToView('chat', { type: 'approvalRequest', detail: 'rm -rf /' });
hostEnv.postToView('chat', { type: 'approvalRequest', detail: 'again' });
hostEnv.postToView('chat', { type: 'askRequest', question: 'secret?' });
assert.deepEqual(attention, ['approval', 'question']);
// The chat that raised it is named by id only, so a click can open that chat.
assert.deepEqual(attentionChats, [undefined, undefined]);
attention.length = 0; attentionChats.length = 0;
await new Promise(r => setTimeout(r, 5));
hostEnv.postToView('chat', { type: 'done', sessionId: 'chat-7', content: 'not passed on' });
assert.deepEqual([attention, attentionChats], [[], []], 'still silent for a finished run at the default level');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ 'stormcoder.notifications': 'all' }));
await c.handleCall('writeFile', [path.join(data, 'settings.json'), JSON.stringify({ 'stormcoder.notifications': 'all' })]);
hostEnv.postToView('chat', { type: 'done', sessionId: 'chat-7', content: 'not passed on' });
assert.deepEqual([attention, attentionChats], [['done'], ['chat-7']]);
// openChat hands the engine a switchSession for that id, and ignores anything that is not an id.
c.openChat('chat-7');
c.openChat(undefined);
c.openChat('');
c.openChat('x'.repeat(201));

// A scratch chat: an empty folder of the app's own, opened as the project and trusted without
// the trust question (which would otherwise be asked for any folder not yet trusted).
{
	let asked = 0;
	const c2 = new Controller({
		appRoot: root, userDataDir: data, uriScheme: 'stormcoder', appVersion: 't', platform: process.platform, secureStorage: false,
		codec: { encrypt: s => Buffer.from(s), decrypt: b => String(b) },
		send: () => undefined, openExternal: async () => true, readClipboard: async () => '', writeClipboard: async () => undefined,
		pickFolder: async () => undefined, pickFiles: async () => undefined, confirmTrust: async () => { asked++; return 'cancel'; }, showFatal: () => undefined,
	}, { activate: () => undefined, deactivate: () => undefined }, h => h);
	await c2.handleCall('command', ['app.newScratch']);
	const first = hostEnvOf().workspaceFolder;
	assert.ok(first && path.dirname(first) === path.join(data, 'scratch'), 'the folder is under the app data');
	assert.match(path.basename(first), /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/);
	assert.deepEqual(fs.readdirSync(first), [], 'and it is empty');
	assert.equal(hostEnvOf().workspaceTrusted, true);
	assert.equal(asked, 0, 'the trust question is not asked for a folder the app just made');
	// Two in the same second get different folders.
	await c2.handleCall('command', ['app.newScratch']);
	const second = hostEnvOf().workspaceFolder;
	assert.notEqual(second, first);
	assert.ok(c2.recentFolders().includes(first) && c2.recentFolders().includes(second), 'both can be reopened from recent projects');
	// Any other folder is still asked about.
	await c2.openFolder(secret);
	assert.equal(asked, 1);
	assert.equal(hostEnvOf().workspaceFolder, second, 'and declining leaves the scratch folder open');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-controller: all assertions passed');
