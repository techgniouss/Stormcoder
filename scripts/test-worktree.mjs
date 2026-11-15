// Per-chat git worktrees (src/git/repo.ts): the branch name, creating one from HEAD, telling
// whether it has uncommitted work, and removing it without ever forcing.
//   node scripts/build-tests.mjs && node scripts/test-worktree.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const g = await import(new URL('../out/git/repo.js', import.meta.url));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-wt-')));
const rejects = (p, pattern) => assert.rejects(p, e => e instanceof g.GitError && pattern.test(e.message));

// Branch names: always a valid ref, whatever the title holds.
assert.equal(g.worktreeBranchName('Fix the login bug!', 'ab12cd34ef'), 'stormcoder/fix-the-login-bug-ab12cd34');
assert.equal(g.worktreeBranchName('', 'id7'), 'stormcoder/chat-id7');
assert.equal(g.worktreeBranchName('../../etc ~^:?*[ \\ ..lock', 'ID_9'), 'stormcoder/etc-lock-id-9');
assert.equal(g.worktreeBranchName('日本語だけ', ''), 'stormcoder/chat-x');
assert.equal(g.worktreeBranchName('a'.repeat(80) + ' tail', 'z'), `stormcoder/${'a'.repeat(32)}-z`);
assert.equal(g.worktreeBranchName('thirty-one characters long title- more', 'q'), 'stormcoder/thirty-one-characters-long-title-q', 'no trailing dash after the cut');

// Not a repository, and a repository with no commit yet.
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
await rejects(g.addWorktree(plain, path.join(tmp, 'wt-plain'), 'stormcoder/x-1'), /not one/);
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'config', 'user.name', 'Test');
sh(repo, 'config', 'user.email', 'test@example.com');
await rejects(g.addWorktree(repo, path.join(tmp, 'wt-empty'), 'stormcoder/x-1'), /at least one commit/);
assert.equal(fs.existsSync(path.join(tmp, 'wt-empty')), false);

fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
sh(repo, 'add', '-A');
sh(repo, 'commit', '-q', '-m', 'first');
fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted in the project\n');

// A worktree is cut from HEAD on its own branch; the project's uncommitted work is not in it.
const dir = path.join(tmp, 'worktrees', 'key', 'chat1');
const wt = await g.addWorktree(path.join(repo), dir, 'stormcoder/first-chat1');
assert.deepEqual(wt, { path: dir, branch: 'stormcoder/first-chat1' });
assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'stormcoder/first-chat1');
assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the project stays on its branch');
assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'uncommitted in the project\n', 'and keeps its uncommitted work');

// The same folder or the same branch twice is refused; so is a name git would not accept.
await rejects(g.addWorktree(repo, dir, 'stormcoder/other-1'), /already exists/);
await rejects(g.addWorktree(repo, path.join(tmp, 'worktrees', 'key', 'chat2'), 'stormcoder/first-chat1'), /already exists|already used|exists/i);
await rejects(g.addWorktree(repo, path.join(tmp, 'worktrees', 'key', 'chat3'), 'bad..name'), /valid branch name/);
assert.equal(fs.existsSync(path.join(tmp, 'worktrees', 'key', 'chat3')), false);

// Dirty: untracked, changed and staged files all count; ignored files do not.
assert.equal(await g.worktreeDirty(dir), false);
fs.mkdirSync(path.join(dir, 'ignored'));
fs.writeFileSync(path.join(dir, 'ignored', 'x'), 'x');
assert.equal(await g.worktreeDirty(dir), false, 'an ignored file is not work to lose');
fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
assert.equal(await g.worktreeDirty(dir), true);

// Removing a worktree with uncommitted work is refused, and nothing is deleted.
await rejects(g.removeWorktree(repo, dir), /./);
assert.equal(fs.existsSync(path.join(dir, 'new.txt')), true);

// Committed work lives on the branch; the folder can then go and the branch stays.
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'work in the chat');
fs.rmSync(path.join(dir, 'ignored'), { recursive: true });
assert.equal(await g.worktreeDirty(dir), false);
await g.removeWorktree(repo, dir);
assert.equal(fs.existsSync(dir), false);
assert.match(sh(repo, 'branch', '--list', 'stormcoder/first-chat1'), /stormcoder\/first-chat1/);
assert.match(sh(repo, 'log', '-1', '--format=%s', 'stormcoder/first-chat1'), /work in the chat/);
assert.doesNotMatch(sh(repo, 'worktree', 'list'), /chat1/);

// A folder that is already gone is only pruned.
const gone = path.join(tmp, 'worktrees', 'key', 'chat4');
await g.addWorktree(repo, gone, 'stormcoder/gone-4');
fs.rmSync(gone, { recursive: true, force: true });
await g.removeWorktree(repo, gone);
assert.doesNotMatch(sh(repo, 'worktree', 'list'), /chat4/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-worktree: all assertions passed');
