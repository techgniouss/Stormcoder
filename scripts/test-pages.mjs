// Visual replies (host/pages.ts): the policy a page the agent wrote is served with, and what
// counts as a page id. The policy is the whole safety story for model-written HTML, so it is
// pinned here word by word.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-pages-'));
await esbuild.build({ entryPoints: [path.join(root, 'host/pages.ts')], outfile: path.join(tmp, 'pages.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const { PAGE_CSP, PAGE_HEADERS, MAX_PAGE_BYTES, isPageId, MISSING_PAGE } = createRequire(import.meta.url)(path.join(tmp, 'pages.cjs'));

const directives = Object.fromEntries(PAGE_CSP.split(';').map(d => d.trim()).map(d => [d.split(' ')[0], d.split(' ').slice(1)]));
// Scripts may run, and nothing else is granted: no same-origin, forms, popups or top navigation.
assert.deepEqual(directives.sandbox, ['allow-scripts']);
// Nothing is fetched from anywhere.
assert.deepEqual(directives['default-src'], ["'none'"]);
assert.deepEqual(directives['script-src'], ["'unsafe-inline'"]);
assert.deepEqual(directives['style-src'], ["'unsafe-inline'"]);
assert.deepEqual(directives['img-src'], ['data:']);
assert.deepEqual(directives['font-src'], ['data:']);
assert.deepEqual(directives['base-uri'], ["'none'"]);
assert.deepEqual(directives['form-action'], ["'none'"]);
for (const never of ['connect-src', 'frame-src', 'media-src', 'object-src', 'worker-src']) {
	assert.equal(directives[never], undefined, `${never} is left to default-src 'none'`);
}
assert.ok(!/https?:|\*|blob:|allow-same-origin|allow-top-navigation|allow-popups|allow-forms|unsafe-eval/.test(PAGE_CSP), 'no network source and no extra sandbox permission');

assert.equal(PAGE_HEADERS['content-security-policy'], PAGE_CSP);
assert.equal(PAGE_HEADERS['x-content-type-options'], 'nosniff');
assert.equal(PAGE_HEADERS['referrer-policy'], 'no-referrer');
assert.equal(PAGE_HEADERS['cache-control'], 'no-store');
assert.match(PAGE_HEADERS['content-type'], /^text\/html/);
assert.equal(MAX_PAGE_BYTES, 512 * 1024);
assert.ok(!/<script/i.test(MISSING_PAGE));

assert.equal(isPageId('0123456789abcdef'), true);
for (const bad of ['', '0123456789abcde', '0123456789abcdef0', '0123456789ABCDEF', '../../etc/passwd', '0123456789abcde/', 'view', undefined, null, 16, ['0123456789abcdef']]) {
	assert.equal(isPageId(bad), false, `refuses ${String(bad)}`);
}

// The chat frame may embed pages from the page route and nothing else; both hosts serve the
// route with these headers; the chat ignores messages a frame posts.
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
assert.match(read('electron/viewHtml.ts'), /frame-src \$\{ASSET_ORIGIN\}\/page\//);
for (const hostFile of ['electron/main.ts', 'electron/devHost.ts']) {
	assert.match(read(hostFile), /parts\[0\] === 'page'[\s\S]{0,400}PAGE_HEADERS/, `${hostFile} serves pages with the sealed headers`);
}
assert.match(read('electron/main.ts'), /will-frame-navigate/, 'frames cannot navigate off the asset origin');
assert.match(read('shell/bridge.js'), /e\.source && e\.source !== parent\) \{ e\.stopImmediatePropagation\(\); return; \}/);
assert.match(read('media/main.js'), /event\.source && event\.source !== window && event\.source !== window\.parent\) \{ return; \}/);
const frame = /function appendPageEl\(page\) \{([\s\S]*?)\n\t\}/.exec(read('media/main.js'));
assert.ok(frame && frame[1].includes("setAttribute('sandbox', 'allow-scripts')"), 'the frame is sandboxed with scripts only');
assert.ok(!/allow-same-origin|srcdoc|innerHTML/.test(frame[1]), 'the HTML never passes through the chat script');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-pages: all assertions passed');
