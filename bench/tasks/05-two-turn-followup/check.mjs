import { sh, read } from '../../lib/check-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
export default async function check(dir) {
	fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'test/orders.hidden.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotal } from '../src/orders.js';
test('rounds', () => assert.equal(calculateTotal([{ price: 0.1, qty: 3 }], 0), 0.3));
test('discount rounds', () => assert.equal(calculateTotal([{ price: 9.99, qty: 3 }], 15), 25.47));
`);
	const t = sh(dir, 'node --test test/orders.hidden.test.js');
	fs.rmSync(path.join(dir, 'test/orders.hidden.test.js'));
	return { pass: t.ok, notes: t.ok ? [] : ['rounding not fixed: ' + t.out.slice(-200)] };
}
