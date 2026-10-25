/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The Android shell's web bundle (android/www) in a phone-sized Chromium, with the shell's
// contract (`globalThis.StormcoderNative`) supplied by the test. The bundle is served from one
// origin and the relay lives on another over TLS, as in the APK; the fake relay answers like the
// real one (and allows cross-origin calls, which Capacitor's native HTTP does for the app). The
// "desktop" behind it is the real HostE2E, so pairing and the encryption are the real thing.
//   node test/android-shell.mjs        (needs `npm run build` first for out/)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { launchChromium } from './browser.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const { HostE2E, b32decode, deriveCode } = await import(new URL('../out/remote/e2e.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-shell-'));

// ---- The bundle ----------------------------------------------------------------------------------
const www = path.join(tmp, 'www');
assert.equal(spawnSync(process.execPath, [path.join(root, 'android', 'scripts', 'build-web.mjs'), '--out', www]).status, 0);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const appServer = http.createServer((req, res) => {
	const name = new URL(req.url, 'http://x').pathname.replace(/^\/p\/.*/, '/index.html');
	const file = path.join(www, name === '/' ? 'index.html' : name);
	if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
	res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
});
await new Promise(r => appServer.listen(0, '127.0.0.1', r));
const appOrigin = `http://127.0.0.1:${appServer.address().port}`;

// ---- The fake desktop and relay -------------------------------------------------------------------
const secrets = new Map();
const mem = new Map();
const desktop = new HostE2E(
	{ get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
	{ get: k => mem.get(k), update: async (k, v) => { mem.set(k, v); } });
const pairing = await desktop.completePairing(desktop.beginPairing());
const relayCode = await deriveCode(b32decode(pairing.secret));

execKeys();
function execKeys() {
	const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'),
		'-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
}
const claims = [];
const sockets = [];
const received = [];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const relay = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
	const url = new URL(req.url, 'https://x');
	if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
	if (req.method === 'POST' && url.pathname === '/pair/claim') {
		let body = '';
		req.on('data', c => { body += c; });
		req.on('end', async () => {
			const claim = JSON.parse(body);
			claims.push({ room: url.searchParams.get('room'), origin: req.headers.origin, ...claim });
			if (claim.code !== relayCode || !await desktop.acceptDevice('dev1', claim.name, claim.pub, claim.mac)) {
				res.writeHead(403, cors).end('invalid or already-used code');
				return;
			}
			res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ deviceId: 'dev1', token: 'tok-1' }));
		});
		return;
	}
	res.writeHead(404, cors).end();
});
const wss = new WebSocketServer({ noServer: true });
relay.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url, 'https://x');
	if (url.pathname !== '/ws/client' || url.searchParams.get('token') !== 'tok-1') { socket.destroy(); return; }
	wss.handleUpgrade(req, socket, head, ws => {
		sockets.push(ws);
		let seq = 0;
		const send = (t, p) => ws.send(JSON.stringify({ v: 1, t, seq: ++seq, p }));
		ws.on('message', async data => {
			const env = JSON.parse(String(data));
			if (env.t === 'c' && env.p.c === 'hello') {
				send('c', { c: 'welcome', lastSeq: 0, hostOnline: true });
				const hs = desktop.handshakeFor('dev1');
				if (hs) { send('m', hs); }
			} else if (env.t === 'm') {
				const opened = await desktop.openFrom(env.p);
				if (opened) { received.push(opened.message); }
			}
		});
	});
});
await new Promise(r => relay.listen(0, '127.0.0.1', r));
const relayOrigin = `https://127.0.0.1:${relay.address().port}`;
const link = `${relayOrigin}/p/room1#${pairing.secret}`;

