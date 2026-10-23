// Captures the menu surfaces for design review: tooltip, message actions, context menu, empty states.
// Usage: node scripts/menus.mjs [outDir] [theme]
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from '../test/browser.mjs';
import { startHost, startMock } from '../test/harness.mjs';

const out = path.resolve(process.argv[2] ?? '/tmp/menus');
const theme = process.argv[3] ?? 'dark';
fs.mkdirSync(out, { recursive: true });
const mock = await startMock(() => 'Here is a **short** answer with `code` and a list:\n\n- first\n- second\n\n```js\nconst x = 1;\n```\n');
const host = await startHost({ mockPort: mock.port });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', e => console.log('pageerror:', e.message));
	await page.goto(host.url);
	await page.evaluate(t => window.__setTheme(t), theme);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();
	await chat.locator('#input').fill('hello');
	await chat.locator('#input').press('Enter');
	await chat.getByText('short').first().waitFor({ timeout: 15000 });
	await page.waitForTimeout(800);
	await chat.locator('.message').nth(1).hover();
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/message-hover.png` });
	await chat.locator('.msg-copy').nth(1).hover();
	await page.waitForTimeout(900);
	await page.screenshot({ path: `${out}/tooltip.png` });
	await chat.locator('.message .body').nth(1).click({ button: 'right', position: { x: 60, y: 12 } });
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/context-menu.png` });
	await page.keyboard.press('Escape');
	await page.click('[data-view=history]'); await page.waitForTimeout(700);
	await page.screenshot({ path: `${out}/history.png` });
	await page.click('[data-view=mcp]'); await page.waitForTimeout(900);
	await page.screenshot({ path: `${out}/mcp-empty.png` });
	console.log('written to', out);
} finally { await browser.close(); host.stop(); mock.close(); }
