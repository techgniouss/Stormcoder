// The Custom (local / self-hosted) card as a person uses it: type a bare server address, test the
// connection, pick up the server's models, chat with no API key, and see a clear message when the
// server goes away. A stand-in Ollama serves /v1 only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchChromium } from './browser.mjs';
import { startHost } from './harness.mjs';

const urls = [];
const auth = [];
const server = http.createServer((req, res) => {
	urls.push(`${req.method} ${req.url}`);
	auth.push(req.headers.authorization);
	if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5-coder:7b' }] })); return; }
	if (req.url === '/v1/chat/completions' && req.method === 'POST') {
		req.resume();
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the local model.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
		});
		return;
	}
	res.writeHead(404).end('404 page not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const host = await startHost({ mockPort: port, settings: { 'stormcoder.custom.baseUrl': '', 'stormcoder.custom.model': 'llama3.2:3b' } });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	const card = settings.locator('.provider-card').filter({ hasText: 'Custom (Local' });
	await card.waitFor();
	// The address is a visible field, there is no browser sign-in, and the key says it is optional.
	await card.locator('.base-url-input').waitFor({ state: 'visible' });
	assert.equal(await card.locator('.sign-in').count(), 0);
	assert.match(await card.innerText(), /API key \(optional\)/);
	assert.match(await card.innerText(), /Ollama/);
	// With no address, Test connection says what to do.
	await card.locator('.test-key').click();
	await card.locator('.test-result.bad').filter({ hasText: /no server address is set/ }).waitFor({ timeout: 10_000 });
	// A bare address (no /v1) is accepted; the connection test reaches the right path.
	await card.locator('.base-url-input').fill(`http://127.0.0.1:${port}`);
	await card.locator('.save-base-url').click();
	await settings.locator('.provider-card').filter({ hasText: 'Custom (Local' }).locator('.base-url-input').waitFor();
	await card.locator('.test-key').click();
	await card.locator('.test-result.ok').filter({ hasText: 'Connected — 2 models' }).waitFor({ timeout: 10_000 });
	assert.ok(urls.includes('GET /v1/models'), urls.join(', '));
	assert.ok(auth.every(a => a === undefined), 'no key was sent');
	// Chat works with no key, on the model the server listed.
	await page.click('[data-view=chat]');
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').fill('Say hello.');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Hello from the local model.').waitFor({ timeout: 20_000 });
	assert.ok(urls.includes('POST /v1/chat/completions'));
	// The server going away is explained, not "fetch failed".
	server.close();
	server.closeAllConnections();
	await chat.locator('#input').fill('Still there?');
	await chat.locator('#input').press('Enter');
	await chat.getByText(/could not reach http:\/\/127\.0\.0\.1:\d+\/v1/).first().waitFor({ timeout: 20_000 });
	assert.deepEqual(errors, []);
	console.log('custom-e2e: address, test connection, keyless chat and unreachable-server message passed');
} catch (error) {
	console.error({ urls, host: host.log() });
	throw error;
} finally {
	await browser.close();
	host.stop();
	server.close();
}
