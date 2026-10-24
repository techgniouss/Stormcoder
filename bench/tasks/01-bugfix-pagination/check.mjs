import { sh, sha } from '../../lib/check-lib.mjs';
import path from 'node:path';
import fs from 'node:fs';
export default async function check(dir, ctx) {
	const notes = [];
	const untouched = ctx.original ? sha(path.join(dir, 'test/paginate.test.js')) === sha(path.join(ctx.original, 'test/paginate.test.js')) : true;
	if (!untouched) { notes.push('the test file was modified'); }
	const t = sh(dir, 'node --test');
	if (!t.ok) { notes.push('tests still failing'); }
	return { pass: untouched && t.ok, notes };
}
