// Launches the real Electron app (main process, preload, mjolnir-asset protocol) and checks the
// shell and both frames come up and talk to the engine. Needs a display (xvfb-run on CI).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-electron-'));
const electronBin = (await import('node:module')).createRequire(import.meta.url)('electron');
const app = await electron.launch({ executablePath: electronBin, args: [root, '--no-sandbox', '--disable-gpu', `--user-data-dir=${data}`] });
let failed = false;
const page = await app.firstWindow();
const proc = app.process();
proc.stdout.on('data', d => process.stdout.write(`[main] ${d}`));
proc.stderr.on('data', d => process.stderr.write(`[main] ${d}`));
try {
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.waitForSelector('#rail');
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor({ timeout: 20000 });
	assert.equal(await page.title(), 'Mjolnir');

	// The bridge reached the engine: the provider list rendered from host data.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area.active[data-area=providers] .provider-card, .area.active[data-area=providers] #providerList > *').first().waitFor({ timeout: 15000 });

	// A prompt from the engine reaches the shell and answers back (palette input round trip).
	await page.keyboard.press('Control+k');
	await page.locator('#palette:not(.hidden)').waitFor();
	await page.keyboard.press('Escape');

	// Deep link: the OS hands the app a mjolnir:// URL; it must not crash the main process.
	await app.evaluate(({ app: a }) => a.emit('open-url', { preventDefault() { } }, 'mjolnir://openvs.openvs-chat/auth-callback?state=none'));
	assert.deepEqual(errors, [], 'no uncaught page errors');
	await page.screenshot({ path: path.join(os.tmpdir(), 'electron-smoke.png') });
	console.log('electron-smoke: ok');
} catch (err) {
	failed = true;
	console.error('electron-smoke: FAILED\n', err);
	await page.screenshot({ path: path.join(os.tmpdir(), 'electron-fail.png') }).catch(() => undefined);
} finally {
	await app.close();
	fs.rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
