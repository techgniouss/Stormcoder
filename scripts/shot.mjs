// Opens the dev host in Chromium and writes screenshots. Usage: node scripts/shot.mjs <url> <out.png> [width height] [steps...]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [url, out, w = '1440', h = '900', ...steps] = process.argv.slice(2);
const exe = fs.readdirSync('/opt/pw-browsers').filter(d => d.startsWith('chromium-')).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text()); });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(url);
await page.waitForTimeout(1500);
for (const s of steps) {
	if (s.startsWith('click:')) { await page.click(s.slice(6)); await page.waitForTimeout(700); }
	else if (s.startsWith('key:')) { await page.keyboard.press(s.slice(4)); await page.waitForTimeout(500); }
	else if (s.startsWith('wait:')) { await page.waitForTimeout(+s.slice(5)); }
}
await page.screenshot({ path: out });
await browser.close();
