// Renders build/icon.png (1024px) from the brand mark. electron-builder derives the .ico and
// .icns from it. Usage: node scripts/make-icon.mjs <html file> 
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const exe = fs.readdirSync('/opt/pw-browsers').filter(d => d.startsWith('chromium-')).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.goto('file://' + path.resolve(process.argv[2]));
await p.screenshot({ path: path.resolve(import.meta.dirname, '../build/icon.png') });
await b.close();
