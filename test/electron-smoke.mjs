// Launches the real Electron app (main process, preload, stormcoder-asset protocol) and checks the
// shell and both frames come up and talk to the engine. Needs a display (xvfb-run on CI).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-electron-'));
// Voice input on, so the one permission the app can grant is exercised below.
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ 'stormcoder.voice.provider': 'custom' }));
// MJ_PACKAGED=release/linux-unpacked/stormcoder tests the installed layout (asar) instead of the source tree.
const packaged = process.env.MJ_PACKAGED ? path.resolve(process.env.MJ_PACKAGED) : undefined;
const electronBin = packaged ?? (await import('node:module')).createRequire(import.meta.url)('electron');
const app = await electron.launch({ executablePath: electronBin, args: [...(packaged ? [] : [root]), '--no-sandbox', '--disable-gpu', '--use-fake-device-for-media-stream', `--user-data-dir=${data}`] });
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
	assert.equal(await page.title(), 'Stormcoder');

	// The bridge reached the engine: the provider list rendered from host data.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area.active[data-area=providers] .provider-card, .area.active[data-area=providers] #providerList > *').first().waitFor({ timeout: 15000 });

	// A prompt from the engine reaches the shell and answers back (palette input round trip).
	await page.keyboard.press('Control+k');
	await page.locator('#palette:not(.hidden)').waitFor();
	await page.keyboard.press('Escape');

	// Permissions, in the real app. A synthetic microphone is present (the launch flag), but
	// nothing answers the permission question for us: the app's own handler does. Only the chat
	// view may have the microphone, audio only; the camera, the settings view and the shell
	// page are refused.
	const ask = (target, constraints) => target.evaluate(async (_el, c) => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia(c);
			for (const t of stream.getTracks()) { t.stop(); }
			return 'granted';
		} catch (e) { return e.name; }
	}, constraints);
	await page.click('[data-view=chat]');
	assert.equal(await ask(chat.locator('body'), { audio: true }), 'granted', 'the chat view gets the microphone while voice input is on');
	assert.equal(await ask(chat.locator('body'), { audio: true, video: true }), 'NotAllowedError', 'never the camera');
	assert.equal(await ask(chat.locator('body'), { video: true }), 'NotAllowedError');
	assert.equal(await ask(settings.locator('body'), { audio: true }), 'NotAllowedError', 'the settings view gets nothing');
	assert.equal(await ask(page.locator('body'), { audio: true }), 'NotAllowedError', 'nor does the shell page');
	assert.equal(await chat.locator('#micButton:not(.hidden)').count(), 1, 'the microphone button is shown');

	// The sealed page route exists in the real protocol handler and answers with its policy,
	// also for an id it does not know.
	const pageRoute = await app.evaluate(async ({ net }) => {
		const r = await net.fetch('stormcoder-asset://app/page/0000000000000000');
		return [r.status, r.headers.get('content-security-policy')];
	});
	assert.equal(pageRoute[0], 404);
	assert.match(pageRoute[1] ?? '', /^sandbox; default-src 'none'/);
	// Desktop notifications are available to the main process (they need no page permission).
	assert.equal(typeof await app.evaluate(({ Notification }) => Notification.isSupported()), 'boolean');

	// Deep link: the OS hands the app a stormcoder:// URL; it must not crash the main process.
	await app.evaluate(({ app: a }) => a.emit('open-url', { preventDefault() { } }, 'stormcoder://openvs.openvs-chat/auth-callback?state=none'));
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
