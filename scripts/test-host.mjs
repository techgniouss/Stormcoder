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
const requests = [];
const opened = [];
const trashed = [];
const baseEnv = {
	appRoot: root, userDataDir: data, workspaceFolder: project, workspaceTrusted: true, uriScheme: 'stormcoder', appVersion: 't',
	request: async r => { requests.push(r); return r.kind === 'message' ? r.actions[0] : r.kind === 'pick' ? 1 : r.kind === 'input' ? 'typed' : undefined; },
	notify: e => notices.push(e), postToView: () => undefined, setViewHtml: () => undefined,
	openExternal: async u => { opened.push(u); return true; }, readClipboard: async () => '', writeClipboard: async () => undefined,
	encrypt: s => Buffer.from(s.split('').reverse().join('')), decrypt: b => String(b).split('').reverse().join(''),
};
env.configureHost(baseEnv);

// Uri: file round trip, joinPath, parse of an app link, with().
const f = vs.Uri.file('/a/b c/d.txt');
assert.equal(f.fsPath, process.platform === 'win32' ? '\\a\\b c\\d.txt' : '/a/b c/d.txt');
assert.equal(vs.Uri.joinPath(vs.Uri.file('/a'), 'b', '..', 'c').path, '/a/c');
const link = vs.Uri.parse('stormcoder://openvs.openvs-chat/auth-callback?state=ab%3D&token=t');
assert.deepEqual([link.scheme, link.authority, link.path, link.query], ['stormcoder', 'openvs.openvs-chat', '/auth-callback', 'state=ab=&token=t']);

// Globs, the way the search tools write them.
const g = vs.globToRegExp;
assert.ok(g('**/*.ts').test('a.ts') && g('**/*.ts').test('x/y/a.ts') && !g('**/*.ts').test('a.js'));
assert.ok(g('src/*.ts').test('src/a.ts') && !g('src/*.ts').test('src/deep/a.ts'));
assert.ok(g('**/{node_modules,.git}/**').test('x/node_modules/y/z.ts'));

// Settings: defaults from the manifest, user overrides, change events, persistence.
const ctx = vs.createContext();
const cfg = vs.workspace.getConfiguration('stormcoder');
assert.equal(cfg.get('agent.maxSteps') > 0, true);
assert.equal(cfg.get('does.not.exist', 7), 7);
const events = [];
vs.workspace.onDidChangeConfiguration(e => events.push(e.affectsConfiguration('stormcoder.agent')));
await cfg.update('agent.maxSteps', 12, vs.ConfigurationTarget.Global);
assert.equal(vs.workspace.getConfiguration('stormcoder').get('agent.maxSteps'), 12);
assert.deepEqual(events, [true]);
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'))['stormcoder.agent.maxSteps'], 12);
await cfg.update('agent.maxSteps', undefined);
assert.notEqual(vs.workspace.getConfiguration('stormcoder').get('agent.maxSteps'), 12);

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
vs.deliverUri('stormcoder://x/auth-callback?token=1');
assert.equal(got, '/auth-callback');

// --- Regression tests for audited host bugs -------------------------------------------------

// A settings.json that stops parsing keeps the settings in memory and is never overwritten.
{
	const settingsPath = path.join(data, 'settings.json');
	await cfg.update('agent.maxSteps', 33);
	const good = fs.readFileSync(settingsPath, 'utf8');
	fs.writeFileSync(settingsPath, '{ "stormcoder.agent.maxSteps": 33, oops');
	vs.reloadSettings();
	assert.equal(vs.workspace.getConfiguration('stormcoder').get('agent.maxSteps'), 33, 'previous settings survive a parse error');
	await assert.rejects(cfg.update('agent.maxSteps', 5), /not valid JSON/);
	assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ "stormcoder.agent.maxSteps": 33, oops', 'the broken file is not overwritten');
	fs.writeFileSync(settingsPath, good);
	vs.reloadSettings();
	await cfg.update('agent.maxSteps', 34);
	assert.equal(vs.workspace.getConfiguration('stormcoder').get('agent.maxSteps'), 34);
	await cfg.update('agent.maxSteps', undefined);
}

