/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The local relay (src/remote/local/relayServer.ts + websocket.ts) run for real: a live HTTP
// server on loopback, driven by Node's own WebSocket client — someone else's framing code is the
// honest check on ours. Covers the whole path a phone takes: the app is served, a code is minted
// and claimed, messages route both ways, heartbeats are answered, VS Code leaving and returning
// is announced, revocation locks a device out, and the local-only hardening holds. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-local-relay.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LocalRelay, memoryStore, fileStore } = await import(new URL('../out/remote/local/relayServer.js', import.meta.url));

const pwaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stormcoder-pwa-'));
fs.writeFileSync(path.join(pwaDir, 'index.html'), '<!doctype html><title>Stormcoder Remote</title>');
fs.writeFileSync(path.join(pwaDir, 'app.js'), 'console.log(1);');

/** What a phone sends with its claim: the shape of its end-to-end key and proof (the relay checks shape only). */
const KEYS = { pub: 'P'.repeat(87), mac: 'M'.repeat(43) };
/** A fresh valid pairing code each time, as the desktop derives one from its pairing secret. */
let codeCounter = 0;
const nextCode = () => `ABCD${String(1000 + codeCounter++)}`;

const ROOM = 'ROOM1';
const HOST_TOKEN = 'host-token';
const store = memoryStore();
const relay = new LocalRelay({ pwaDir, pepper: 'test-pepper', store });
relay.registerRoom(ROOM, HOST_TOKEN);
const port = await relay.start();
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

