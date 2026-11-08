/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for `workingTreeDiff` in src/git/repo.ts, the text a post-run review is given: edits
// since the last commit plus new files, read-only, bounded. Runs against a real git repository.
//   node scripts/build-tests.mjs && node scripts/test-engine-review.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { workingTreeDiff } = await import(new URL('../out/git/repo.js', import.meta.url));

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const repo = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-'));
	git(dir, 'init', '-q');
	return dir;
};

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		console.error(`FAIL ${name}`);
		throw err;
	}
}

await test('a clean tree has an empty diff', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	assert.equal((await workingTreeDiff(dir)).trim(), '');
});

await test('staged edits, unstaged edits and new files all appear, and the index is left alone', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
	git(dir, 'add', 'a.txt');
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\nsting\n');
	fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\nlines\n');
	const before = git(dir, 'status', '--porcelain');
	const diff = await workingTreeDiff(dir);
	assert.match(diff, /\+two/);
	assert.match(diff, /\+sting/);
	assert.match(diff, /diff --git a\/new\.txt b\/new\.txt/);
	assert.match(diff, /\+fresh/);
	assert.equal(git(dir, 'status', '--porcelain'), before, 'reading the diff changes nothing');
});

await test('a repository with no commit yet still works', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
	git(dir, 'add', 'a.txt');
	fs.writeFileSync(path.join(dir, 'u.txt'), 'untracked\n');
	const diff = await workingTreeDiff(dir);
	assert.match(diff, /\+staged/);
	assert.match(diff, /\+untracked/);
});

await test('ignored files are left out; binary and oversized new files are named, not shown', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	fs.writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=abc\n');
	fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
	fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(30_000));
	const diff = await workingTreeDiff(dir);
	assert.ok(!diff.includes('TOKEN=abc'), 'a git-ignored file is never shown');
	assert.match(diff, /new binary file blob\.bin/);
	assert.match(diff, /new file big\.txt \(30000 bytes, not shown\)/);
});

await test('the result and the number of new files are bounded', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	for (let i = 0; i < 8; i++) { fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}\n`.repeat(50)); }
	const small = await workingTreeDiff(dir, { maxChars: 500, maxNewFiles: 3, maxNewFileBytes: 20_000 });
	assert.ok(small.length < 700);
	assert.match(small, /diff truncated/);
	const few = await workingTreeDiff(dir, { maxChars: 100_000, maxNewFiles: 3, maxNewFileBytes: 20_000 });
	assert.match(few, /and 5 more new file\(s\)/);
});

await test('a folder that is not a repository is an error the caller can treat as "nothing to review"', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
	await assert.rejects(workingTreeDiff(dir));
});

console.log(`engine review: ${passed} tests, all assertions passed`);
