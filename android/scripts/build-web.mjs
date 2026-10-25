/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Builds android/www: the phone app (openvs-relay/pwa) exactly as it is, plus a native shim and a
// bundle-specific index.html. Only index.html differs from the PWA's; every other file is a byte
// for byte copy, so the code that runs in the APK is the code that is reviewed and tested.
//   node android/scripts/build-web.mjs [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.resolve(root, '..', 'openvs-relay', 'pwa');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(root, 'www'));

/** Files that only make sense when a relay serves the app: the worker, its cache headers, install metadata. */
const SERVER_ONLY = new Set(['sw.js', '_headers', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-512-maskable.png']);

/**
 * The Content-Security-Policy of the bundled app. The PWA's own policy allows `connect-src 'self'`
 * because its relay is its origin; here the relay is elsewhere, so https and wss are allowed to
 * connect. Scripts and styles stay limited to the bundle (no inline, no eval).
 */
export const BUNDLE_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: blob:",
	"font-src 'self'",
	"connect-src 'self' https: wss:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join('; ');

/**
 * Turns the PWA's index.html into the bundle's: a CSP meta tag first, no install or cache metadata,
 * and the native shim loaded before the app.
 * @param {string} html
 */
export function bundleIndex(html) {
	let result = html
		.replace(/^[ \t]*<link rel="manifest"[^>]*>\r?\n/m, '')
		.replace(/^[ \t]*<link rel="apple-touch-icon"[^>]*>\r?\n/m, '');
	if (!/<meta charset[^>]*>/i.test(result)) {
		throw new Error('index.html has no charset meta to anchor the policy to.');
	}
	result = result.replace(/(<meta charset[^>]*>)/i, `$1\n<meta http-equiv="Content-Security-Policy" content="${BUNDLE_CSP}">`);
	const appScript = '<script type="module" src="/app.js"></script>';
	if (!result.includes(appScript)) {
		throw new Error('index.html no longer loads /app.js the expected way.');
	}
	return result.replace(appScript, `<script src="/native.js"></script>\n${appScript}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(source).sort()) {
	if (SERVER_ONLY.has(name)) {
		continue;
	}
	if (name === 'index.html') {
		fs.writeFileSync(path.join(out, name), bundleIndex(fs.readFileSync(path.join(source, name), 'utf8')));
	} else {
		fs.copyFileSync(path.join(source, name), path.join(out, name));
	}
}
fs.copyFileSync(path.join(root, 'src', 'native.js'), path.join(out, 'native.js'));
console.log(`android/www: ${fs.readdirSync(out).length} files`);
