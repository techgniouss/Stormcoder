// The update flow in the real shell: a release is found, downloads in the background, is
// highlighted, and installs on request. The dev host fakes the release (MJ_FAKE_UPDATE).
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';

const mock = await startMock(() => 'ok');
const browser = await launchChromium();

/** Opens the shell against a host that finds `version` (or nothing, for "none"). */
async function open(version) {
	const host = await startHost({ mockPort: mock.port, env: { MJ_FAKE_UPDATE: version } });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	await page.locator('#markBtn').waitFor();
	return { host, page, errors };
}

try {
	// A new release: manual check, background download, highlighted as ready, then installed.
	{
		const { host, page, errors } = await open('9.9.9');
		assert.equal(await page.locator('#updatePill').isHidden(), true, 'nothing is shown before a check');
		await page.click('#markBtn');
		await page.getByRole('menuitem', { name: /Check for updates/ }).click();
		await page.locator('#updatePill').filter({ hasText: 'Restart to update' }).waitFor({ timeout: 10_000 });
		await page.locator('#updateDot').waitFor({ state: 'visible' });
		const toast = page.locator('.toast').filter({ hasText: '9.9.9 is ready to install' });
		await toast.waitFor();
		await page.screenshot({ path: path.join(os.tmpdir(), 'stormcoder-update-ready.png') });
		// The app menu now leads with the install action instead of "Check for updates".
		await page.click('#markBtn');
		await page.getByRole('menuitem', { name: /Restart to install 9.9.9/ }).waitFor();
		await page.keyboard.press('Escape');
		// The pill opens its own menu; installing restarts through the backend.
		await page.click('#updatePill');
		await page.getByRole('menuitem', { name: /Restart and install 9.9.9/ }).click();
		const deadline = Date.now() + 5000;
		while (!host.log().includes('fake update installed') && Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); }
		assert.ok(host.log().includes('fake update installed'), 'the install was requested');
		assert.deepEqual(errors, []);
		await page.close();
		host.stop();
	}
	// Nothing newer: a manual check says so, and no pill or dot appears.
	{
		const { host, page, errors } = await open('none');
		await page.click('#markBtn');
		await page.getByRole('menuitem', { name: /Check for updates/ }).click();
		await page.locator('.toast').filter({ hasText: 'latest version' }).waitFor({ timeout: 10_000 });
		assert.equal(await page.locator('#updatePill').isHidden(), true);
		assert.equal(await page.locator('#updateDot').isHidden(), true);
		// The command palette offers the same check.
		await page.keyboard.press('Control+k');
		await page.keyboard.type('Check for Updates');
		await page.locator('.cmd-row, [role=option]').filter({ hasText: 'Check for Updates' }).first().waitFor();
		assert.deepEqual(errors, []);
		await page.close();
		host.stop();
	}
	console.log('update-e2e: background download, highlight, install and manual check passed');
} finally {
	await browser.close();
	mock.close();
}
