// Renders build/icon.png (1024px) from build/icon.svg; electron-builder derives the .ico and .icns
// from it. Also writes small previews so the glyph can be judged at 32px and 16px.
// Usage: node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from '../test/browser.mjs';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
const browser = await launchChromium();
try {
	const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
	await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
	await page.screenshot({ path: path.join(root, 'build/icon.png'), omitBackground: true });
	if (process.argv[2]) {
		for (const size of [256, 64, 32, 16]) {
			await page.setViewportSize({ width: size, height: size });
			await page.setContent(`<html><body style="margin:0;background:#2b2b30"><img style="width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
			await page.screenshot({ path: path.join(process.argv[2], `icon-${size}.png`) });
		}
	}
} finally { await browser.close(); }
