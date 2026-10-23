// Samples the agent's working line over time so every glyph and verb can be judged.
// Usage: node scripts/glyphs.mjs [outDir] [theme]
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from '../test/browser.mjs';
import { startHost, startMock } from '../test/harness.mjs';

const out = path.resolve(process.argv[2] ?? '/tmp/glyphs');
const theme = process.argv[3] ?? 'dark';
fs.mkdirSync(out, { recursive: true });
const mock = await startMock(() => 'x'.repeat(2400), { chunkDelay: 250 });
const host = await startHost({ mockPort: mock.port });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
	await page.goto(host.url);
	await page.evaluate(t => window.__setTheme(t), theme);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();
	await page.waitForTimeout(1200);
	await page.screenshot({ path: `${out}/hero.png`, clip: { x: 0, y: 0, width: 1440, height: 700 } });
	await chat.locator('#input').fill('think about it');
	await chat.locator('#input').press('Enter');
	const seen = new Set();
	for (let i = 0; i < 14; i++) {
		await page.waitForTimeout(1500);
		const w = chat.locator('.working');
		if (await w.count()) {
			const label = (await w.first().textContent() || '').trim();
			const kind = await chat.locator('.working .storm-glyph').first().getAttribute('class').catch(() => '');
			const key = `${kind}|${label.split(/\d/)[0]}`;
			if (!seen.has(key) || i < 3) { await w.first().screenshot({ path: `${out}/work-${String(i).padStart(2, '0')}.png` }); seen.add(key); }
			console.log(i, kind, '|', label);
		}
	}
	await page.screenshot({ path: `${out}/rail.png`, clip: { x: 0, y: 0, width: 330, height: 330 } });
} finally { await browser.close(); host.stop(); mock.close(); }
