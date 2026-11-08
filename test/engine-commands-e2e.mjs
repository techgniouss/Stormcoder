// End-to-end for choosing the agent engine from the command palette, through the real UI: the
// palette lists the engine commands, picking the Claude Code engine asks before downloading the SDK
// (a licence notice, so a modal that waits), installs it from a stand-in registry, saves the
// setting only after the install worked, and offers a restart. Declining installs nothing and
// changes nothing.
import { launchChromium } from './browser.mjs';
import { startFakeRegistry } from './fake-registry.mjs';
import { startHost, startMock } from './harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const registry = await startFakeRegistry();
const mock = await startMock(() => 'unused');
const host = await startHost({ mockPort: mock.port, settings: { 'stormcoder.engine.registry': registry.url } });
const settingsFile = path.join(host.data, 'settings.json');
const savedEngine = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.engine'];
const sdkPackage = path.join(host.data, 'engines', 'claude', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');

const browser = await launchChromium();
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	await page.frameLocator('#view-chat').locator('#input').waitFor();

	const openEngineChooser = async () => {
		await page.keyboard.press('Control+k');
		await page.fill('#paletteInput', 'agent engine');
		await page.locator('#paletteList li', { hasText: 'Choose Agent Engine' }).first().waitFor();
		await page.keyboard.press('Enter');
		await page.locator('#paletteList li', { hasText: 'Claude Code engine' }).waitFor();
	};

	// The commands are in the palette.
	await page.keyboard.press('Control+k');
	await page.fill('#paletteInput', 'engine');
	assert.ok(await page.locator('#paletteList li', { hasText: 'Choose Agent Engine' }).count() > 0);
	assert.ok(await page.locator('#paletteList li', { hasText: 'Install Claude Code Engine' }).count() > 0);
	await page.keyboard.press('Escape');

	// 1. Declining the notice installs nothing and changes nothing.
	await openEngineChooser();
	await page.locator('#paletteList li', { hasText: 'Claude Code engine' }).click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	const notice = await page.locator('#dialog').textContent();
	assert.match(notice, /Claude Agent SDK/);
	assert.match(notice, /Anthropic under its own terms/);
	assert.match(notice, /code\.claude\.com/);
	await page.locator('#dialogActions button', { hasText: 'Cancel' }).click();
	await page.waitForTimeout(500);
	assert.ok(!registry.requests.length, 'nothing was downloaded');
	assert.ok(!fs.existsSync(sdkPackage));
	assert.notEqual(savedEngine(), 'claude-code', 'the setting was not changed');

	// 2. Accepting installs it, saves the setting, and offers the restart.
	await openEngineChooser();
	await page.locator('#paletteList li', { hasText: 'Claude Code engine' }).click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	await page.locator('#dialogActions button', { hasText: 'Install' }).click();
	await page.locator('#toasts', { hasText: 'Claude Agent SDK 0.3.17 installed' }).waitFor({ timeout: 30000 });
	assert.equal(JSON.parse(fs.readFileSync(sdkPackage, 'utf8')).version, '0.3.17');
	assert.ok(registry.requests.includes('/sdk.tgz') && registry.requests.includes('/bin.tgz'));
	for (let i = 0; i < 50 && savedEngine() !== 'claude-code'; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(savedEngine(), 'claude-code');
	await page.locator('#toasts', { hasText: 'Claude Code engine after a restart' }).waitFor({ timeout: 10000 });
	await page.locator('#toasts button', { hasText: 'Restart now' }).waitFor();

	// 3. Going back to the engine the app started with needs no restart.
	await openEngineChooser();
	await page.locator('#paletteList li', { hasText: 'Built-in agent' }).click();
	for (let i = 0; i < 50 && savedEngine() !== 'builtin'; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(savedEngine(), 'builtin');

	// 4. With the SDK already there, choosing the engine does not ask again.
	const before = registry.requests.length;
	await openEngineChooser();
	await page.locator('#paletteList li', { hasText: 'Claude Code engine' }).click();
	for (let i = 0; i < 50 && savedEngine() !== 'claude-code'; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(savedEngine(), 'claude-code');
	assert.equal(registry.requests.length, before, 'no second download');
	assert.equal(await page.locator('#dialog:not(.hidden)').count(), 0);

	assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
	console.log('engine commands e2e: all assertions passed');
} catch (err) {
	failed = true;
	console.error(err);
	try { await (await browser.contexts()[0].pages())[0].screenshot({ path: path.join(host.data, 'fail.png') }); console.error('screenshot: ' + path.join(host.data, 'fail.png')); } catch { /* best effort */ }
	console.error('--- host log ---\n' + host.log().slice(-3000));
} finally {
	await browser.close();
	host.stop();
	mock.close();
	registry.close();
}
process.exit(failed ? 1 : 0);
