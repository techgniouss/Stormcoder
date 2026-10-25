/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/git/repo.ts against real temporary repositories (git must be installed).
//   node scripts/build-tests.mjs && node scripts/test-git.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const g = await import(new URL('../out/git/repo.js', import.meta.url));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-git-'));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const rejects = async (p, kind) => { await assert.rejects(p, e => e instanceof g.GitError && (!kind || e.kind === kind), `expected GitError ${kind ?? ''}`); };

// A folder that is not a repository is a result, not an error.
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
write(plain, 'a.txt', 'x\n');
let s = await g.status(plain);
assert.equal(s.isRepo, false);
assert.deepEqual((await g.listFiles(plain)).files, ['a.txt'], 'a plain folder is listed by walking it');

// Path safety.
for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'C:/x', '.git/config', 'a/.git/hooks', 'a\0b']) {
	assert.throws(() => g.safeRelPath(bad), g.GitError, `rejects ${JSON.stringify(bad)}`);
}
assert.equal(g.safeRelPath('src\\a.ts'), 'src/a.ts');

// A fresh repository with one commit.
const bare = path.join(tmp, 'remote.git');
sh(tmp, 'init', '--bare', '-q', '-b', 'main', bare);
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'config', 'user.name', 'Test');
sh(repo, 'config', 'user.email', 'test@example.com');
write(repo, 'one.txt', 'line1\nline2\nline3\n');
write(repo, 'src/two.ts', 'export const a = 1;\n');
sh(repo, 'add', '.');
sh(repo, 'commit', '-q', '-m', 'first');

s = await g.status(repo);
assert.equal(s.isRepo, true);
assert.equal(s.branch, 'main');
assert.equal(s.files.length, 0);
assert.equal(s.upstream, undefined);

// Modified, untracked, deleted: each lands in the right group with counts.
write(repo, 'one.txt', 'line1\nCHANGED\nline3\nline4\n');
write(repo, 'new.txt', 'brand new\n');
fs.rmSync(path.join(repo, 'src/two.ts'));
s = await g.status(repo);
const by = Object.fromEntries(s.files.map(f => [f.path, f]));
assert.equal(by['one.txt'].status, 'M');
assert.equal(by['one.txt'].unstaged, true);
assert.equal(by['one.txt'].staged, false);
assert.equal(by['one.txt'].added, 2);
assert.equal(by['one.txt'].removed, 1);
assert.equal(by['new.txt'].untracked, true);
assert.equal(by['new.txt'].status, 'A');
assert.equal(by['src/two.ts'].status, 'D');

// Diff: rows carry line numbers; untracked shows the whole file as added.
let d = await g.diff(repo, 'one.txt', 'unstaged');
assert.equal(d.binary, false);
assert.ok(d.rows.some(r => r.k === 'h'));
assert.ok(d.rows.some(r => r.k === 'd' && r.t === 'line2' && r.o === 2));
assert.ok(d.rows.some(r => r.k === 'a' && r.t === 'CHANGED' && r.n === 2));
d = await g.diff(repo, 'new.txt', 'untracked');
assert.deepEqual(d.rows.filter(r => r.k === 'a').map(r => r.t), ['brand new']);
await rejects(g.diff(repo, '../outside', 'unstaged'), 'path');

// File text, and the refusals.
assert.equal((await g.fileText(repo, 'new.txt')).text, 'brand new\n');
await rejects(g.fileText(repo, '.git/config'), 'path');
fs.symlinkSync('/etc/hostname', path.join(repo, 'link.txt'));
await rejects(g.fileText(repo, 'link.txt'), 'path');
fs.rmSync(path.join(repo, 'link.txt'));
write(repo, 'bin.dat', Buffer.from([0, 1, 2, 3]).toString('latin1'));
fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
assert.equal((await g.fileText(repo, 'bin.dat')).binary, true);
fs.rmSync(path.join(repo, 'bin.dat'));

// Staging and unstaging.
await g.stage(repo, ['one.txt', 'new.txt', 'src/two.ts']);
s = await g.status(repo);
assert.ok(s.files.every(f => f.staged && !f.unstaged), 'all three are staged, deletion included');
d = await g.diff(repo, 'one.txt', 'staged');
assert.ok(d.rows.some(r => r.k === 'a' && r.t === 'CHANGED'));
await g.unstage(repo, ['new.txt']);
s = await g.status(repo);
assert.equal(s.files.find(f => f.path === 'new.txt').staged, false);
assert.equal(s.files.find(f => f.path === 'one.txt').staged, true);