// ---- The phone ---------------------------------------------------------------------------------
const browser = await launchChromium();
const errors = [];
let scanLink = link;
try {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
	const phone = await context.newPage();
	phone.on('pageerror', e => errors.push(e.message));
	phone.on('console', m => { if (/Content[- ]Security[- ]Policy|violates the following/i.test(m.text())) { errors.push(m.text()); } });
	await phone.exposeFunction('nextScan', () => scanLink);
	await phone.addInitScript(() => {
		globalThis.StormcoderNative = Object.freeze({ platform: 'android', scanQr: () => globalThis.nextScan() });
	});
	await phone.goto(`${appOrigin}/`);
	await phone.locator('#pairScreen:not([hidden])').waitFor();
	assert.equal(await phone.locator('#scanBtn').isVisible(), true, 'the scan button appears only inside the shell');
	assert.equal(await phone.locator('.pair-note').isVisible(), false, 'the add-to-home-screen advice is hidden in the app');

	// Things that must not pair.
	const tryInput = async text => {
		await phone.fill('#pairCode', text);
		await phone.tap('#pairForm button[type=submit]');
		await phone.locator('#pairError', { hasText: /\S/ }).waitFor({ timeout: 5000 });
		return (await phone.locator('#pairError').textContent()).trim();
	};
	assert.match(await tryInput(link.replace('https:', 'http:')), /not an https link/, 'a cleartext link is refused');
	assert.match(await tryInput(pairing.secret), /whole pairing link/, 'a bare key cannot say where the relay is');
	assert.equal(claims.length, 0, 'nothing reached the relay yet');

	// Scan the QR code.
	await phone.tap('#scanBtn');
	await phone.locator('#app:not([hidden])').waitFor({ timeout: 15000 });
	await phone.locator('#status.status-ok').waitFor({ timeout: 15000 });
	assert.equal(claims.length, 1);
	assert.equal(claims[0].room, 'room1');
	assert.equal(claims[0].origin, appOrigin, 'the claim comes from the bundled app, to the relay named in the link');
	assert.equal(new URL(claims[0].origin).host === new URL(relayOrigin).host, false, 'the relay is not the app origin');
	assert.ok(!JSON.stringify(claims[0]).includes(pairing.secret), 'the pairing key was not sent');
	for (let i = 0; i < 100 && !received.length; i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.ok(received.length > 0, 'the desktop received sealed messages from the app');
	assert.ok(received.every(m => typeof m.type === 'string'));
	assert.equal(await phone.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, 'no service worker in the app');
	const stored = JSON.parse(await phone.evaluate(() => localStorage.getItem('openvsRelay.device.room1')));
	assert.equal(stored.origin, relayOrigin, 'the relay address is remembered with the device');
	assert.equal(stored.token, 'tok-1');

	// The desktop names itself, and the controls the phone shows are the ones the redesign promises.
	const push = async message => { for (const f of await desktop.sealForAll(message)) { for (const w of sockets) { w.send(JSON.stringify({ v: 1, t: 'm', seq: 900000 + Math.floor(Math.random() * 90000), p: f })); } } };
	await push({ type: 'config', workspaceName: 'demo-project', selectedProvider: 'p', providers: [{ id: 'p', label: 'P', model: 'm1', suggestedModels: ['m1'] }] });
	await push({ type: 'sessions', activeSessionId: 's1', sessions: [{ id: 's1', title: 'One', mode: 'ask', streaming: false, queue: [] }] });
	await push({ type: 'transcript', sessionId: 's1', from: 0, total: 1, truncated: false, messages: [{ role: 'assistant', content: '```js\nconst a = 1;\n```' }] });
	await phone.locator('#status', { hasText: '· demo-project' }).waitFor({ timeout: 10000 });
	assert.equal(await phone.locator('#tabs .tab').count(), 0, 'one chat shows no tab strip');
	assert.equal(await phone.locator('#providerSelect').isVisible(), true, 'the provider picker is always there: provider on top, model below');
	const rows = async sel => (await phone.locator(sel).boundingBox());
	assert.ok((await rows('#modelSelect')).y > (await rows('#providerSelect')).y, 'the model picker sits below the provider picker');
	assert.equal(await phone.locator('#modeSeg .seg-btn[aria-checked=true]').textContent(), 'Ask');
	received.length = 0;
	await phone.locator('#modeSeg .seg-btn', { hasText: 'Plan' }).tap();
	for (let i = 0; i < 50 && !received.some(m => m.type === 'setMode'); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.ok(received.some(m => m.type === 'setMode' && m.mode === 'plan'), 'the segmented control changes the mode');
	assert.equal(await phone.locator('.md-code .md-copy').count(), 1, 'a code block has a Copy button');
	// The model list is an in-app sheet with full names, not the OS popup.
	await push({ type: 'models', provider: 'p', models: [{ id: 'm1', tools: true }, { id: 'a-very-long-model-identifier-2026-10-24-preview', tools: true }] });
	await phone.locator('#modelSelect').tap();
	await phone.locator('.sheet [role=option]').first().waitFor({ timeout: 5000 });
	const names = await phone.locator('.sheet [role=option]').allTextContents();
	assert.ok(names.some(n => n.includes('a-very-long-model-identifier-2026-10-24-preview')), 'a long model id is shown in full');
	assert.equal(await phone.locator('.sheet [aria-selected=true]').count(), 1, 'the current model is marked');
	received.length = 0;
	await phone.locator('.sheet [role=option]', { hasText: 'a-very-long' }).tap();
	await phone.locator('.sheet').waitFor({ state: 'detached' });
	for (let i = 0; i < 50 && !received.some(m => m.type === 'setModel'); i++) { await new Promise(r => setTimeout(r, 100)); }
	assert.ok(received.some(m => m.type === 'setModel' && /a-very-long/.test(m.model)), 'choosing a model tells the desktop');
	await phone.locator('#providerSelect').tap();
	await phone.locator('.sheet').waitFor();
	assert.equal(await phone.evaluate(() => { const d = { handled: false }; window.dispatchEvent(new CustomEvent('stormcoder:back', { detail: d })); return d.handled; }), true, 'Back closes the sheet');
	assert.equal(await phone.locator('.sheet').count(), 0);
	// The Back button closes what is open before it would leave the app.
	const back = () => phone.evaluate(() => { const detail = { handled: false }; window.dispatchEvent(new CustomEvent('stormcoder:back', { detail })); return detail.handled; });
	assert.equal(await back(), false, 'nothing open: the shell may leave the app');
	await phone.locator('#historyBtn').tap();
	assert.equal(await back(), true, 'Back closes History first');
	assert.equal(await phone.locator('#historyPanel').isVisible(), false);

	// Reopen the app: it goes straight back to the relay it paired with.
	const before = sockets.length;
	await phone.goto(`${appOrigin}/`);
	await phone.locator('#app:not([hidden])').waitFor({ timeout: 15000 });
	await phone.locator('#status.status-ok').waitFor({ timeout: 15000 });
	assert.ok(sockets.length > before, 'a new connection went to the paired relay');
	assert.equal(await phone.locator('#pairScreen').isVisible(), false);
	assert.equal(claims.length, 1, 'no second pairing');

	// Unpair clears the remembered relay.
	await phone.locator('#unpairBtn').evaluate(b => b.click());
	await phone.locator('#pairScreen:not([hidden])').waitFor();
	assert.equal(await phone.evaluate(() => localStorage.getItem('openvsRelay.device.room1')), null);
	assert.deepEqual(errors, [], 'no script errors or policy violations');
} finally {
	await browser.close();
	for (const ws of sockets) { ws.terminate(); }
	relay.close();
	appServer.close();
	fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('android-shell: ok');
process.exit(0);