// Settings saved before the rename (openvsChat.*) are carried over, and a key already set under the
// new name wins.
{
	const settingsPath = path.join(data, 'settings.json');
	const good = fs.readFileSync(settingsPath, 'utf8');
	fs.writeFileSync(settingsPath, JSON.stringify({
		'openvsChat.agent.maxSteps': 21,
		'openvsChat.defaultProvider': 'groq',
		'stormcoder.defaultProvider': 'openai',
		'editor.fontSize': 14,
	}));
	vs.reloadSettings();
	const migrated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
	assert.equal(migrated['stormcoder.agent.maxSteps'], 21, 'a legacy key is moved to the new namespace');
	assert.equal(migrated['stormcoder.defaultProvider'], 'openai', 'a key already set under the new name wins');
	assert.equal(migrated['editor.fontSize'], 14, 'unrelated keys are untouched');
	assert.ok(!Object.keys(migrated).some(k => k.startsWith('openvsChat.')), 'no legacy keys remain');
	assert.equal(vs.workspace.getConfiguration('stormcoder').get('agent.maxSteps'), 21);
	fs.writeFileSync(settingsPath, good);
	vs.reloadSettings();
}

// A corrupt state file is moved aside, not silently reset in place.
{
	const stateFile = path.join(data, 'state', 'global.json');
	fs.writeFileSync(stateFile, '{not json');
	const fresh = vs.createContext().globalState;
	assert.deepEqual(fresh.keys(), []);
	assert.ok(fs.readdirSync(path.join(data, 'state')).some(n => n.startsWith('global.json.corrupt-')), 'corrupt file kept for recovery');
	await fresh.update('k', 1);
	assert.equal(vs.createContext().globalState.get('k'), 1);
}

// openExternal keeps an OAuth redirect_uri intact (%26 must not turn into &).
{
	const url = 'https://auth.example/authorize?client_id=a&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb%3Fx%3D1%26y%3D2&scope=a%20b';
	await vs.env.openExternal(vs.Uri.parse(url));
	assert.equal(opened.at(-1), url);
	await vs.env.openExternal(url);
	assert.equal(opened.at(-1), url);
	await vs.env.openExternal(vs.Uri.parse('https://e.example/p').with({ query: 'a=b' }));
	assert.equal(opened.at(-1), 'https://e.example/p?a=b');
}

// The input box re-prompts with what was typed after a validation failure.
{
	requests.length = 0;
	let tries = 0;
	const got = await vs.window.showInputBox({ value: 'orig', validateInput: () => (++tries < 2 ? 'bad' : undefined) });
	assert.equal(got, 'typed');
	const inputs = requests.filter(r => r.kind === 'input');
	assert.deepEqual(inputs.map(r => r.value), ['orig', 'typed']);
}

// Status bar items push text, tooltip and command changes made after show().
{
	notices.length = 0;
	const item = vs.window.createStatusBarItem(vs.StatusBarAlignment.Left, 1);
	item.text = 'before';
	assert.equal(notices.length, 0, 'nothing is shown before show()');
	item.show();
	item.text = 'after';
	item.tooltip = 'tip';
	const status = notices.filter(n => n.kind === 'status');
	assert.deepEqual(status.map(n => [n.text, n.tooltip, n.visible]), [['before', undefined, true], ['after', undefined, true], ['after', 'tip', true]]);
	item.hide();
	item.text = 'hidden';
	assert.equal(notices.filter(n => n.kind === 'status').length, 4, 'a hidden item stays quiet');
}

// withProgress: Cancel reaches the task's token.
{
	notices.length = 0;
	let cancelled = false;
	const task = vs.window.withProgress({ location: vs.ProgressLocation.Notification, title: 'c', cancellable: true }, (_p, token) => new Promise(resolve => {
		token.onCancellationRequested(() => { cancelled = true; resolve('x'); });
	}));
	const start = notices.find(n => n.kind === 'progress');
	assert.equal(start.cancellable, true);
	vs.cancelProgress(start.id);
	await task;
	assert.equal(cancelled, true);
}

