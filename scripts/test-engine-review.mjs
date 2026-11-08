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

const { workingTreeDiff, workingTreeSections, changedSections, renderSections } = await import(new URL('../out/git/repo.js', import.meta.url));

const tmpFile = text => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')), 'secret.txt'); fs.writeFileSync(f, text); return f; };
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

await test('sections: one per file, and only files this run touched are "changed"', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
	fs.writeFileSync(path.join(dir, 'c.txt'), 'sea\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	// Work that was already there when the run began.
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nbefore the run\n');
	fs.writeFileSync(path.join(dir, 'old-new.txt'), 'already here\n');
	const before = await workingTreeSections(dir);
	assert.equal(before.length, 2);
	assert.deepEqual(changedSections(before, before), [], 'nothing changed, nothing to review');

	// What the run did.
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\nby the run\n');
	fs.writeFileSync(path.join(dir, 'made.txt'), 'created by the run\n');
	const after = await workingTreeSections(dir);
	const changed = changedSections(before, after);
	const text = renderSections(changed);
	assert.match(text, /\+by the run/);
	assert.match(text, /\+created by the run/);
	assert.ok(!text.includes('before the run'), 'earlier uncommitted work in an untouched file is not charged to the run');
	assert.ok(!text.includes('already here'));
	assert.equal(changed.length, 2);

	// Editing a file that was already dirty includes that file (whole), since the run touched it.
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nbefore the run\nand the run\n');
	assert.match(renderSections(changedSections(after, await workingTreeSections(dir))), /\+and the run/);
	// Reverting what the run did leaves nothing to review.
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
	fs.rmSync(path.join(dir, 'made.txt'));
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nbefore the run\n');
	assert.deepEqual(changedSections(before, await workingTreeSections(dir)), []);
});

await test('renderSections bounds its output; with no sections it is empty', () => {
	assert.equal(renderSections([]), '');
	const big = renderSections([{ key: 'k', text: 'x'.repeat(5000) }], 1000);
	assert.ok(big.length < 1200);
	assert.match(big, /diff truncated, 5000 characters/);
});

await test('one enormous file cannot flood the result', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'line\n'.repeat(40_000));
	const sections = await workingTreeSections(dir, { maxChars: 2_000, maxNewFiles: 5, maxNewFileBytes: 1_000 });
	assert.equal(sections.length, 1);
	assert.ok(sections[0].text.length < 2_300);
	assert.match(sections[0].text, /file diff truncated/);
});

await test('an untracked symbolic link is named, never followed to what it points at', async () => {
	if (process.platform === 'win32') { return; } // creating links needs privileges there
	const outside = tmpFile('SECRET-FROM-OUTSIDE\n');
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	fs.symlinkSync(outside, path.join(dir, 'notes'));
	fs.symlinkSync(os.tmpdir(), path.join(dir, 'tmpdir'));
	const text = await workingTreeDiff(dir);
	assert.ok(!text.includes('SECRET-FROM-OUTSIDE'), 'the target\'s content never enters the diff');
	assert.match(text, /new symbolic link notes \(not followed\)/);
	assert.match(text, /new symbolic link tmpdir \(not followed\)/);
});

await test('files and folders whose names start with two dots are part of the diff', async () => {
	const dir = repo();
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'init');
	fs.mkdirSync(path.join(dir, '..cache'));
	fs.writeFileSync(path.join(dir, '..cache', 'x.txt'), 'in a dotted folder\n');
	assert.match(await workingTreeDiff(dir), /\+in a dotted folder/);
});

console.log(`engine review: ${passed} tests, all assertions passed`);
