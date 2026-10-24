import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/http.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('returns the parsed body', async () => {
	assert.deepEqual(await fetchJson('x', { fetch: async () => reply(200, { a: 1 }) }), { a: 1 });
});

test('throws with the status on a failure', async () => {
	await assert.rejects(fetchJson('x', { fetch: async () => reply(404, {}) }), e => e.status === 404);
});
