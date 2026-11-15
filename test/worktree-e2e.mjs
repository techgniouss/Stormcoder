// End-to-end: a chat started in its own git worktree. The real engine and UI in Chromium,
// against a mock model. What matters: the agent's writes land in the worktree and not in the
// project folder, an ordinary chat still works in the project, the Changes view follows the
// chat, and closing a worktree chat never throws work away.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const mock = await startMock(req => {
	const alreadyWrote = req.messages.some(m => m.role === 'tool');
	if (req.tools?.some(t => t.function?.name === 'write_file') && !alreadyWrote) {
		const goal = String(req.messages.filter(m => m.role === 'user').at(-1)?.content);
		const name = /create (\S+)/.exec(goal)?.[1] ?? 'out.txt';
		return { text: 'Creating the file.', tool: { name: 'write_file', args: { path: name, content: `written by the agent: ${name}\n` } } };
	}
	return alreadyWrote ? 'Done: file written.' : 'Hello from the mock model.';
});
const host = await startHost({ mockPort: mock.port });
const project = host.project;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
git(project, 'init', '-q', '-b', 'main');
git(project, 'config', 'user.name', 'Test');
git(project, 'config', 'user.email', 'test@example.com');
fs.writeFileSync(path.join(project, 'README.md'), 'project\n');
fs.writeFileSync(path.join(project, '.gitignore'), '.stormcoder/\n');
git(project, 'add', '-A');
git(project, 'commit', '-q', '-m', 'first');

/** Every worktree folder the app has created for this project. */
function worktreeDirs() {
	const root = path.join(host.data, 'worktrees');
	if (!fs.existsSync(root)) { return []; }
	return fs.readdirSync(root).flatMap(key => fs.readdirSync(path.join(root, key)).map(id => path.join(root, key, id)));
}