// Same-position inserts keep call order.
{
	const file = path.join(project, 'ins.txt');
	fs.writeFileSync(file, 'ab');
	const e = new vs.WorkspaceEdit();
	e.insert(vs.Uri.file(file), new vs.Position(0, 1), '1');
	e.insert(vs.Uri.file(file), new vs.Position(0, 1), '2');
	e.insert(vs.Uri.file(file), new vs.Position(0, 1), '3');
	assert.equal(await vs.workspace.applyEdit(e), true);
	assert.equal(fs.readFileSync(file, 'utf8'), 'a123b');
}

// Globs: character classes, and a comma is literal outside braces.
assert.ok(g('src/[ab].ts').test('src/a.ts') && g('src/[ab].ts').test('src/b.ts') && !g('src/[ab].ts').test('src/c.ts'));
assert.ok(g('[!a].ts').test('b.ts') && !g('[!a].ts').test('a.ts'));
assert.ok(g('a,b.txt').test('a,b.txt') && !g('a,b.txt').test('a') && !g('a,b.txt').test('b.txt'));
assert.ok(g('*.{ts,js}').test('x.js') && g('*.{ts,js}').test('x.ts') && !g('*.{ts,js}').test('x.md'));

// getWorkspaceFolder: a sibling named "..foo" inside the folder is inside; "../x" is not.
fs.mkdirSync(path.join(project, '..foo'), { recursive: true });
assert.ok(vs.workspace.getWorkspaceFolder(vs.Uri.file(path.join(project, '..foo', 'x.txt'))));
assert.equal(vs.workspace.getWorkspaceFolder(vs.Uri.file(path.join(project, '..', 'other.txt'))), undefined);
assert.equal(vs.workspace.asRelativePath(path.join(project, '..foo', 'x.txt')), '..foo/x.txt');

// Symlinks: reported as links, linked files are found, linked folders are not entered.
if (process.platform !== 'win32') {
	fs.symlinkSync(path.join(project, 'src/a.ts'), path.join(project, 'link.ts'));
	fs.symlinkSync(path.join(project, 'src'), path.join(project, 'dirlink'));
	fs.symlinkSync(path.join(project, 'missing'), path.join(project, 'dangling'));
	const entries = Object.fromEntries(await vs.workspace.fs.readDirectory(vs.Uri.file(project)));
	assert.equal(entries['link.ts'], vs.FileType.File | vs.FileType.SymbolicLink);
	assert.equal(entries['dirlink'], vs.FileType.Directory | vs.FileType.SymbolicLink);
	assert.equal(entries['dangling'], vs.FileType.Unknown | vs.FileType.SymbolicLink);
	const all = (await vs.workspace.findFiles('**/*.ts', '**/node_modules/**')).map(u => vs.workspace.asRelativePath(u));
	assert.ok(all.includes('link.ts'), 'a symlinked file is a result');
	assert.ok(!all.some(f => f.startsWith('dirlink/')), 'a symlinked folder is not entered');
}

// fs.delete honours useTrash through the optional hook, else deletes permanently; ENOENT maps to FileNotFound.
{
	const victim = path.join(project, 'victim.txt');
	fs.writeFileSync(victim, 'x');
	env.configureHost({ ...baseEnv, trash: async f => { trashed.push(f); } });
	await vs.workspace.fs.delete(vs.Uri.file(victim), { useTrash: true });
	assert.deepEqual(trashed, [victim]);
	assert.ok(fs.existsSync(victim), 'the hook decides what happens to the file');
	env.configureHost(baseEnv);
	await vs.workspace.fs.delete(vs.Uri.file(victim), { useTrash: true });
	assert.ok(!fs.existsSync(victim), 'no hook: permanent delete');
	const missing = vs.Uri.file(path.join(project, 'nope.txt'));
	for (const op of [() => vs.workspace.fs.delete(missing), () => vs.workspace.fs.rename(missing, vs.Uri.file(path.join(project, 'n2.txt'))), () => vs.workspace.fs.copy(missing, vs.Uri.file(path.join(project, 'n3.txt')))]) {
		await assert.rejects(op(), e => e instanceof vs.FileSystemError && e.code === 'FileNotFound');
	}
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-host: all assertions passed');
