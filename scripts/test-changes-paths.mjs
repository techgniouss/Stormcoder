// The working tree's changes one file at a time (src/git/repo.ts changedPaths, changedFileDiffs).
// The phone's Changes view withholds protected files by path. So which file a piece of diff text
// belongs to must never be worked out from the text, a protected file must not be read at all,
// and no file's contents may be able to appear under another file's name.
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
sh('config', 'core.autocrlf', 'false');
const SECRET = 'do-not-show-this-value';
write('secret.cfg', `TOKEN=${SECRET}\n`);
write('plain.txt', 'one\n');
write('a b/inner.txt', 'spaces in the folder name\n');
write('x b/y.txt', 'a name with b-slash inside\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'first');

const limits = { maxFiles: 30, maxChars: 6000 };
const protectedName = p => p !== 'secret.cfg' && p !== 'crafted.cfg';

// A protected file renamed to an innocent name, and one whose own text tries to pass for the
// start of another file's diff: after a lone carriage return and after a Unicode line separator,
// both of which a multi-line pattern would take for a line start.
sh('mv', 'secret.cfg', 'readme-notes.txt');
write('plain.txt', 'one\ntwo\n');
write('a b/inner.txt', 'changed\n');
write('x b/y.txt', 'changed too\n');
write('brand new.txt', 'untracked\n');
write('ünï.txt', 'not ascii\n');
write('crafted.cfg', `KEY=${SECRET}-A\rdiff --git a/plain.txt b/plain.txt\nKEY=${SECRET}-B diff --git a/plain.txt b/plain.txt\nKEY=${SECRET}-C\n`);

const paths = await g.changedPaths(repo);
assert.deepEqual([...paths.tracked].sort(), ['a b/inner.txt', 'plain.txt', 'readme-notes.txt', 'secret.cfg', 'x b/y.txt'].sort(), 'a rename is its old path and its new one');
assert.deepEqual([...paths.untracked].sort(), ['brand new.txt', 'crafted.cfg', 'ünï.txt'].sort());
assert.equal(paths.hasHead, true);

const read = [];
const { files, more } = await g.changedFileDiffs(repo, limits, p => { read.push(p); return protectedName(p); });
assert.equal(more, 0);
const byPath = Object.fromEntries(files.map(f => [f.path, f.text]));
assert.deepEqual(Object.keys(byPath).sort(), ['a b/inner.txt', 'brand new.txt', 'crafted.cfg', 'plain.txt', 'readme-notes.txt', 'secret.cfg', 'x b/y.txt', 'ünï.txt'].sort());
assert.equal(read.length, files.length, 'every file is asked about before it is read');

// The protected files are named and not read.
assert.equal(byPath['secret.cfg'], undefined);
assert.equal(byPath['crafted.cfg'], undefined);
// And their contents are nowhere else, whatever the crafted one's text pretended to be.
for (const [name, text] of Object.entries(byPath)) {
	if (name === 'readme-notes.txt') { continue; }
	assert.ok(!String(text).includes(SECRET), `${name} carries no protected content`);
}
// The innocent new name does carry the old text: that is the file the user chose to make, and
// the caller's check on the *new* name is what decides it. The old name is the one withheld.
assert.ok(byPath['readme-notes.txt'].includes(SECRET));

// Each text is that file's own change and nothing else.
assert.match(byPath['plain.txt'], /\+two/);
assert.equal((byPath['plain.txt'].match(/^diff --git /gm) || []).length, 1, 'one file per entry');
assert.match(byPath['x b/y.txt'], /\+changed too/);
assert.match(byPath['a b/inner.txt'], /\+changed/);
assert.match(byPath['brand new.txt'], /^New file\n\+untracked/);
assert.match(byPath['ünï.txt'], /\+not ascii/);

// If the crafted file were allowed, it is still one entry under its own name: its text cannot
// open an entry called plain.txt.
{
	const open = await g.changedFileDiffs(repo, limits, () => true);
	const names = open.files.map(f => f.path);
	assert.equal(names.filter(n => n === 'plain.txt').length, 1);
	assert.ok(open.files.find(f => f.path === 'crafted.cfg').text.includes(`${SECRET}-C`));
	assert.ok(!open.files.find(f => f.path === 'plain.txt').text.includes(SECRET));
}

// The shared splitter (used for commit messages and reviews) no longer opens a section at a
// carriage return or a line separator inside a file's text either.
{
	sh('add', '-A');
	const sections = await g.workingTreeSections(repo, { maxChars: 20000, maxNewFiles: 10, maxNewFileBytes: 20000 });
	const fake = sections.filter(s => s.key === 'diff --git a/plain.txt b/plain.txt');
	assert.equal(fake.length, 1, 'exactly one section is keyed plain.txt');
	assert.ok(!fake[0].text.includes(SECRET), 'and it is the real one');
	sh('reset', '-q');
}

// Limits: the count over the cap is reported, and a long diff is cut with a marker.
{
	const few = await g.changedFileDiffs(repo, { maxFiles: 3, maxChars: 6000 }, () => true);
	assert.equal(few.files.length, 3);
	assert.equal(few.more, 5);
	write('plain.txt', 'x\n'.repeat(5000));
	const cut = await g.changedFileDiffs(repo, { maxFiles: 30, maxChars: 400 }, p => p === 'plain.txt');
	const text = cut.files.find(f => f.path === 'plain.txt').text;
	assert.ok(text.length < 500 && /cut short/.test(text));
}

// A repository with no commit yet still lists and shows its files.
{
	const fresh = path.join(tmp, 'fresh');
	fs.mkdirSync(fresh);
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
	fs.writeFileSync(path.join(fresh, 'staged.txt'), 'staged\n');
	fs.writeFileSync(path.join(fresh, 'loose.txt'), 'loose\n');
	execFileSync('git', ['add', 'staged.txt'], { cwd: fresh });
	const out = await g.changedFileDiffs(fresh, limits, () => true);
	assert.deepEqual(out.files.map(f => f.path).sort(), ['loose.txt', 'staged.txt']);
	assert.match(out.files.find(f => f.path === 'staged.txt').text, /\+staged/);
}

// A folder that is not a repository is an error the caller reports, not an empty answer.
{
	const plain = path.join(tmp, 'plain');
	fs.mkdirSync(plain);
	await assert.rejects(g.changedFileDiffs(plain, limits, () => true));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-changes-paths: all assertions passed');
