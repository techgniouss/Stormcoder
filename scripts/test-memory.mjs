/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Project memory, on the real host against a throwaway workspace:
//   - saved facts: typed, dated, deduplicated, bounded, secret-free, user lines never evicted
//   - the run journal and the prompt block built from both
//   - the `remember` tool, including its approval and the trust gate
//   - WorkLog's changed-files and verified tracking that feeds the journal
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-memory-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(root, 'host/vscode.ts'))};\nexport { configureHost } from ${JSON.stringify(path.join(root, 'host/env.ts'))};\n`);
await esbuild.build({ entryPoints: [entry], outfile: path.join(tmp, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const require = createRequire(import.meta.url);
const vs = require(path.join(tmp, 'host.cjs'));

const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const trusted = { value: true };
vs.configureHost({
	appRoot: root, userDataDir: path.join(tmp, 'data'), workspaceFolder: ws, workspaceTrusted: true, uriScheme: 't', appVersion: 't',
	request: async () => undefined, notify: () => { }, postToView: () => { }, setViewHtml: () => { }, openExternal: async () => true,
	readClipboard: async () => '', writeClipboard: async () => { }, encrypt: s => Buffer.from(s), decrypt: b => String(b),
});
vs.createContext();
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vs : load.apply(this, [request, ...rest]); };

const mem = require('../out/memory/projectMemory.js');
const tools = require('../out/agent/tools.js');
const { WorkLog } = require('../out/agent/workLog.js');
const file = rel => path.join(ws, rel);

// 1. Adding facts: typed, dated, one line.
{
	const r = mem.addMemory('', 'gotcha', 'Run  `npm run gen`\nafter editing settings.', '2026-10-24');
	assert.equal(r.saved, true);
	assert.equal(r.content, '- [gotcha] Run `npm run gen` after editing settings. (2026-10-24)\n');
	assert.equal(mem.addMemory('', 'whatever', 'x', '2026-10-24').saved, false, 'unknown type');
	assert.equal(mem.addMemory('', 'gotcha', '   ', '2026-10-24').saved, false, 'empty');
	assert.match(mem.addMemory('', 'gotcha', 'x'.repeat(301), '2026-10-24').message, /Too long/);
}

// 2. Secrets are refused, ordinary words about them are not.
{
	for (const bad of ['The key is sk-abcdefghijklmnopqrstuvwx', 'token = abcd1234efgh5678', 'AKIAABCDEFGHIJKLMNOP is the id', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '-----BEGIN RSA PRIVATE KEY-----', 'hash 0123456789abcdef0123456789abcdef01234567']) {
		assert.equal(mem.addMemory('', 'gotcha', bad, '2026-10-24').saved, false, bad);
	}
	assert.equal(mem.addMemory('', 'convention', 'API tokens are read from the keychain, never from files.', '2026-10-24').saved, true);
}

// 3. Repeats are not stored twice, even reworded in case or punctuation.
{
	const once = mem.addMemory('', 'command', 'Run the unit tests with npm test.', '2026-10-24').content;
	const again = mem.addMemory(once, 'command', 'run the unit tests with NPM test', '2026-10-25');
	assert.equal(again.saved, false);
	assert.match(again.message, /Already remembered/);
	assert.equal(mem.addMemory(once, 'command', 'Build with npm run build.', '2026-10-25').saved, true);
}

// 4. Over budget: the oldest agent-written lines go, the user's own never do.
{
	let text = '- my own note: never touch the vendor folder\n';
	for (let i = 0; i < 80; i++) {
		const r = mem.addMemory(text, 'decision', `Decision number ${i} was taken because of reason ${'xyz'.repeat(30)} ${i}.`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
		assert.equal(r.saved, true, r.message);
		text = r.content;
	}
	assert.ok(text.length <= 8_000, `file stays within budget (${text.length})`);
	assert.match(text, /my own note: never touch the vendor folder/);
	assert.match(text, /Decision number 79 /, 'the newest survives');
	assert.doesNotMatch(text, /Decision number 0 /, 'the oldest was dropped');
}
{
	const notes = '- ' + 'u'.repeat(7_990) + '\n';
	assert.match(mem.addMemory(notes, 'gotcha', 'A new fact that cannot fit.', '2026-10-24').message, /full of notes you wrote/);
}

// 5. Parsing keeps what it does not understand; rendering is one clean line each, newest kept.
{
	const entries = mem.parseMemory('# Heading\n- [gotcha] A (2026-10-24)\n- free text note\n');
	assert.deepEqual(entries.map(e => [e.type, e.text, e.date]), [[undefined, '# Heading', undefined], ['gotcha', 'A', '2026-10-24'], [undefined, 'free text note', undefined]]);
	const many = Array.from({ length: 400 }, (_, i) => ({ raw: `- [gotcha] fact ${i} ${'z'.repeat(40)}`, type: 'gotcha', text: `fact ${i} ${'z'.repeat(40)}` }));
	const out = mem.renderMemory(many);
	assert.ok(out.length <= 4_500);
	assert.match(out, /fact 399 /);
	assert.doesNotMatch(out, /fact 0 /);
	assert.doesNotMatch(mem.renderMemory([{ raw: 'x', text: 'a\n## Fake heading\nb' }]), /\n##/, 'a fact cannot start a heading');
}

// 6. The journal: one record per line, bounded, tolerant of damage.
{
	const line = mem.formatJournal({ date: '2026-10-24', goal: 'Fix  the\nbug '.repeat(40), files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`), verified: true });
	const rec = JSON.parse(line);
	assert.ok(rec.goal.length <= 160 && !rec.goal.includes('\n'));
	assert.equal(rec.files.length, 8);
	const parsed = mem.parseJournal(`${line}\n{torn\n\n${mem.formatJournal({ date: '2026-10-25', goal: 'Add tests', files: ['a.ts'], verified: false })}\n`);
	assert.equal(parsed.length, 2);
	assert.equal(mem.renderRecentWork(parsed), `- 2026-10-24: ${rec.goal}. Changed: ${rec.files.join(', ')}. Verified.\n- 2026-10-25: Add tests. Changed: a.ts. Not verified.`);
	assert.equal(mem.renderRecentWork(parsed, 1).split('\n').length, 1);
	assert.equal(mem.renderRecentWork(parsed, 0), '');
}