// Commit: needs a message and staged files; the identity error is classified.
await rejects(g.commit(repo, '   '), 'nothing');
const empty = path.join(tmp, 'empty');
fs.mkdirSync(empty);
sh(empty, 'init', '-q');
await rejects(g.commit(empty, 'msg'), 'nothing');
const c = await g.commit(repo, 'Change one and remove two\n\nbody text');
assert.match(c.hash, /^[0-9a-f]{7,}$/);
assert.equal(sh(repo, 'log', '-1', '--format=%s').trim(), 'Change one and remove two');
s = await g.status(repo);
assert.equal(s.unpushed.length, 2, 'both commits are local (no upstream yet)');
assert.equal(s.canUndoCommit, true);

// A hook that refuses is reported, and the files stay staged.
await g.stage(repo, ['new.txt']);
const hook = path.join(repo, '.git/hooks/pre-commit');
fs.writeFileSync(hook, '#!/bin/sh\necho "lint: nope" >&2\nexit 1\n', { mode: 0o755 });
await rejects(g.commit(repo, 'blocked'), 'hook');
assert.equal((await g.status(repo)).files.find(f => f.path === 'new.txt').staged, true);
fs.rmSync(hook);

// Undo takes the newest local commit back, keeping its changes staged.
await g.commit(repo, 'Add new');
await g.undoCommit(repo);
s = await g.status(repo);
assert.equal(s.files.find(f => f.path === 'new.txt').staged, true);
assert.equal(s.unpushed.length, 2);
await g.commit(repo, 'Add new');

// Push: no remote, publish creates the upstream, a plain push then sends the next commit.
await rejects(g.push(repo, false), 'no-remote');
await rejects(g.push(repo, true), 'no-remote');
sh(repo, 'remote', 'add', 'origin', bare);
await rejects(g.push(repo, false), 'no-remote');
const pub = await g.push(repo, true);
assert.equal(pub.target, 'origin/main');
s = await g.status(repo);
assert.equal(s.upstream, 'origin/main');
assert.equal(s.unpushed.length, 0);
assert.equal(s.canUndoCommit, false, 'a pushed commit cannot be undone');
await rejects(g.undoCommit(repo), 'nothing');
write(repo, 'more.txt', 'more\n');
await g.stage(repo, ['more.txt']);
await g.commit(repo, 'More');
assert.equal((await g.status(repo)).ahead, 1);
assert.equal((await g.push(repo, false)).target, 'origin/main');

// Another clone pushes first: ours is rejected, and a fast-forward pull then fixes nothing
// until we have merged, so pull refuses rather than creating a merge.
const other = path.join(tmp, 'other');
sh(tmp, 'clone', '-q', bare, other);
sh(other, 'config', 'user.name', 'Other');
sh(other, 'config', 'user.email', 'o@example.com');
write(other, 'theirs.txt', 't\n');
sh(other, 'add', '.');
sh(other, 'commit', '-q', '-m', 'theirs');
sh(other, 'push', '-q');
write(repo, 'mine.txt', 'm\n');
await g.stage(repo, ['mine.txt']);
await g.commit(repo, 'Mine');
await rejects(g.push(repo, false), 'rejected');
await assert.rejects(g.pull(repo), 'diverged history is not fast-forwarded');
sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
await g.pull(repo);
assert.ok(fs.existsSync(path.join(repo, 'theirs.txt')), 'pull fast-forwards when it can');

// Merge conflicts show up as conflicts and block commit.
sh(repo, 'checkout', '-q', '-b', 'side');
write(repo, 'one.txt', 'side\n');
sh(repo, 'commit', '-qam', 'side');
sh(repo, 'checkout', '-q', 'main');
write(repo, 'one.txt', 'main\n');
sh(repo, 'commit', '-qam', 'main');
try { sh(repo, 'merge', 'side'); } catch { /* conflicts are expected */ }
s = await g.status(repo);
assert.equal(s.merging, true);
assert.equal(s.files.find(f => f.path === 'one.txt').conflict, true);
await rejects(g.commit(repo, 'nope'), 'conflict');
await g.abortMerge(repo);
assert.equal((await g.status(repo)).merging, false);

// Files tab: tracked and untracked, never ignored.
write(repo, '.gitignore', 'ignored.txt\n');
write(repo, 'ignored.txt', 'x');
const list = await g.listFiles(repo);
assert.ok(list.files.includes('theirs.txt') && list.files.includes('.gitignore'));
assert.ok(!list.files.includes('ignored.txt'));

// The staged diff for drafting a message.
await g.stage(repo, ['.gitignore']);
assert.match(await g.stagedDiff(repo), /\+ignored\.txt/);

// A subfolder of a repository reports root-relative paths.
write(repo, 'src/deep/x.ts', 'x\n');
s = await g.status(path.join(repo, 'src'));
assert.equal(s.isRepo, true);
assert.ok(s.files.some(f => f.path === 'src/deep/x.ts'));
assert.equal(s.prefix, 'src', 'the folder opened inside the repository is reported');
assert.equal((await g.status(repo)).prefix, '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-git: all assertions passed');
