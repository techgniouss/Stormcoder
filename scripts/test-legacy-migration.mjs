/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// An install made before the OpenVS -> Stormcoder rename keeps everything it had: settings, API
// keys, sign-in sessions, chat history, remote-control secrets. The pre-rename prefix is
// `openvsChat.`; the new one is `stormcoder.`; the stored values must come across untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-legacy-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(root, 'host/vscode.ts'))};\nexport { configureHost } from ${JSON.stringify(path.join(root, 'host/env.ts'))};\n`);
await esbuild.build({ entryPoints: [entry], outfile: path.join(tmp, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const require = createRequire(import.meta.url);
const vs = require(path.join(tmp, 'host.cjs'));

const data = path.join(tmp, 'data');
const project = path.join(tmp, 'project');
fs.mkdirSync(path.join(data, 'state'), { recursive: true });
fs.mkdirSync(project, { recursive: true });
const encode = s => Buffer.from(s).toString('base64');
vs.configureHost({
	appRoot: root, userDataDir: data, workspaceFolder: project, workspaceTrusted: true, uriScheme: 't', appVersion: 't',
	request: async () => undefined, notify: () => { }, postToView: () => { }, setViewHtml: () => { }, openExternal: async () => true,
	readClipboard: async () => '', writeClipboard: async () => { }, encrypt: s => Buffer.from(s), decrypt: b => String(b),
});

// The workspace state file's name depends on the folder, so let the host create it first.
{
	const first = vs.createContext();
	await first.workspaceState.update('probe', 1);
}
const workspaceFile = path.join(data, 'state', fs.readdirSync(path.join(data, 'state')).find(f => f.startsWith('workspace-')));

fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({
	'openvsChat.apiKey.groq': encode('gsk-old-groq-key'),
	'openvsChat.oauth.antigravity': encode('{"refresh":"r1"}'),
	'openvsChat.remote.roomSecret.room1': encode('room-secret'),
	'openvsChat.apiKey.openai': encode('old-openai'),
	'stormcoder.apiKey.openai': encode('new-openai'),
	'unrelated.key': encode('keep me'),
}));
fs.writeFileSync(path.join(data, 'state', 'global.json'), JSON.stringify({
	'openvsChat.activeSkill': 'api-reviewer',
	'openvsChat.remote.knownRooms': ['room1'],
	'other.key': 7,
}));
fs.writeFileSync(workspaceFile, JSON.stringify({
	'openvsChat.chatHistory': [{ id: 'h1', title: 'Old chat' }],
	'openvsChat.sessions': { activeSessionId: 's1' },
	[`openvsChat.mcpConsent.${'a'.repeat(64)}`]: true,
}));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ 'openvsChat.defaultProvider': 'groq', 'editor.fontSize': 14 }));

const ctx = vs.createContext();

// Secrets: moved as stored, readable under the new names, the new name wins a clash.
assert.equal(await ctx.secrets.get('stormcoder.apiKey.groq'), 'gsk-old-groq-key');
assert.equal(await ctx.secrets.get('stormcoder.oauth.antigravity'), '{"refresh":"r1"}');
assert.equal(await ctx.secrets.get('stormcoder.remote.roomSecret.room1'), 'room-secret');
assert.equal(await ctx.secrets.get('stormcoder.apiKey.openai'), 'new-openai', 'a key already stored under the new name wins');
assert.equal(await ctx.secrets.get('unrelated.key'), 'keep me');
assert.equal(await ctx.secrets.get('openvsChat.apiKey.groq'), undefined, 'the old name is gone');
const secretsOnDisk = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8'));
assert.ok(!Object.keys(secretsOnDisk).some(k => k.startsWith('openvsChat.')), 'the file no longer holds legacy keys');
assert.ok(Object.values(secretsOnDisk).every(v => !v.includes('gsk-old')), 'still stored encoded, not in the clear');

// Mementos: global and per-workspace state.
assert.equal(ctx.globalState.get('stormcoder.activeSkill'), 'api-reviewer');
assert.deepEqual(ctx.globalState.get('stormcoder.remote.knownRooms'), ['room1']);
assert.equal(ctx.globalState.get('other.key'), 7);
assert.deepEqual(ctx.workspaceState.get('stormcoder.chatHistory'), [{ id: 'h1', title: 'Old chat' }]);
assert.deepEqual(ctx.workspaceState.get('stormcoder.sessions'), { activeSessionId: 's1' });
assert.equal(ctx.workspaceState.get(`stormcoder.mcpConsent.${'a'.repeat(64)}`), true, 'a consent decision is kept');
assert.equal(ctx.workspaceState.get('openvsChat.chatHistory'), undefined);
assert.ok(!Object.keys(JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))).some(k => k.startsWith('openvsChat.')));

// Settings.
vs.reloadSettings();
assert.equal(vs.workspace.getConfiguration('stormcoder').get('defaultProvider'), 'groq');
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'))['editor.fontSize'], 14);

// Idempotent: a second start changes nothing.
const before = fs.readFileSync(path.join(data, 'secrets.json'), 'utf8');
vs.createContext();
assert.equal(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8'), before);

// The benchmark's reading of an app folder that has not been opened since the rename.
{
	const { inspectApp, prepareDataCopy } = await import(new URL('../bench/lib/appkeys.mjs', import.meta.url));
	const old = path.join(tmp, 'old-app');
	fs.mkdirSync(old, { recursive: true });
	fs.writeFileSync(path.join(old, 'secrets.json'), JSON.stringify({ 'openvsChat.apiKey.groq': encode('k'), 'openvsChat.oauth.copilot': encode('t') }));
	fs.writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ 'openvsChat.defaultProvider': 'groq', 'openvsChat.groq.model': 'llama-3.3-70b-versatile' }));
	const app = inspectApp(old);
	assert.deepEqual(app.apiKeys, ['groq']);
	assert.deepEqual(app.signedIn, ['copilot']);
	assert.equal(app.defaultProvider, 'groq');
	const copy = prepareDataCopy(app, {});
	const copied = JSON.parse(fs.readFileSync(path.join(copy.dir, 'secrets.json'), 'utf8'));
	assert.deepEqual(Object.keys(copied), ['openvsChat.apiKey.groq'], 'the API key comes across; the sign-in session does not');
	assert.equal(JSON.parse(fs.readFileSync(path.join(copy.dir, 'settings.json'), 'utf8'))['stormcoder.groq.model'], 'llama-3.3-70b-versatile');
	copy.dispose();
}

console.log('test-legacy-migration: all assertions passed');
