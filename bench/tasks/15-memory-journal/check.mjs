import fs from 'node:fs';
import path from 'node:path';
import { sh } from '../../lib/check-lib.mjs';

/** The unfinished retry support must now work, and the existing tests must still pass. */
export default async function check(dir) {
	fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
	const hidden = path.join(dir, 'test/retry.hidden.test.js');
	fs.writeFileSync(hidden, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/http.js';
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sequence = (...steps) => { let n = 0; const f = async () => { const s = steps[Math.min(n++, steps.length - 1)]; if (s instanceof Error) { throw s; } return s; }; f.calls = () => n; return f; };

test('retries a 5xx until it succeeds', async () => {
	const f = sequence(reply(503, {}), reply(503, {}), reply(200, { ok: 1 }));
	assert.deepEqual(await fetchJson('x', { fetch: f, retries: 2 }), { ok: 1 });
	assert.equal(f.calls(), 3);
});
test('gives up after the retries and reports the status', async () => {
	const f = sequence(reply(500, {}));
	await assert.rejects(fetchJson('x', { fetch: f, retries: 2 }), e => e.status === 500);
	assert.equal(f.calls(), 3);
});
test('retries a network error', async () => {
	const f = sequence(new Error('socket hang up'), reply(200, { v: 2 }));
	assert.deepEqual(await fetchJson('x', { fetch: f, retries: 1 }), { v: 2 });
});
test('never retries a 4xx', async () => {
	const f = sequence(reply(404, {}), reply(200, {}));
	await assert.rejects(fetchJson('x', { fetch: f, retries: 3 }), e => e.status === 404);
	assert.equal(f.calls(), 1);
});
test('no retries by default', async () => {
	const f = sequence(reply(503, {}), reply(200, {}));
	await assert.rejects(fetchJson('x', { fetch: f }));
	assert.equal(f.calls(), 1);
});
`);
	const t = sh(dir, 'node --test');
	fs.rmSync(hidden);
	return { pass: t.ok, notes: t.ok ? [] : ['retry support is missing or wrong: ' + t.out.slice(-240)] };
}
