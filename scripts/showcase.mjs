// Renders the app with realistic content and writes screenshots for design review.
// Usage: node scripts/showcase.mjs [outDir] [theme]
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from '../test/browser.mjs';
import { startHost, startMock } from '../test/harness.mjs';

const out = path.resolve(process.argv[2] ?? '/tmp/showcase');
const theme = process.argv[3] ?? 'dark';
fs.mkdirSync(out, { recursive: true });

const RICH = `## Fixing the retry logic

I read \`src/client.ts\` and found the cause: the backoff never resets after a success, so one slow minute penalises every later request.

1. Reset \`attempt\` when a request succeeds
2. Cap the delay at 30 seconds
3. Add jitter so clients do not retry in lockstep

\`\`\`ts
export async function withRetry<T>(run: () => Promise<T>, max = 5): Promise<T> {
	let attempt = 0;
	for (;;) {
		try {
			return await run();
		} catch (err) {
			if (++attempt >= max) { throw err; }
			await sleep(Math.min(30_000, 2 ** attempt * 250) * (0.5 + Math.random()));
		}
	}
}
\`\`\`

| Case | Before | After |
| --- | --- | --- |
| Single failure | 250 ms | 250 ms |
| Five failures | 8 s | 8 s, capped at 30 s |
| After a success | stays high | resets |

> The change is small, but it stops one bad minute from slowing everything after it.
`;

const mock = await startMock(req => {
	const last = req.messages[req.messages.length - 1];
	const wrote = req.messages.some(m => m.role === 'tool');
	if (req.tools?.some(t => t.function?.name === 'read_file') && /fix/i.test(String(last.content)) && !wrote) {
		return { text: 'Let me look at the client first.', tool: { name: 'read_file', args: { path: 'src/client.ts' } } };
	}
	return RICH;
}, { chunkDelay: 90 });
const host = await startHost({ mockPort: mock.port, files: { 'src/client.ts': 'export const x = 1;\n', 'README.md': '# demo\n' } });
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', e => console.log('pageerror:', e.message));
	await page.goto(host.url);
	await page.evaluate(t => window.__setTheme && window.__setTheme(t), theme);
	const chat = page.frameLocator('#view-chat');
	await chat.locator('#input').waitFor();
	await page.waitForTimeout(1200);
	await page.screenshot({ path: `${out}/01-hero.png` });
	await chat.locator('.seg-btn[data-value=agent]').click();
	await chat.locator('#input').fill('fix the retry logic in src/client.ts');
	await chat.locator('#input').press('Enter');
	await page.waitForTimeout(2600);
	await page.screenshot({ path: `${out}/02-running.png` });
	await chat.getByText('The change is small').first().waitFor({ timeout: 40000 });
	await page.waitForTimeout(1500);
	await page.screenshot({ path: `${out}/03-transcript.png` });
	await chat.locator('#messages').evaluate(el => { el.scrollTop = 0; });
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/03b-top.png` });
	await page.click('[data-view=settings]'); await page.waitForTimeout(1200);
	await page.screenshot({ path: `${out}/04-settings.png` });
	await page.click('[data-view=skills]'); await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/05-skills.png` });
	await page.click('[data-view=mcp]'); await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/06-mcp.png` });
	await page.click('[data-view=history]'); await page.waitForTimeout(700);
	await page.screenshot({ path: `${out}/07-history.png` });
	await page.click('[data-view=chat]'); await page.keyboard.press('Control+k'); await page.waitForTimeout(500);
	await page.screenshot({ path: `${out}/08-palette.png` });
	console.log('showcase written to', out);
} finally {
	await browser.close(); host.stop(); mock.close();
}
