// The Custom (local / self-hosted) provider against a stand-in for Ollama: a bare address works,
// the key is optional, and the failures a person hits come back as advice they can act on.
import assert from 'node:assert/strict';
import http from 'node:http';
import Module from 'node:module';

const stub = { workspace: { getConfiguration: () => ({ get: () => undefined }) }, env: {}, window: {}, Uri: { parse: s => s } };
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...rest); };
const { CustomProvider, normalizeCustomBaseUrl } = await import('../out/providers/custom.js');

// A bare address gets /v1; an address that already has a path is left alone.
assert.equal(normalizeCustomBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
assert.equal(normalizeCustomBaseUrl('http://localhost:11434/'), 'http://localhost:11434/v1');
assert.equal(normalizeCustomBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
assert.equal(normalizeCustomBaseUrl('https://gw.example.com/openai/v1'), 'https://gw.example.com/openai/v1');
assert.equal(normalizeCustomBaseUrl('  '), '');

let need = '';
let seenAuth;
const server = http.createServer((req, res) => {
	seenAuth = req.headers.authorization;
	if (need && req.headers.authorization !== `Bearer ${need}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"unauthorized"}}'); return; }
	if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'llama3.1:8b' }, { id: 'nomic-embed-text' }] })); return; }
	res.writeHead(404).end('404 page not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const provider = new CustomProvider();
const list = (url, key = '') => provider.listModels(key, url, AbortSignal.timeout(5000));
try {
	// No key: nothing is sent, and the embedding model is not offered for chat.
	assert.deepEqual((await list(`${base}/v1`)).map(m => m.id), ['llama3.1:8b']);
	assert.equal(seenAuth, undefined);
	// A server that wants a key says so, and works once it is given as a Bearer token.
	need = 'sk-secret';
	await assert.rejects(list(`${base}/v1`), /authentication failed \(HTTP 401\)/);
	assert.deepEqual((await list(`${base}/v1`, 'sk-secret')).map(m => m.id), ['llama3.1:8b']);
	assert.equal(seenAuth, 'Bearer sk-secret');
	need = '';
	// A wrong path points at the usual cause.
	await assert.rejects(list(base), /HTTP 404[\s\S]*\.\.\.\/v1/);
	// Nothing listening: say so, name the address, and keep "fetch failed" for the retry logic.
	await assert.rejects(list('http://127.0.0.1:1/v1'), err => /could not reach http:\/\/127\.0\.0\.1:1\/v1/.test(err.message) && /fetch failed/.test(err.message) && /running/.test(err.message));
	// No address at all.
	await assert.rejects(list(''), /no server address is set/);
	await assert.rejects(provider.streamChat({ baseUrl: '', apiKey: '', model: 'm', messages: [], onToken() {}, signal: AbortSignal.timeout(1000) }), /no server address is set/);
	// A cancelled request stays a cancellation.
	const aborted = AbortSignal.abort();
	await assert.rejects(provider.listModels('', `${base}/v1`, aborted), err => err.name === 'AbortError');
	console.log('All custom-provider assertions passed.');
} finally {
	server.close();
}
