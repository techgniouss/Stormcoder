// End-to-end: the real engine and the real UI in Chromium, against a mock OpenAI-compatible
// server. Covers a chat turn (streaming), an Agent run that writes a file through the tool
// loop, and that the transcript survives a reload.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Write once per conversation: after that the agent's own completion gate may nudge the model to
// verify, and a model that wrote again on every nudge would never finish.
const mock = await startMock(req => {
	const alreadyWrote = req.messages.some(m => m.role === 'tool');
	if (req.tools?.some(t => t.function?.name === 'write_file') && !alreadyWrote) {
		return { text: 'Creating the file.', tool: { name: 'write_file', args: { path: 'hello.txt', content: 'hello from stormcoder\n' } } };
	}
	return alreadyWrote ? 'Done: hello.txt written.' : 'Hello from the mock model.';
});
const seen = mock.seen;
const host = await startHost({ mockPort: mock.port });
const project = host.project;
const url = host.url;

const browser = await launchChromium();
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(url);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();

	// 1. A plain Ask turn streams a reply.
	await chat.locator('#input').fill('say hello');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Hello from the mock model.').waitFor({ timeout: 15000 });

	// 2. An Agent turn runs the tool loop and writes into the project folder.
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('create hello.txt');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Done: hello.txt written.').first().waitFor({ timeout: 20000 });
	assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hello from stormcoder\n');
	assert.ok(seen.some(r => r.tools?.some(t => t.function?.name === 'write_file')), 'the agent request offered write_file');
	if (process.env.E2E_SHOT) { await page.screenshot({ path: process.env.E2E_SHOT }); }

	// 3. Settings opens as its own view, and areas switch.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area.active[data-area=providers]').waitFor();
	await settings.getByRole('button', { name: 'Agent permissions' }).click();
	await settings.locator('.area.active[data-area=permissions]').waitFor();

	// 4. The palette opens and filters.
	await page.keyboard.press('Control+k');
	await page.fill('#paletteInput', 'mcp');
	assert.ok(await page.locator('#paletteList li', { hasText: 'MCP' }).count() > 0);
	await page.keyboard.press('Escape');

	// The mode switch drives the real select, and its thumb sits under the chosen segment.
	assert.equal(await chat.locator('#modeSelect').inputValue(), 'agent');
	const thumbX = await chat.locator('.seg-thumb').evaluate(el => parseFloat(el.style.getPropertyValue('--x')));
	const segX = await chat.locator('.seg-btn.on').evaluate(el => el.offsetLeft);
	assert.equal(thumbX, segX, 'the switch thumb follows the selected mode');

	// The rail indicator follows the active destination; the title swaps with it.
	const indY = async () => page.locator('.rail-ind').evaluate(el => el.style.transform);
	const before = await indY();
	await page.click('[data-view=history]');
	assert.notEqual(await indY(), before, 'the rail indicator moved');
	assert.equal(await page.textContent('#viewTitle'), 'History');
	await page.click('[data-view=chat]');

	// Theme: switching changes the shell and both frames, and the choice is remembered.
	await page.click('#themeBtn');
	const themeOf = async sel => page.frameLocator(sel).locator('html').evaluate(el => el.dataset.theme);
	const shellTheme = await page.evaluate(() => document.documentElement.dataset.theme);
	// The frame is told by message, so it follows a moment later.
	await page.waitForFunction(t => document.getElementById('view-chat').contentDocument.documentElement.dataset.theme === t, shellTheme);
	assert.equal(await themeOf('#view-chat'), shellTheme);
	assert.equal(await page.evaluate(() => localStorage.getItem('sc-theme')), shellTheme);
	await page.click('#themeBtn');
	assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), shellTheme);

	// Reduced motion removes the entrance animations rather than just shortening them.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.click('[data-view=settings]');
	const anim = await settings.locator('.area.active').evaluate(el => getComputedStyle(el).animationName);
	assert.equal(anim, 'none', 'no entrance animation under reduced motion');
	await page.emulateMedia({ reducedMotion: 'no-preference' });

	await page.click('[data-view=chat]');

	// Menus replace native dropdowns: the model picker lists the provider's models, narrows as you
	// type, and choosing one sets the real (hidden) select.
	await chat.locator('#modelSelectButton').click();
	const menu = chat.locator('.sc-menu.open');
	await menu.waitFor();
	assert.ok(await menu.locator('.sc-item').count() > 7, 'the model list is shown');
	assert.equal(await chat.locator('#modelSelectButton').getAttribute('aria-expanded'), 'true');
	await page.keyboard.type('qwen');
	assert.equal(await menu.locator('.sc-item').count(), 1, 'typing narrows the list');
	await page.keyboard.press('Enter');
	await menu.waitFor({ state: 'detached' });
	assert.equal(await chat.locator('#modelSelect').inputValue(), 'qwen3-coder-480b');
	assert.match(await chat.locator('#modelSelectButton .picker-label').textContent(), /qwen3-coder/);

	// Arrow keys and Enter drive a menu without the mouse.
	await chat.locator('#approvalSelectButton').click();
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('Enter');
	assert.equal(await chat.locator('#approvalSelect').inputValue(), 'auto-edits');

	// The app menu opens from the brand mark and leads to the shortcuts sheet.
	await page.click('#markBtn');
	await page.locator('.sc-menu.open').waitFor();
	await page.locator('.sc-item', { hasText: 'Keyboard shortcuts' }).click();
	await page.locator('#keys:not(.hidden)').waitFor();
	await page.keyboard.press('Escape');
	await page.locator('#keys.hidden').waitFor({ state: 'attached' });

	// The project popover names the open folder.
	await page.click('#projectBtn');
	await page.locator('.sc-menu.open .sc-item.checked').waitFor();
	assert.match(await page.locator('.sc-menu.open .sc-item.checked').textContent(), /project/);
	await page.keyboard.press('Escape');

	// Tooltips are ours, not the browser's: hovering moves the title into a styled bubble.
	await page.hover('[data-view=skills]');
	await page.locator('.sc-tip.open').waitFor();
	assert.match(await page.locator('.sc-tip.open').textContent(), /^Skills/);
	assert.equal(await page.locator('.sc-tip.open').getAttribute('data-side'), 'right', 'rail tips sit beside the rail');
	assert.equal(await page.getAttribute('[data-view=skills]', 'title'), null);

	// Right-clicking a message offers Copy message; the hover button is there too.
	await chat.locator('.message .body').first().click({ button: 'right' });
	await chat.locator('.sc-menu.open').waitFor();
	assert.ok((await chat.locator('.sc-menu.open').textContent()).includes('Copy message'));
	await page.keyboard.press('Escape');

	// 5. Creating a skill walks three prompts, writes the file, opens it in the built-in editor,
	//    and the skill then shows up in Settings.
	await page.keyboard.press('Control+k');
	await page.fill('#paletteInput', 'new skill');
	await page.keyboard.press('Enter');
	await page.locator('#palette:not(.hidden)').waitFor();
	await page.fill('#paletteInput', 'api-reviewer');
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.getElementById('paletteTitle').textContent.includes('2/3'));
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.getElementById('paletteTitle').textContent.includes('3/3'));
	await page.fill('#paletteInput', 'Reviews API changes');
	await page.keyboard.press('Enter');
	await page.locator('#editor:not(.hidden)').waitFor();
	assert.match(await page.inputValue('#editorText'), /Reviews API changes/);
	assert.ok(fs.existsSync(path.join(project, '.stormcoder/skills/api-reviewer.md')));
	await page.keyboard.press('Escape');
	await page.click('[data-view=skills]');
	await settings.locator('.area.active[data-area=skills]').getByText('Api Reviewer').first().waitFor({ timeout: 10000 });

	assert.deepEqual(errors, [], 'no uncaught page errors');
	console.log('e2e: ok');
} catch (err) {
	failed = true;
	console.error('e2e: FAILED\n', err);
	try { await (await browser.contexts()[0].pages())[0].screenshot({ path: path.join(os.tmpdir(), 'e2e-fail.png') }); console.error('screenshot: ' + path.join(os.tmpdir(), 'e2e-fail.png')); } catch { /* best effort */ }
	console.error('requests seen by mock:', JSON.stringify(seen).slice(0, 800));
	console.error(host.log());
} finally {
	await browser.close();
	host.stop();
	mock.close();
}
process.exit(failed ? 1 : 0);
