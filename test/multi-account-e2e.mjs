// Real UI -> encrypted credential store -> provider fallback, with local HTTP only.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChromium } from './browser.mjs';
import { startHost } from './harness.mjs';

let healthy = 'test-account-b';
const attempts = [];
const server = http.createServer((req, res) => {
	if (req.method === 'GET') {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
		return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		const key = req.headers.authorization?.replace(/^Bearer /, '');
		attempts.push(key);
		if (key !== healthy) {
			res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' }).end(JSON.stringify({ error: { message: 'daily quota exceeded' } }));
			return;
		}
		JSON.parse(body);
		const text = healthy === 'test-account-d' ? 'Agent account fallback succeeded.' : 'Chat account fallback succeeded.';
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
	});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const host = await startHost({ mockPort: server.address().port });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(host.url);
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	const card = settings.locator('.provider-card').filter({ hasText: 'Custom (Local / Self-hosted)' });
	await card.waitFor();
	for (const [i, key] of ['test-account-a', 'test-account-b', 'test-account-c'].entries()) {
		await card.locator('.key-input').fill(key);
		await card.locator('.save-key').click();
		await card.locator('.provider-accounts').getByText(`${i + 1} saved account${i ? 's' : ''}`, { exact: false }).waitFor();
		assert.equal(await card.locator('.key-input').inputValue(), '');
	}
	const claude = settings.locator('.provider-card').filter({ has: settings.locator('.sign-in-code') });
	await claude.getByRole('button', { name: 'Use authorization code', exact: true }).waitFor();
	assert.match(await claude.locator('.sign-in').innerText(), /browser/);
	await page.click('[data-view=chat]');
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').fill('Say hello using the next available account.');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Chat account fallback succeeded.').waitFor({ timeout: 20_000 });
	assert.deepEqual(attempts.slice(0, 3), ['test-account-c', 'test-account-a', 'test-account-b']);

	// Add more accounts without losing the earlier ones, then exercise the agent loop.
	healthy = 'test-account-d';
	await page.click('[data-view=settings]');
	await card.locator('.refresh-accounts').click();
	await card.locator('.provider-account-status').filter({ hasText: 'Cooling down' }).first().waitFor();
	assert.equal(await card.locator('.provider-account-status').filter({ hasText: 'Cooling down' }).count(), 2);
	for (const [i, key] of ['test-account-d', 'test-account-e', 'test-account-f'].entries()) {
		await card.locator('.key-input').fill(key);
		await card.locator('.save-key').click();
		await card.locator('.provider-accounts').getByText(`${i + 4} saved accounts`, { exact: false }).waitFor();
	}
	const beforeAgent = attempts.length;
	await page.click('[data-view=chat]');
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('Say hello. Do not change any files.');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Agent account fallback succeeded.').first().waitFor({ timeout: 20_000 });
	assert.deepEqual(attempts.slice(beforeAgent, beforeAgent + 3), ['test-account-f', 'test-account-b', 'test-account-d']);
	// Removing one account retains every other key, including those currently cooling down.
	await page.click('[data-view=settings]');
	await card.getByRole('button', { name: 'Remove API key 1', exact: true }).click();
	await card.locator('.provider-accounts').getByText('5 saved accounts', { exact: false }).waitFor();
	assert.ok(!(await card.innerText()).includes('test-account-'), 'credentials never render as text');
	assert.deepEqual(errors, []);
	for (const width of [1440, 768, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await card.scrollIntoViewIfNeeded();
		assert.ok(await card.evaluate(el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth; }), 'the account card fits the settings viewport');
		await card.screenshot({ path: path.join(os.tmpdir(), `stormcoder-accounts-${width}.png`) });
	}
	console.log('multi-account-e2e: chat, agent, account management and Claude flow choices passed');
} catch (error) {
	console.error({ attempts, host: host.log(), transcript: await browser.contexts()[0].pages()[0].frameLocator('#view-chat').locator('body').innerText() });
	throw error;
} finally {
	await browser.close();
	host.stop();
	await new Promise(resolve => server.close(resolve));
}
