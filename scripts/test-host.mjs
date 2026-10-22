// The vscode compatibility layer: URIs, globs, settings, secrets, files and edits, driven
// against a real temp directory through the same entry points the engine calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-host-'));
// One bundle holds both modules, so the shim and the environment it reads share an instance.
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(root, 'host/vscode.ts'))};\nexport { configureHost } from ${JSON.stringify(path.join(root, 'host/env.ts'))};\n`);
await esbuild.build({ entryPoints: [entry], outfile: path.join(tmp, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const vs = createRequire(import.meta.url)(path.join(tmp, 'host.cjs'));
const env = vs;

const project = path.join(tmp, 'project');
const data = path.join(tmp, 'data');
fs.mkdirSync(path.join(project, 'src/deep'), { recursive: true });
fs.mkdirSync(path.join(project, 'node_modules/x'), { recursive: true });
fs.writeFileSync(path.join(project, 'src/a.ts'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(project, 'src/deep/b.ts'), 'b');
fs.writeFileSync(path.join(project, 'node_modules/x/c.ts'), 'c');
const notices = [];
env.configureHost({
	appRoot: root, userDataDir: data, workspaceFolder: project, workspaceTrusted: true, uriScheme: 'mjolnir', appVersion: 't',
	request: async r => (r.kind === 'message' ? r.actions[0] : r.kind === 'pick' ? 1 : r.kind === 'input' ? 'typed' : undefined),
	notify: e => notices.push(e), postToView: () => undefined, setViewHtml: () => undefined,
	openExternal: async () => true, readClipboard: async () => '', writeClipboard: async () => undefined,
	encrypt: s => Buffer.from(s.split('').reverse().join('')), decrypt: b => String(b).split('').reverse().join(''),
});

// Uri: file round trip, joinPath, parse of an app link, with().
const f = vs.Uri.file('/a/b c/d.txt');
assert.equal(f.fsPath, process.platform === 'win32' ? '\\a\\b c\\d.txt' : '/a/b c/d.txt');
assert.equal(vs.Uri.joinPath(vs.Uri.file('/a'), 'b', '..', 'c').path, '/a/c');
const link = vs.Uri.parse('mjolnir://openvs.openvs-chat/auth-callback?state=ab%3D&token=t');
assert.deepEqual([link.scheme, link.authority, link.path, link.query], ['mjolnir', 'openvs.openvs-chat', '/auth-callback', 'state=ab=&token=t']);

// Globs, the way the search tools write them.
const g = vs.globToRegExp;
assert.ok(g('**/*.ts').test('a.ts') && g('**/*.ts').test('x/y/a.ts') && !g('**/*.ts').test('a.js'));
assert.ok(g('src/*.ts').test('src/a.ts') && !g('src/*.ts').test('src/deep/a.ts'));
assert.ok(g('**/{node_modules,.git}/**').test('x/node_modules/y/z.ts'));

// Settings: defaults from the manifest, user overrides, change events, persistence.
const ctx = vs.createContext();
const cfg = vs.workspace.getConfiguration('openvsChat');
assert.equal(cfg.get('agent.maxSteps') > 0, true);
assert.equal(cfg.get('does.not.exist', 7), 7);
const events = [];
vs.workspace.onDidChangeConfiguration(e => events.push(e.affectsConfiguration('openvsChat.agent')));
await cfg.update('agent.maxSteps', 12, vs.ConfigurationTarget.Global);
assert.equal(vs.workspace.getConfiguration('openvsChat').get('agent.maxSteps'), 12);
assert.deepEqual(events, [true]);
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'))['openvsChat.agent.maxSteps'], 12);
await cfg.update('agent.maxSteps', undefined);
assert.notEqual(vs.workspace.getConfiguration('openvsChat').get('agent.maxSteps'), 12);

// Secrets are encrypted at rest and readable back; state survives a new context.
await ctx.secrets.store('k', 'sk-secret');
assert.equal(await ctx.secrets.get('k'), 'sk-secret');
assert.ok(!fs.readFileSync(path.join(data, 'secrets.json'), 'utf8').includes('sk-secret'));
await ctx.workspaceState.update('x', { n: 1 });
assert.deepEqual(vs.createContext().workspaceState.get('x'), { n: 1 });
assert.equal(vs.createContext().workspaceState.get('missing', 'dflt'), 'dflt');

// Files: findFiles honours include/exclude and the cap; fs wraps ENOENT as FileNotFound.
const found = (await vs.workspace.findFiles('**/*.ts', '**/node_modules/**', 10)).map(u => vs.workspace.asRelativePath(u)).sort();
assert.deepEqual(found, ['src/a.ts', 'src/deep/b.ts']);
assert.equal((await vs.workspace.findFiles('**/*.ts', undefined, 1)).length, 1);
await assert.rejects(vs.workspace.fs.stat(vs.Uri.file(path.join(project, 'nope'))), /not found|ENOENT/i);
const dir = await vs.workspace.fs.readDirectory(vs.Uri.file(path.join(project, 'src')));
assert.deepEqual(dir.map(([n, t]) => [n, t]).sort(), [['a.ts', vs.FileType.File], ['deep', vs.FileType.Directory]]);

// Edits: ranges are applied back to front, so offsets stay valid.
const doc = await vs.workspace.openTextDocument(vs.Uri.file(path.join(project, 'src/a.ts')));
assert.equal(doc.lineCount, 4);
const edit = new vs.WorkspaceEdit();
edit.replace(doc.uri, new vs.Range(0, 0, 0, 3), 'ONE');
edit.replace(doc.uri, new vs.Range(2, 0, 2, 5), '3');
assert.equal(await vs.workspace.applyEdit(edit), true);
assert.equal(fs.readFileSync(path.join(project, 'src/a.ts'), 'utf8'), 'ONE\ntwo\n3\n');

// Window: messages answer with the chosen action, quick picks map back to items, inputs return text.
assert.equal(await vs.window.showInformationMessage('hi', 'Yes', 'No'), 'Yes');
assert.deepEqual(await vs.window.showQuickPick([{ label: 'a' }, { label: 'b' }]), { label: 'b' });
assert.equal(await vs.window.showInputBox({ prompt: 'p' }), 'typed');
let progressed = 0;
await vs.window.withProgress({ location: vs.ProgressLocation.Notification, title: 't' }, async () => { progressed++; });
assert.equal(progressed, 1);
assert.deepEqual(notices.filter(n => n.kind === 'progress').map(n => n.done), [false, true]);

// Commands and URI handlers.
let ran;
vs.commands.registerCommand('t.cmd', x => { ran = x; return 5; });
assert.equal(await vs.commands.executeCommand('t.cmd', 'arg'), 5);
assert.equal(ran, 'arg');
assert.equal(await vs.commands.executeCommand('editor.action.unknown'), undefined);
let got;
vs.window.registerUriHandler({ handleUri: u => { got = u.path; } });
vs.deliverUri('mjolnir://x/auth-callback?token=1');
assert.equal(got, '/auth-callback');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-host: all assertions passed');
