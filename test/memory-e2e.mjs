// Settings > Memory in the real UI: add a project note, then share it into the committed rules file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';

const mock = await startMock(() => 'ok');
const host = await startHost({ mockPort: mock.port });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	// The first-run trust prompt may appear for the temporary project; the dev host trusts it.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area-nav button[data-area=memory]').click();
	await settings.locator('#memoryNewText').fill('Always use named exports in this codebase.');
	await settings.locator('#memoryAddBtn').click();
	const row = settings.locator('.mem-row').filter({ hasText: 'named exports' });
	await row.waitFor();
	// Sharing asks twice, because it changes who sees the note.
	await row.getByRole('button', { name: 'Share', exact: true }).click();
	assert.equal(fs.existsSync(path.join(host.project, '.stormcoder', 'rules.md')), false, 'one click changes nothing');
	await settings.locator('.mem-row').filter({ hasText: 'named exports' }).getByRole('button', { name: /move to rules\.md/ }).click();
	await settings.locator('.mem-row').filter({ hasText: 'named exports' }).waitFor({ state: 'detached', timeout: 10_000 });
	const rules = fs.readFileSync(path.join(host.project, '.stormcoder', 'rules.md'), 'utf8');
	assert.match(rules, /## Shared project notes\n- Always use named exports in this codebase\./);
	assert.doesNotMatch(fs.readFileSync(path.join(host.project, '.stormcoder', 'memory.md'), 'utf8'), /named exports/);
	// Personal notes have no Share button.
	await settings.locator('#memoryNewScope button', { hasText: 'Every project' }).click();
	await settings.locator('#memoryNewText').fill('I prefer short answers always.');
	await settings.locator('#memoryAddBtn').click();
	const mine = settings.locator('.mem-row').filter({ hasText: 'short answers' });
	await mine.waitFor();
	assert.equal(await mine.getByRole('button', { name: 'Share' }).count(), 0);
	assert.deepEqual(errors, []);
	console.log('memory-e2e: add and share a project note passed');
} catch (error) {
	console.error({ host: host.log() });
	throw error;
} finally {
	await browser.close();
	host.stop();
	mock.close();
}