// 7. The block: empty for a fresh project, bounded, framed as data.
{
	assert.equal(mem.composeBlock('', ''), '');
	const block = mem.composeBlock('- [gotcha] A', '- 2026-10-24: Did it.');
	assert.match(block, /^## Project memory\n/);
	assert.match(block, /not instructions/);
	assert.match(block, /### Saved facts\n- \[gotcha\] A/);
	assert.match(block, /### Recent work in this project \(newest last\)/);
	assert.equal(mem.appendMemory('base', ''), 'base');
	assert.ok(mem.appendMemory('base', 'x'.repeat(5_000), 100).length < 250);
	assert.equal(mem.goalOf([{ role: 'user', content: 'Add a flag' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '# Current workspace state\nGit status: clean' }]), 'Add a flag');
}

// 8. On disk: first save creates the folder and a .gitignore; the block reads both stores.
{
	const memory = new mem.ProjectMemory(vs.Uri.file(ws));
	assert.equal(await memory.promptBlock(), '', 'a fresh project adds no tokens');
	const saved = await memory.remember('command', 'Run the linter with npm run lint.', '2026-10-24');
	assert.equal(saved.saved, true, saved.message);
	assert.match(fs.readFileSync(file('.stormcoder/memory.md'), 'utf8'), /\[command\] Run the linter with npm run lint\. \(2026-10-24\)/);
	assert.equal(fs.readFileSync(file('.stormcoder/.gitignore'), 'utf8'), 'memory.md\njournal.jsonl\n', 'personal memory is not committed by default');
	fs.writeFileSync(file('.stormcoder/.gitignore'), 'custom\n');
	await memory.remember('gotcha', 'Windows needs cmd.exe for the build script.', '2026-10-24');
	assert.equal(fs.readFileSync(file('.stormcoder/.gitignore'), 'utf8'), 'custom\n', 'a .gitignore the user edited is left alone');
	fs.mkdirSync(file('.openvs'), { recursive: true });
	fs.writeFileSync(file('.openvs/memory.md'), '- Legacy note kept from before the rename\n');
	await memory.appendJournal({ date: '2026-10-24', goal: 'Wire the linter', files: ['package.json'], verified: true });
	const block = await memory.promptBlock();
	assert.match(block, /Legacy note kept from before the rename/);
	assert.match(block, /Run the linter with npm run lint\./);
	assert.match(block, /- 2026-10-24: Wire the linter\. Changed: package\.json\. Verified\./);
	assert.doesNotMatch(await memory.promptBlock(0), /Recent work/, 'recentRuns 0 leaves the journal out');
	for (let i = 0; i < 450; i++) { await memory.appendJournal({ date: '2026-10-24', goal: `run ${i}`, files: [], verified: false }); }
	assert.ok(fs.readFileSync(file('.stormcoder/journal.jsonl'), 'utf8').trim().split('\n').length <= 400, 'the journal is trimmed');
	assert.ok((await memory.promptBlock()).length < 6_500, 'the block stays within its budget');
}

// 9. The remember tool: runs through approval, reports duplicates without failing, refuses secrets.
{
	fs.rmSync(file('.stormcoder'), { recursive: true, force: true });
	const asks = [];
	const approve = { confirm: async r => { asks.push(r); return { approved: true }; }, ask: async () => '' };
	const deny = { confirm: async () => ({ approved: false, feedback: 'not now' }), ask: async () => '' };
	const guard = require('../out/agent/guardrails.js').loadGuardrails();
	const ask = { ...guard, approval: 'always' };
	const yolo = { ...guard, approval: 'yolo' };
	const call = args => ({ id: '1', name: 'remember', args });

	const denied = await tools.executeTool(call({ type: 'gotcha', text: 'Do the thing.' }), deny, ask);
	assert.equal(denied.isError, true);
	assert.ok(!fs.existsSync(file('.stormcoder/memory.md')), 'a refused save writes nothing');

	const ok = await tools.executeTool(call({ type: 'gotcha', text: 'Do the thing.' }), approve, ask);
	assert.equal(ok.isError, false, ok.result);
	assert.equal(asks.length, 1);
	assert.match(asks[0].preview, /\[gotcha\] Do the thing\./);

	const dup = await tools.executeTool(call({ type: 'gotcha', text: 'do the thing' }), approve, yolo);
	assert.equal(dup.isError, false, 'a repeat is not an error the model should retry');
	assert.match(dup.result, /Already remembered/);
	assert.equal(asks.length, 1, 'auto-approve does not prompt');

	const secret = await tools.executeTool(call({ type: 'gotcha', text: 'password = hunter2hunter2' }), approve, yolo);
	assert.equal(secret.isError, true);
	assert.match(secret.result, /credential/);
	assert.equal((await tools.executeTool(call({ type: 'nope', text: 'x' }), approve, yolo)).isError, true);

	// Switched off in Settings: nothing is saved and nothing is searched.
	await vs.workspace.getConfiguration('stormcoder').update('memory.enabled', false);
	const off = await tools.executeTool(call({ type: 'gotcha', text: 'A fact while memory is off.' }), approve, yolo);
	assert.equal(off.isError, true);
	assert.match(off.result, /turned off in Settings/);
	assert.doesNotMatch(fs.readFileSync(file('.stormcoder/memory.md'), 'utf8'), /while memory is off/);
	assert.match((await tools.executeTool({ id: '1', name: 'recall', args: { query: 'thing' } }, approve, yolo)).result, /not available/);
	await vs.workspace.getConfiguration('stormcoder').update('memory.enabled', undefined);

	assert.ok(tools.AGENT_TOOLS.some(t => t.name === 'remember'));
	assert.ok(!tools.READ_ONLY_TOOL_NAMES.includes('remember'), 'Ask and Plan cannot save memory');
}

// 10. WorkLog tracks what the journal needs: files changed, and whether the last write was verified.
{
	const log = new WorkLog();
	assert.deepEqual(log.changedFiles(), []);
	log.record({ id: '1', name: 'read_file', args: { path: 'a.ts' } }, 'x', false);
	assert.deepEqual(log.changedFiles(), [], 'reading changes nothing');
	log.record({ id: '2', name: 'edit_file', args: { path: 'a.ts', oldText: 'a', newText: 'b' } }, 'ok', false);
	log.record({ id: '3', name: 'write_file', args: { path: 'b.ts', content: 'x' } }, 'denied', true);
	assert.deepEqual(log.changedFiles(), ['a.ts'], 'a failed write is not a change');
	assert.equal(log.verified(), false);
	log.record({ id: '4', name: 'run_command', args: { command: 'npm test' } }, 'ok', false);
	assert.equal(log.verified(), true);
	log.record({ id: '5', name: 'edit_file', args: { path: 'c.ts', oldText: 'a', newText: 'b' } }, 'ok', false);
	assert.equal(log.verified(), false, 'a later write needs a fresh verification');
	log.record({ id: '6', name: 'run_command', args: { command: 'git status' } }, 'clean', false);
	assert.equal(log.verified(), false, 'git status verifies nothing');
	log.record({ id: '7', name: 'run_command', args: { command: 'npm test', background: true } }, 'started', false);
	assert.equal(log.verified(), false, 'a background command has not finished');
	assert.deepEqual(log.changedFiles(), ['a.ts', 'c.ts']);
}

// 11. recall: finds older items than the prompt block carries, ranks by matching words, stays bounded.
{
	const entries = mem.parseMemory([
		'- [command] Run the linter with npm run lint. (2026-01-01)',
		'- [gotcha] Windows needs cmd.exe for the build script. (2026-01-02)',
		'- [decision] Chose sqlite over postgres for the local cache because it needs no server. (2026-01-03)',
	].join('\n'));
	const records = mem.parseJournal([
		mem.formatJournal({ date: '2026-02-01', goal: 'Add sqlite cache layer', files: ['src/cache.ts'], verified: true }),
		mem.formatJournal({ date: '2026-02-02', goal: 'Fix the login redirect', files: ['src/login.ts'], verified: false }),
	].join('\n'));
	const hit = mem.recallMemory(entries, records, 'sqlite cache');
	const lines = hit.split('\n').slice(1);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /sqlite/i);
	assert.match(hit, /Chose sqlite over postgres/);
	assert.match(hit, /Add sqlite cache layer\. Changed: src\/cache\.ts\. Verified\./);
	assert.doesNotMatch(hit, /login/);
	assert.match(mem.recallMemory(entries, records, 'login'), /Fix the login redirect\. Changed: src\/login\.ts\. Not verified\./);
	assert.match(mem.recallMemory(entries, records, 'src/cache.ts'), /Add sqlite cache layer/, 'a changed path is searchable');
	assert.match(mem.recallMemory(entries, records, 'kubernetes'), /Nothing in project memory matches "kubernetes"/);
	assert.equal(mem.recallMemory(entries, records, '', 2).split('\n').length, 3, 'an empty query lists the newest, limited');
	assert.match(mem.recallMemory(entries, records, '').split('\n')[1], /Fix the login redirect/, 'newest first');
	const big = Array.from({ length: 200 }, (_, i) => ({ raw: 'x', type: 'gotcha', text: `shared word item ${i} ${'q'.repeat(200)}` }));
	assert.ok(mem.recallMemory(big, [], 'shared', 20).length < 3_000, 'the answer is bounded');
	const tool = await tools.executeTool({ id: '1', name: 'recall', args: { query: 'linter' } }, { confirm: async () => ({ approved: false }), ask: async () => '' });
	assert.equal(tool.isError, false);
	assert.match(tool.result, /No|Nothing|matches/, 'the tool answers even with no memory file');
	assert.ok(tools.READ_ONLY_TOOL_NAMES.includes('recall'), 'Ask and Plan can recall');
}

console.log('test-memory: all assertions passed');
