// Controller: which files the built-in editor may touch, settings validation, and a failed
// engine start not poisoning later ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ctl-'));
await esbuild.build({ entryPoints: [path.join(root, 'host/controller.ts')], outfile: path.join(tmp, 'controller.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const { Controller } = createRequire(import.meta.url)(path.join(tmp, 'controller.cjs'));

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
const engine = { activate: () => { activations++; if (failNext) { failNext = false; throw new Error('boom'); } }, deactivate: () => undefined };
const fatals = [];
const c = new Controller({
	appRoot: root, userDataDir: data, uriScheme: 'stormcoder', appVersion: 't', platform: process.platform, secureStorage: false,
	codec: { encrypt: s => Buffer.from(s), decrypt: b => String(b) },
	send: () => undefined, openExternal: async () => true, readClipboard: async () => '', writeClipboard: async () => undefined,
	pickFolder: async () => undefined, pickFiles: async () => undefined, confirmTrust: async () => 'trust', showFatal: (t, d) => fatals.push([t, d]),
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-controller: all assertions passed');
