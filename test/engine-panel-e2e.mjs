// End-to-end for the Settings > Agent engine panel, through the real UI: two option cards, the SDK
// status, install (with the licence notice), the "after restart" state and its Restart button, and the
// fast-model field. A stand-in registry serves the SDK; nothing leaves the machine.
import { launchChromium } from './browser.mjs';
import { startFakeRegistry } from './fake-registry.mjs';
import { startHost, startMock } from './harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const registry = await startFakeRegistry({ failFirst: 1, slowMs: 700 });
// A slow chat reply, so a run is in flight while the panel is used.
const mock = await startMock(() => 'a slow reply. '.repeat(40), { chunkDelay: 300 });
const host = await startHost({ mockPort: mock.port, settings: { 'stormcoder.engine.registry': registry.url } });
const settingsFile = path.join(host.data, 'settings.json');
const saved = key => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))[key]; } catch { return undefined; } };
const until = async (fn, what) => { for (let i = 0; i < 80; i++) { if (fn()) { return; } await new Promise(r => setTimeout(r, 100)); } throw new Error(`timed out waiting for ${what}`); };

const browser = await launchChromium();
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	await page.frameLocator('#view-chat').locator('#input').waitFor();
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.getByRole('button', { name: 'Agent engine' }).click();
	const area = settings.locator('.area.active[data-area=engine]');
	await area.waitFor();
	const builtin = area.locator('.approval-card', { hasText: 'Built-in agent' });
	const claude = area.locator('.approval-card', { hasText: 'Claude Code engine' });

	// 1. The starting state: built-in is selected and running; the SDK is not installed.
	assert.equal(await builtin.getAttribute('aria-checked'), 'true');
	assert.equal(await claude.getAttribute('aria-checked'), 'false');
	assert.match(await builtin.textContent(), /running/);
	assert.match(await settings.locator('#engineStatus').textContent(), /not installed/);
	assert.equal(await settings.locator('#engineInstall').textContent(), 'Install Claude Agent SDK');
	assert.ok(await settings.locator('#engineRestart').evaluate(el => el.classList.contains('hidden')), 'nothing to restart yet');
	if (process.env.E2E_SHOT) { await page.screenshot({ path: process.env.E2E_SHOT.replace('.png', '-1.png') }); }

	// 2. Picking the Claude Code engine asks first (Anthropic's terms); declining changes nothing.
	await claude.click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	assert.match(await page.locator('#dialog').textContent(), /Anthropic under its own terms/);
	await page.locator('#dialogActions button', { hasText: 'Cancel' }).click();
	await page.waitForTimeout(500);
	assert.equal(registry.requests.length, 0, 'nothing was downloaded');
	assert.notEqual(saved('stormcoder.engine'), 'claude-code');
	assert.equal(await claude.getAttribute('aria-checked'), 'false');

	// 3a. A download that fails leaves the choice unsaved, says why in the panel itself (a toast fades), and can be retried.
	await claude.click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	await page.locator('#dialogActions button', { hasText: 'Install' }).click();
	await settings.locator('#engineNotice', { hasText: 'Could not install the Claude Agent SDK' }).waitFor({ timeout: 30000 });
	assert.match(await settings.locator('#engineNotice').textContent(), /503/);
	assert.notEqual(saved('stormcoder.engine'), 'claude-code', 'a failed install does not select the engine');
	assert.equal(await settings.locator('#engineInstall').isDisabled(), false, 'the buttons are usable again');

	// 3b. Accepting installs it, saves the choice, and the panel shows it is waiting for a restart. While the
	//     download runs the buttons are disabled, and a second click does not start a second download.
	await claude.click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	await page.locator('#dialogActions button', { hasText: 'Install' }).click();
	await settings.locator('#engineStatus', { hasText: 'Downloading' }).waitFor({ timeout: 10000 });
	assert.equal(await settings.locator('#engineInstall').isDisabled(), true, 'disabled while downloading');
	await claude.click({ force: true });
	await settings.locator('#engineInstall').click({ force: true, timeout: 2000 }).catch(() => undefined);
	await page.waitForTimeout(200);
	assert.equal(await page.locator('#dialog:not(.hidden)').count(), 0, 'no second notice while one install is running');
	await page.locator('#toasts', { hasText: 'Claude Agent SDK 0.3.17 installed' }).waitFor({ timeout: 30000 });
	assert.equal(registry.requests.filter(r => r === '/sdk.tgz').length, 1, 'downloaded once');
	assert.ok(!/Could not install/.test(await settings.locator('#engineNotice').textContent()), 'the old problem is cleared');
	await until(() => saved('stormcoder.engine') === 'claude-code', 'the engine setting to be saved');
	await settings.locator('.approval-card[aria-checked=true]', { hasText: 'Claude Code engine' }).waitFor();
	assert.match(await claude.textContent(), /after restart/);
	assert.match(await builtin.textContent(), /running/, 'the built-in agent is still what is running');
	assert.match(await settings.locator('#engineStatus').textContent(), /Claude Agent SDK 0\.3\.17 is installed.*Restart Stormcoder to switch to the Claude Code engine/s);
	assert.equal(await settings.locator('#engineInstall').textContent(), 'Update Claude Agent SDK');
	assert.ok(!(await settings.locator('#engineRestart').evaluate(el => el.classList.contains('hidden'))), 'Restart now is offered');
	if (process.env.E2E_SHOT) { await page.screenshot({ path: process.env.E2E_SHOT.replace('.png', '-2.png') }); }

	// 4. Going back to the engine that is running needs no restart.
	await builtin.click();
	await until(() => saved('stormcoder.engine') === 'builtin', 'the setting to go back');
	await settings.locator('.approval-card[aria-checked=true]', { hasText: 'Built-in agent' }).waitFor();
	assert.ok(await settings.locator('#engineRestart').evaluate(el => el.classList.contains('hidden')));
	assert.ok(!/after restart/.test(await claude.textContent()));

	// 5. The keyboard works: Enter on the Claude Code card selects it, and since the SDK is already
	//    installed there is no download and no notice.
	const requestsBefore = registry.requests.length;
	await claude.focus();
	await page.keyboard.press('Enter');
	await until(() => saved('stormcoder.engine') === 'claude-code', 'the keyboard choice to be saved');
	assert.equal(registry.requests.length, requestsBefore);
	assert.equal(await page.locator('#dialog:not(.hidden)').count(), 0);

	// 5b. Restart now asks first while a chat is running, and does not when none is.
	await settings.locator('#engineRestart').waitFor({ state: 'visible' });
	await settings.locator('#engineRestart').click();
	await page.waitForTimeout(300);
	assert.equal(await page.locator('#dialog:not(.hidden)').count(), 0, 'nothing is running, so no question');
	await page.click('[data-view=chat]');
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').fill('say something long');
	await chat.locator('#input').press('Enter');
	await page.waitForTimeout(800); // the reply is streaming slowly now
	await page.click('[data-view=settings]');
	await settings.getByRole('button', { name: 'Agent engine' }).click(); // Settings reopens on its first area
	await settings.locator('#engineRestart').click();
	await page.locator('#dialog:not(.hidden)').waitFor({ timeout: 5000 });
	assert.match(await page.locator('#dialog').textContent(), /A chat is still running\. Restarting stops it/);
	await page.locator('#dialogActions button', { hasText: 'Cancel' }).click();
	assert.equal(await page.locator('#dialog:not(.hidden)').count(), 0);
	await page.click('[data-view=chat]');
	await chat.locator('#stopButton').click({ timeout: 3000 }).catch(() => undefined);
	await page.click('[data-view=settings]');
	await settings.getByRole('button', { name: 'Agent engine' }).click();

	// 6. The fast-model field rejects what is not provider:model and keeps what is.
	const input = settings.locator('#engineFastInput');
	await input.fill('not a model');
	await settings.locator('#saveEngineFast').click();
	assert.match(await settings.locator('#engineNotice').textContent(), /provider:model/);
	await page.waitForTimeout(300);
	assert.equal(saved('stormcoder.engine.fastModel'), undefined, 'a bad value is not saved');
	await input.fill('openai:gpt-4o-mini');
	await settings.locator('#saveEngineFast').click();
	await until(() => saved('stormcoder.engine.fastModel') === 'openai:gpt-4o-mini', 'the fast model to be saved');
	// "Saved" is said only once the host has confirmed it (the notice passes through "Saving…").
	await settings.locator('#engineNotice', { hasText: /^Saved/ }).waitFor({ timeout: 5000 });

	// 6b. The selected engine's SDK has gone missing (the folder was deleted): the panel says so, and
	//     clicking the selected card installs it again instead of doing nothing.
	fs.rmSync(path.join(host.data, 'engines'), { recursive: true, force: true });
	await page.reload();
	await page.frameLocator('#view-chat').locator('#input').waitFor();
	await page.click('[data-view=settings]');
	const missing = page.frameLocator('#view-settings');
	await missing.getByRole('button', { name: 'Agent engine' }).click();
	await missing.locator('#engineStatus', { hasText: 'selected but its SDK is not installed' }).waitFor();
	const downloadsBefore = registry.requests.filter(r => r === '/sdk.tgz').length;
	await missing.locator('.approval-card', { hasText: 'Claude Code engine' }).click();
	await page.locator('#dialog:not(.hidden)').waitFor();
	await page.locator('#dialogActions button', { hasText: 'Install' }).click();
	await until(() => registry.requests.filter(r => r === '/sdk.tgz').length === downloadsBefore + 1 && fs.existsSync(path.join(host.data, 'engines', 'claude', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')), 'the SDK to be installed again');

	// 7. It all survives a reload.
	await page.reload();
	await page.frameLocator('#view-chat').locator('#input').waitFor();
	await page.click('[data-view=settings]');
	const again = page.frameLocator('#view-settings');
	await again.getByRole('button', { name: 'Agent engine' }).click();
	await again.locator('.approval-card[aria-checked=true]', { hasText: 'Claude Code engine' }).waitFor();
	assert.equal(await again.locator('#engineFastInput').inputValue(), 'openai:gpt-4o-mini');
	assert.match(await again.locator('#engineStatus').textContent(), /0\.3\.17 is installed/);

	assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
	console.log('engine panel e2e: all assertions passed');
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
