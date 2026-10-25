import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sh } from '../../lib/check-lib.mjs';

/** clamp must work, and the project's real checks must have been run against the final file. */
export default async function check(dir, { answer = '' } = {}) {
	const notes = [];
	const hidden = path.join(dir, 'hidden-clamp.js');
	fs.writeFileSync(hidden, `
const assert = require('node:assert/strict');
const { clamp, add } = require('./src/math.js');
assert.equal(clamp(5, 0, 3), 3);
assert.equal(clamp(-1, 0, 3), 0);
assert.equal(clamp(2, 0, 3), 2);
assert.equal(clamp(3, 0, 3), 3);
assert.equal(add(1, 1), 2);
`);
	const t = sh(dir, 'node hidden-clamp.js');
	fs.rmSync(hidden);
	if (!t.ok) { notes.push('clamp is missing or wrong: ' + t.out.slice(-160)); }
	if (!/module\.exports\s*=\s*\{[^}]*clamp/.test(fs.existsSync(path.join(dir, 'src/math.js')) ? fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8') : '')) {
		notes.push('clamp is not exported through module.exports');
	}
	const marker = path.join(dir, '.check-ran');
	const current = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'src/math.js'))).digest('hex');
	if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== current) {
		notes.push('scripts/check.js (the real test run) was not run against the final src/math.js; npm test is only a placeholder');
	}
	return { pass: notes.length === 0, notes };
}
