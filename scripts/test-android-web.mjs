/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The Android shell bundles the phone app (android/). This checks the bundle is exactly the
// reviewed PWA plus the shim, with a strict policy, and that the Android folder stays separate
// from the rest of the repo. Run: node scripts/test-android-web.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pwa = path.join(root, 'openvs-relay', 'pwa');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'android-www-'));
const run = spawnSync(process.execPath, [path.join(root, 'android', 'scripts', 'build-web.mjs'), '--out', out], { encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);

const built = fs.readdirSync(out).sort();
const SERVER_ONLY = ['sw.js', '_headers', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-512-maskable.png'];
for (const name of SERVER_ONLY) {
	assert.ok(!built.includes(name), `${name} only makes sense behind a relay and is not bundled`);
}
// Everything else is a byte-for-byte copy: the APK runs the code that is reviewed and tested.
for (const name of fs.readdirSync(pwa)) {
	if (SERVER_ONLY.includes(name) || name === 'index.html') { continue; }
	assert.ok(fs.readFileSync(path.join(out, name)).equals(fs.readFileSync(path.join(pwa, name))), `${name} is an unmodified copy of the PWA file`);
}
assert.deepEqual(built.filter(n => !fs.existsSync(path.join(pwa, n))), ['native.js'], 'the shim is the only added file');
assert.ok(fs.readFileSync(path.join(out, 'native.js')).equals(fs.readFileSync(path.join(root, 'android', 'src', 'native.js'))));

// index.html: a policy first, the shim before the app, nothing loaded from elsewhere.
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
assert.ok(csp, 'the bundle sets its own Content-Security-Policy');
assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*(?!\.)/, 'no inline, eval or wildcard');
assert.match(csp, /script-src 'self'(;|$)/);
assert.match(csp, /connect-src 'self' https: wss:/, 'the relay is elsewhere, over TLS only');
assert.doesNotMatch(csp, /\bhttp:|\bws:/, 'no cleartext connections');
assert.ok(html.indexOf('/native.js') > 0 && html.indexOf('/native.js') < html.indexOf('/app.js'), 'the shim loads before the app');
assert.doesNotMatch(html, /rel="manifest"|apple-touch-icon/, 'no install metadata');
assert.doesNotMatch(html, /(?:src|href)="https?:/, 'nothing is loaded from the network');

// Segregation: the Android folder has its own package, and nothing outside it depends on it.
const own = JSON.parse(fs.readFileSync(path.join(root, 'android', 'package.json'), 'utf8'));
assert.equal(own.private, true);
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(!JSON.stringify(rootPkg).includes('capacitor'), 'the desktop app does not depend on Capacitor');
for (const dir of ['src', 'host', 'electron', 'shell', 'media']) {
	const hits = [];
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); } else if (/\.(ts|js|mjs|json)$/.test(e.name) && /\.\.\/android\/|['"]android\//.test(fs.readFileSync(p, 'utf8'))) { hits.push(p); }
		}
	}(path.join(root, dir)));
	assert.deepEqual(hits, [], `${dir}/ does not reference android/`);
}
assert.match(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'), /files:\n {2}- dist\/\*\*/, 'the desktop package is a whitelist that excludes android/');
const manifest = fs.readFileSync(path.join(root, 'android', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert.match(manifest, /android:allowBackup="false"/, 'device keys and tokens are not backed up');
assert.match(manifest, /android:usesCleartextTraffic="false"/);
const res = path.join(root, 'android', 'android', 'app', 'src', 'main', 'res');
assert.ok(!fs.existsSync(path.join(res, 'drawable', 'splash.png')), 'the stock Capacitor splash is gone');
assert.match(fs.readFileSync(path.join(res, 'values', 'styles.xml'), 'utf8'), /windowSplashScreenBackground/, 'the launch screen sets its own ground');
assert.match(fs.readFileSync(path.join(res, 'values-night', 'colors.xml'), 'utf8'), /#111114/, 'dark launch ground');
for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
	for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
		assert.ok(fs.statSync(path.join(res, `mipmap-${density}`, name)).size > 300, `${density}/${name} is drawn`);
	}
}
assert.ok(fs.existsSync(path.join(root, 'android', 'assets', 'icon-foreground.svg')), 'the icon source is kept beside the project');
const cap = JSON.parse(fs.readFileSync(path.join(root, 'android', 'capacitor.config.json'), 'utf8'));
assert.equal(cap.server.cleartext, false);
assert.equal(cap.android.allowMixedContent, false);
assert.equal(cap.server.url, undefined, 'the app is bundled, never loaded from a server');

fs.rmSync(out, { recursive: true, force: true });
console.log('test-android-web: all assertions passed');
