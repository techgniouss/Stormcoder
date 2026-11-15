// Which file a diff section is about (src/git/repo.ts changedPaths, pathOfSection). The phone's
// Changes view withholds protected files by path, so a section must be tied to exactly one path
// without parsing the diff's header, and anything uncertain must come out as "unknown".
//   node scripts/build-tests.mjs && node scripts/test-changes-paths.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const g = await import(new URL('../out/git/repo.js', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-chg-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const sh = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
sh('init', '-q', '-b', 'main');
sh('config', 'user.name', 'Test');
sh('config', 'user.email', 'test@example.com');
const secret = 'TOKEN=do-not-show-this-value\n';
write('secret.cfg', secret);
write('plain.txt', 'one\n');
write('a b/inner.txt', 'spaces in the folder name\n');
write('x b/y.txt', 'a name that contains " b/"\n'.replace('"', '').replace('"', ''));
sh('add', '-A');
sh('commit', '-q', '-m', 'first');

// The header of a section is compared whole; it is never taken apart.
assert.equal(g.pathOfSection('diff --git a/plain.txt b/plain.txt', ['plain.txt']), 'plain.txt');
assert.equal(g.pathOfSection('new file notes.md', ['notes.md']), 'notes.md');
assert.equal(g.pathOfSection('diff --git a/x b/y.txt b/x b/y.txt', ['x b/y.txt', 'x', 'y.txt']), 'x b/y.txt');
for (const [key, paths] of [
	['diff --git a/old.txt b/new.txt', ['old.txt', 'new.txt']],          // a rename names two files
	['diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"', ['we"ird.txt']],   // a name git had to quote
	['diff --git a/plain.txt b/plain.txt', []],                           // not a path git listed
	['diff --git a/plain.txt b/plain.txt extra', ['plain.txt']],
	['more new files', ['more new files']],
	['', ['']],
]) {
	assert.equal(g.pathOfSection(key, paths), undefined, `uncertain: ${key}`);
}

// A protected file renamed to an innocent name: with renames split, the deletion is its own
// section under the old name, so a caller that checks the name withholds the old contents.
sh('mv', 'secret.cfg', 'readme-notes.txt');
write('plain.txt', 'one\ntwo\n');
write('a b/inner.txt', 'changed\n');
write('x b/y.txt', 'changed too\n');
write('brand new.txt', 'untracked\n');
write('ünï.txt', 'not ascii\n');

const paths = await g.changedPaths(repo);
assert.deepEqual([...paths].sort(), ['a b/inner.txt', 'brand new.txt', 'plain.txt', 'readme-notes.txt', 'secret.cfg', 'x b/y.txt', 'ünï.txt'].sort());

const split = await g.workingTreeSections(repo, { maxChars: 6000, maxNewFiles: 10, maxNewFileBytes: 6000, noRenames: true });
const named = split.map(section => ({ name: g.pathOfSection(section.key, paths), text: section.text }));
// Every section that carries the secret is tied to the path it came from, or to no path at all.
const carrying = named.filter(s => s.text.includes('do-not-show-this-value'));
assert.ok(carrying.length >= 1, 'the old contents are in the diff');
for (const s of carrying) {
	assert.ok(s.name === 'secret.cfg' || s.name === 'readme-notes.txt' || s.name === undefined, `the secret is under ${s.name}`);
}
assert.ok(carrying.some(s => s.name === 'secret.cfg'), 'the deletion is a section of its own, under the protected name');
// A name with a space, or with " b/" inside it, is still tied to the right file.
assert.equal(named.find(s => s.text.includes('changed too'))?.name, 'x b/y.txt');
assert.equal(named.find(s => s.text.includes('+changed\n') || s.text.includes('+changed\r'))?.name, 'a b/inner.txt');
assert.equal(named.find(s => s.text.includes('untracked'))?.name, 'brand new.txt');

// Without the split, the rename is one section naming two files, which cannot be tied to one.
const joined = await g.workingTreeSections(repo, { maxChars: 6000, maxNewFiles: 10, maxNewFileBytes: 6000 });
const rename = joined.find(s => s.key.includes('secret.cfg') && s.key.includes('readme-notes.txt'));
if (rename) {
	assert.equal(g.pathOfSection(rename.key, paths), undefined, 'a two-name header matches no single path');
}

// A repository's own config cannot make git start a program: fsmonitor is off for every call.
const marker = path.join(tmp, 'ran.txt');
const hook = path.join(tmp, process.platform === 'win32' ? 'hook.cmd' : 'hook.sh');
fs.writeFileSync(hook, process.platform === 'win32' ? `@echo ran> "${marker}"\r\n` : `#!/bin/sh\necho ran > "${marker}"\n`);
fs.chmodSync(hook, 0o755);
sh('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
await g.status(repo);
await g.changedPaths(repo);
await g.workingTreeSections(repo, { maxChars: 6000, maxNewFiles: 10, maxNewFileBytes: 6000 });
assert.equal(fs.existsSync(marker), false, 'the configured fsmonitor program was not started');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-changes-paths: all assertions passed');