const browser = await launchChromium();
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(host.url);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();
	await chat.locator('.chat-tab').first().waitFor();
	const runAgent = async (goal) => {
		await chat.locator('.seg-btn[data-value=agent]').click();
		await chat.locator('#input').fill(goal);
		await chat.locator('#input').press('Enter');
		await chat.locator('#messages > .message.assistant', { hasText: 'Done: file written.' }).last().waitFor({ timeout: 20000 });
		await chat.locator('#sendButton:not(.hidden)').waitFor({ timeout: 15000 });
	};

	// 1. A new chat in a worktree: a second tab, marked, with a folder and a branch of its own.
	await chat.locator('body').evaluate(() => { window.dispatchEvent(new CustomEvent('stormcoder-new-worktree-chat')); });
	await chat.locator('.chat-tab.active .tab-wt').waitFor({ timeout: 15000 });
	assert.equal(await chat.locator('.chat-tab').count(), 2);
	const dirs = worktreeDirs();
	assert.equal(dirs.length, 1, 'one worktree folder was created');
	const worktree = dirs[0];
	assert.match(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), /^stormcoder\/chat-/);
	assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the project stays on its own branch');
	await chat.getByText('works in its own git worktree').waitFor();

	// 2. The agent writes into the worktree. The project folder is untouched.
	await runAgent('create inside.txt');
	assert.equal(fs.readFileSync(path.join(worktree, 'inside.txt'), 'utf8'), 'written by the agent: inside.txt\n');
	assert.equal(fs.existsSync(path.join(project, 'inside.txt')), false, 'nothing was written to the project folder');
	assert.equal(git(project, 'status', '--porcelain').trim(), '', 'and the project has no changes');

	// 3. The Changes view follows the active chat: it lists the worktree's file.
	await page.click('[data-view=changes]');
	const changes = page.locator('#view-changes');
	await changes.locator('.ch-row', { hasText: 'inside.txt' }).waitFor({ timeout: 15000 });
	await page.click('[data-view=chat]');

	// 4. Undo restores inside the worktree too.
	await chat.locator('.undo-bar button', { hasText: 'Undo' }).click();
	for (let i = 0; i < 50 && fs.existsSync(path.join(worktree, 'inside.txt')); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(fs.existsSync(path.join(worktree, 'inside.txt')), false, 'undo removed the file the run created, in the worktree');
	await runAgent('create kept.txt');
	assert.equal(fs.existsSync(path.join(worktree, 'kept.txt')), true);

	// 4b. A run started by a slash command is confined to the worktree as well.
	await chat.locator('#input').fill('/agent create slash.txt');
	await chat.locator('#input').press('Enter');
	for (let i = 0; i < 200 && !fs.existsSync(path.join(worktree, 'slash.txt')) && !fs.existsSync(path.join(project, 'slash.txt')); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(fs.existsSync(path.join(project, 'slash.txt')), false, 'a slash-started run does not write to the project folder');
	assert.equal(fs.existsSync(path.join(worktree, 'slash.txt')), true);
	await chat.locator('#sendButton:not(.hidden)').waitFor({ timeout: 15000 });
	fs.rmSync(path.join(worktree, 'slash.txt'));

	// 5. The ordinary chat still works in the project folder, while the other tab has a worktree.
	await chat.locator('.chat-tab').first().click();
	await chat.locator('.chat-tab.active:not(:has(.tab-wt))').waitFor();
	await runAgent('create outside.txt');
	assert.equal(fs.readFileSync(path.join(project, 'outside.txt'), 'utf8'), 'written by the agent: outside.txt\n');
	assert.equal(fs.existsSync(path.join(worktree, 'outside.txt')), false);

	// 6. Closing the worktree chat while it has uncommitted work asks first; cancelling keeps
	// the chat, and confirming keeps the folder.
	const wtTab = chat.locator('.chat-tab:has(.tab-wt)');
	await wtTab.locator('.tab-close').click();
	const dialog = page.locator('#dialog:not(.hidden), .dialog:not(.hidden)').first();
	await page.getByText('uncommitted changes').waitFor({ timeout: 10000 });
	await page.keyboard.press('Escape');
	await new Promise(r => setTimeout(r, 300));
	assert.equal(await wtTab.count(), 1, 'cancelling leaves the chat open');
	await wtTab.locator('.tab-close').click();
	await page.getByRole('button', { name: 'Close and Keep the Folder' }).click();
	await chat.locator('.chat-tab:has(.tab-wt)').waitFor({ state: 'detached', timeout: 10000 });
	assert.equal(fs.existsSync(path.join(worktree, 'kept.txt')), true, 'uncommitted work is still on disk');
	void dialog;

	// 7. A worktree with nothing uncommitted is removed on close; its branch stays.
	await chat.locator('body').evaluate(() => { window.dispatchEvent(new CustomEvent('stormcoder-new-worktree-chat')); });
	await chat.locator('.chat-tab.active .tab-wt').waitFor({ timeout: 15000 });
	const second = worktreeDirs().find(d => d !== worktree);
	assert.ok(second, 'a second worktree was created');
	const branch = git(second, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
	await chat.locator('.chat-tab.active .tab-close').click();
	for (let i = 0; i < 80 && fs.existsSync(second); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(fs.existsSync(second), false, 'a clean worktree folder is removed');
	assert.match(git(project, 'branch', '--list', branch), new RegExp(branch.replace('/', '\\/')), 'its branch is kept');

	// 8. /compare: one prompt to two models. Each gets a worktree chat of its own, titled with
	// the model, and each agent writes into its own worktree and not the project.
	const before = new Set(worktreeDirs());
	await chat.locator('.chat-tab').first().click();
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('/compare create cmp.txt');
	await chat.locator('#input').press('Enter');
	await page.locator('#palette:not(.hidden) #paletteList li').first().waitFor({ timeout: 10000 });
	for (const model of ['mock-model', 'glm-4.6']) {
		await page.locator('#paletteList li', { hasText: model }).first().click();
	}
	await page.locator('#paletteInput').press('Enter');
	await chat.locator('.chat-tab:has(.tab-wt)').nth(1).waitFor({ timeout: 20000 });
	assert.deepEqual((await chat.locator('.chat-tab:has(.tab-wt) .tab-title').allInnerTexts()).map(t => t.trim()).sort(), ['glm-4.6', 'mock-model']);
	const fresh = () => worktreeDirs().filter(d => !before.has(d));
	for (let i = 0; i < 200 && fresh().filter(d => fs.existsSync(path.join(d, 'cmp.txt'))).length < 2; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.equal(fresh().length, 2, 'two worktrees were created');
	for (const dir of fresh()) {
		assert.equal(fs.readFileSync(path.join(dir, 'cmp.txt'), 'utf8'), 'written by the agent: cmp.txt\n');
	}
	assert.equal(fs.existsSync(path.join(project, 'cmp.txt')), false, 'neither run wrote to the project folder');
	const models = mock.seen.filter(r => String(r.messages?.at(-1)?.content).includes('create cmp.txt') || r.messages?.some(m => String(m.content).includes('create cmp.txt'))).map(r => r.model);
	assert.ok(models.includes('mock-model') && models.includes('glm-4.6'), 'each chat asked its own model');
	// The asking chat itself ran nothing.
	await chat.getByText('each in its own worktree chat').waitFor();

	assert.deepEqual(errors, [], 'no uncaught page errors');
	console.log('worktree-e2e: ok');
} catch (err) {
	failed = true;
	console.error('worktree-e2e: FAILED\n', err);
	try { await (await browser.contexts()[0].pages())[0].screenshot({ path: path.join(os.tmpdir(), 'worktree-e2e-fail.png') }); console.error('screenshot: ' + path.join(os.tmpdir(), 'worktree-e2e-fail.png')); } catch { /* best effort */ }
	console.error(host.log().slice(-3000));
} finally {
	await browser.close();
	host.stop();
	mock.close();
}
process.exit(failed ? 1 : 0);