/** Opens a socket whose messages can be awaited by predicate. */
function open(url, init) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, init);
		const inbox = [];
		const waiters = [];
		ws.closed = new Promise(res => ws.addEventListener('close', e => res(e.code)));
		ws.addEventListener('message', e => {
			const env = JSON.parse(e.data);
			const i = waiters.findIndex(w => w.pred(env));
			if (i >= 0) { waiters.splice(i, 1)[0].resolve(env); } else { inbox.push(env); }
		});
		ws.next = (pred, ms = 3000) => {
			const i = inbox.findIndex(pred);
			if (i >= 0) { return Promise.resolve(inbox.splice(i, 1)[0]); }
			return new Promise((res, rej) => {
				const timer = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms);
				waiters.push({ pred, resolve: v => { clearTimeout(timer); res(v); } });
			});
		};
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`could not open ${url}`)), { once: true });
	});
}
const control = (ws, p, seq = 1) => ws.send(JSON.stringify({ v: 1, t: 'c', seq, p }));
const isC = verb => env => env.t === 'c' && env.p?.c === verb;
const claim = code => fetch(`${base}/pair/claim?room=${ROOM}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Test phone', ...KEYS }) });

// The phone app is served, with /p/<room> routed to its index like the cloud relay's SPA assets.
assert.equal((await fetch(`${base}/app.js`)).status, 200);
assert.match(await (await fetch(`${base}/p/${ROOM}`)).text(), /Stormcoder Remote/);
assert.match(await (await fetch(`${base}/../../etc/passwd`)).text(), /Stormcoder Remote/, 'a path outside the app falls back to the index, never the filesystem');

// Host: a wrong token is refused; the right one gets welcome.
await assert.rejects(open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: 'Bearer nope' } }));
const host = await open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
control(host, { c: 'hello', role: 'host' });
assert.deepEqual((await host.next(isC('welcome'))).p, { c: 'welcome', lastSeq: 0 });

// Heartbeat: answered whatever seq it carries (the bug that dropped every link once a minute).
control(host, { c: 'ping' }, 7);
await host.next(isC('pong'));

// Pairing: an unknown room and a wrong code are refused; a minted code works exactly once.
assert.equal((await fetch(`${base}/pair/claim?room=NOPE`, { method: 'POST', body: '{"code":"X"}' })).status, 404);
assert.equal((await claim('WRONGCODE')).status, 403);
control(host, { c: 'pair', code: nextCode() });
const paired = await host.next(isC('paired'));
assert.match(paired.p.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
// The relay registers the code the desktop sent; it does not invent one.
assert.match(paired.p.code, /^ABCD1\d{3}$/);
const claimed = await claim(paired.p.code.toLowerCase());
assert.equal(claimed.status, 200, 'codes are accepted case-insensitively, as typed on a phone');
const { deviceId, token } = await claimed.json();
assert.equal((await claim(paired.p.code)).status, 403, 'a code is single-use');

// Phone connects: told the host is here; the host hears about its first connect.
const phone = await open(`${wsBase}/ws/client?room=${ROOM}&token=${encodeURIComponent(token)}`);
assert.deepEqual((await host.next(isC('deviceConnected'))).p, { c: 'deviceConnected', deviceId, name: 'Test phone', firstConnect: true });
control(phone, { c: 'hello', role: 'client' });
assert.equal((await phone.next(isC('welcome'))).p.hostOnline, true);

// App messages route host → phone and phone → host, verbatim — including a large one.
const big = 'x'.repeat(200_000);
host.send(JSON.stringify({ v: 1, t: 'm', seq: 2, p: { type: 'token', delta: big } }));
assert.equal((await phone.next(env => env.t === 'm')).p.delta.length, big.length);
phone.send(JSON.stringify({ v: 1, t: 'm', seq: 3, p: { type: 'ready' } }));
assert.equal((await host.next(env => env.t === 'm')).p.type, 'ready');

// Host endpoints refuse anything that came through the tunnel.
const devices = await fetch(`${base}/api/devices?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
assert.deepEqual((await devices.json()).devices.map(d => d.id), [deviceId]);
const tunneled = await fetch(`${base}/api/devices?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}`, 'Cf-Connecting-Ip': '203.0.113.9' } });
assert.equal(tunneled.status, 403, 'the device list is not reachable from the internet, even with the host token');
await assert.rejects(open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}`, 'Cf-Connecting-Ip': '203.0.113.9' } }));

// VS Code leaving and returning is announced to the phone.
host.close();
assert.equal((await phone.next(isC('hostStatus'))).p.online, false);
const host2 = await open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
assert.equal((await phone.next(isC('hostStatus'))).p.online, true);

// Revocation closes the device's live socket with 4001 and refuses it from then on.
control(host2, { c: 'revoke', deviceId });
assert.equal((await host2.next(isC('revoked'))).p.deviceId, deviceId);
assert.equal(await phone.closed, 4001);
await assert.rejects(open(`${wsBase}/ws/client?room=${ROOM}&token=${encodeURIComponent(token)}`));

host2.close();
// Hostile upgrade requests close the connection and nothing more: no uncaught exception, no socket
// held open (each one used to leak a file descriptor), and the relay keeps serving.
{
	const { connect } = await import('node:net');
	const uncaught = [];
	const onUncaught = err => uncaught.push(String(err));
	process.on('uncaughtException', onUncaught);
	const upgrade = target => new Promise(resolve => {
		const sock = connect(port, '127.0.0.1', () => {
			sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
		});
		let data = '';
		sock.on('data', d => { data += d; });
		const timer = setTimeout(() => { sock.destroy(); resolve({ closed: false, data }); }, 1500);
		sock.on('close', () => { clearTimeout(timer); resolve({ closed: true, data }); });
		sock.on('error', () => { });
	});
	for (const target of ['//', '/ws/client?room=__proto__&token=a.b', '/ws/client?room=constructor&token=a.b', '/ws/client?room=hasOwnProperty&token=x.y', '/ws/host?room=__proto__', 'http://[::1']) {
		const r = await upgrade(target);
		assert.ok(r.closed, `${target}: the connection must be closed, not held open`);
		assert.doesNotMatch(r.data, /101 Switching/, `${target} must not upgrade`);
	}
	await new Promise(r => setTimeout(r, 100));
	process.off('uncaughtException', onUncaught);
	assert.deepEqual(uncaught, [], 'hostile upgrade requests raise no uncaught exception');
	// Still serving, and a font file is served with a font type.
	fs.writeFileSync(path.join(pwaDir, 'f.woff2'), 'x');
	const font = await fetch(`${base}/f.woff2`);
	assert.equal(font.headers.get('content-type'), 'font/woff2');
	assert.equal((await fetch(`${base}/`)).status, 200);
}

await relay.stop();

// State survives a restart through the file store: a device paired before still authenticates.
{
	const file = path.join(pwaDir, 'state.json');
	const first = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	first.registerRoom(ROOM, HOST_TOKEN);
	const p1 = await first.start();
	const h = await open(`ws://127.0.0.1:${p1}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
	control(h, { c: 'pair', code: nextCode() });
	const code = (await h.next(isC('paired'))).p.code;
	const res = await fetch(`http://127.0.0.1:${p1}/pair/claim?room=${ROOM}`, { method: 'POST', body: JSON.stringify({ code, ...KEYS }) });
	const saved = (await res.json()).token;
	h.close();
	await first.stop();

	const second = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	second.registerRoom(ROOM, HOST_TOKEN);
	const p2 = await second.start();
	const again = await open(`ws://127.0.0.1:${p2}/ws/client?room=${ROOM}&token=${encodeURIComponent(saved)}`);
	again.close();
	await second.stop();
}

