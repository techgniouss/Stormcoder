// Launches Chromium for the browser tests: Playwright's own install when present, otherwise a
// chromium under PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers (as in sandboxed environments).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

function findInstalled() {
	for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)) {
		if (!fs.existsSync(base)) { continue; }
		for (const dir of fs.readdirSync(base).filter(d => d.startsWith('chromium-'))) {
			for (const sub of ['chrome-linux', 'chrome-linux64']) {
				const exe = path.join(base, dir, sub, 'chrome');
				if (fs.existsSync(exe)) { return exe; }
			}
		}
	}
	return undefined;
}

export async function launchChromium() {
	const args = ['--no-sandbox'];
	try {
		return await chromium.launch({ args });
	} catch {
		const executablePath = findInstalled();
		if (!executablePath) { throw new Error('No Chromium found. Run: npx playwright-core install chromium'); }
		return chromium.launch({ executablePath, args });
	}
}
