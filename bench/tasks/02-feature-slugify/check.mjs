import { sh, read } from '../../lib/check-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
export default async function check(dir) {
	const notes = [];
	fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'test/slugify.hidden.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, capitalize } from '../src/index.js';
test('basic', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
test('runs and edges', () => assert.equal(slugify('  --Foo   Bar__Baz--  '), 'foo-bar-baz'));
test('empty', () => assert.equal(slugify('***'), ''));
test('others still exported', () => assert.equal(capitalize('a'), 'A'));
`);
	const t = sh(dir, 'node --test test/slugify.hidden.test.js');
	if (!t.ok) { notes.push('hidden tests failed: ' + t.out.slice(-300)); }
	const src = read(dir, 'src/strings.js');
	const documented = /\/\*\*[\s\S]*?\*\/\s*export function slugify/.test(src);
	if (!documented) { notes.push('no JSDoc on slugify (existing style)'); }
	const tabs = !/^ {2,}\S/m.test(src);
	if (!tabs) { notes.push('indented with spaces; file uses tabs'); }
	fs.rmSync(path.join(dir, 'test/slugify.hidden.test.js'));
	return { pass: t.ok && documented && tabs, notes };
}