// Guessing pairing codes through the public tunnel is limited per source address: a wrong guess
// matches no code, so the per-code attempt count never saw it and nothing limited guessing at
// all. A guessing source is refused for a while; live codes are NOT withdrawn, so another
// source (the owner's phone) still pairs with the code it was shown.
{
	const r = new LocalRelay({ pwaDir, pepper: 'p', store: memoryStore() });
	r.registerRoom(ROOM, HOST_TOKEN);
	const port = await r.start();
	const h = await open(`ws://127.0.0.1:${port}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
	const claimAt = (code, ip) => fetch(`http://127.0.0.1:${port}/pair/claim?room=${ROOM}`, { method: 'POST', headers: { 'Cf-Connecting-Ip': ip }, body: JSON.stringify({ code, ...KEYS }) });
	control(h, { c: 'pair', code: nextCode() });
	const first = (await h.next(isC('paired'))).p.code;
	const statuses = [];
	for (let i = 0; i < 10; i++) {
		statuses.push((await claimAt(`WRONG${i}`, '203.0.113.9')).status);
	}
	assert.deepStrictEqual(statuses, [403, 403, 403, 403, 403, 403, 403, 403, 403, 429]);
	assert.equal((await claimAt(first, '203.0.113.9')).status, 429, 'the guessing source stays refused');
	assert.equal((await claimAt(first, '198.51.100.7')).status, 200, 'another source still claims the live code');

	// A malformed percent-escape in the path is the client's mistake: 400, not a 500.
	assert.equal((await fetch(`http://127.0.0.1:${port}/%E0%A4%A`)).status, 400);

	// The phone app cannot be framed by another site (a clickjacked Approve) or sniffed.
	const page = await fetch(`http://127.0.0.1:${port}/p/${ROOM}`);
	assert.deepStrictEqual(
		['x-frame-options', 'x-content-type-options', 'referrer-policy'].map(k => page.headers.get(k)),
		['DENY', 'nosniff', 'no-referrer'],
	);
	// ...and may only run and load its own files: no inline or eval'd script, no framing, no <base>,
	// no plugins, connections only back to itself (HTTP and WebSocket).
	const csp = page.headers.get('content-security-policy') ?? '';
	for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self' ws: wss:"]) {
		assert.ok(csp.includes(directive), `the policy has ${directive}: ${csp}`);
	}
	assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/, 'nothing is opened up');
	h.close();
	await r.stop();
}

// Two windows share one state file: each saves its own room without erasing the other's, and
// a revocation made in one is not undone by the other's later save.
{
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openvs-relay-shared-')), 'local-relay.json');
	const a = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	const b = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	a.registerRoom('ROOM-A', 'ta');
	b.registerRoom('ROOM-B', 'tb');
	const portA = await a.start();
	const portB = await b.start();
	const pairOn = async (relay, port, room, token) => {
		const host = await open(`ws://127.0.0.1:${port}/ws/host?room=${room}`, { headers: { Authorization: `Bearer ${token}` } });
		control(host, { c: 'pair', code: nextCode() });
		const code = (await host.next(isC('paired'))).p.code;
		const res = await fetch(`http://127.0.0.1:${port}/pair/claim?room=${room}`, { method: 'POST', body: JSON.stringify({ code, name: 'phone', ...KEYS }) });
		assert.equal(res.status, 200);
		return { host, ...(await res.json()) };
	};
	const pa = await pairOn(a, portA, 'ROOM-A', 'ta');
	const pb = await pairOn(b, portB, 'ROOM-B', 'tb');
	const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepStrictEqual(Object.keys(saved.rooms).sort(), ['ROOM-A', 'ROOM-B'], 'both windows\' rooms survive');
	assert.equal(saved.rooms['ROOM-A'].devices.length, 1);
	assert.equal(saved.rooms['ROOM-B'].devices.length, 1);
	control(pb.host, { c: 'revoke', deviceId: pb.deviceId });
	await pb.host.next(isC('revoked'));
	pa.host.close();
	const client = await open(`ws://127.0.0.1:${portA}/ws/client?room=ROOM-A&token=${encodeURIComponent(pa.token)}`);
	client.close();
	const after = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.notEqual(after.rooms['ROOM-B'].devices[0].revokedAt, null, 'a save from the other window kept the revocation');
	pb.host.close();
	await a.stop();
	await b.stop();
}

fs.rmSync(pwaDir, { recursive: true, force: true });
console.log('test-local-relay: all assertions passed');
