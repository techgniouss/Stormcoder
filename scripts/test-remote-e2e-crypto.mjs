/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The desktop half (src/remote/e2e.ts) and the phone half (openvs-relay/pwa/e2e.js) of the
// end-to-end encryption must agree byte for byte. Run: node scripts/build-tests.mjs && node scripts/test-remote-e2e-crypto.mjs
import assert from 'node:assert/strict';

const host = await import(new URL('../out/remote/e2e.js', import.meta.url));
const phone = await import(new URL('../openvs-relay/pwa/e2e.js', import.meta.url));
const { HostE2E, b32decode, b64u } = host;

/** In-memory stand-ins for the secret store and memento. */
function stores() {
	const secrets = new Map();
	const state = new Map();
	return {
		secrets,
		keys: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
		state: { get: k => (state.has(k) ? structuredClone(state.get(k)) : undefined), update: async (k, v) => { state.set(k, structuredClone(v)); } },
	};
}

/** Pairs a new phone with `e2e`; returns the phone's side. */
async function pair(e2e, deviceId, name = 'iPhone') {
	const pending = e2e.beginPairing();
	const done = await e2e.completePairing(pending);
	const ps = b32decode(done.secret);
	assert.equal(done.secret.length, host.PAIRING_SECRET_CHARS);
	assert.equal(await phone.deriveCode(ps), done.code, 'both sides derive the same relay code');
	const claim = await phone.makeClaim(ps, name);
	assert.ok(await e2e.acceptDevice(deviceId, name, claim.pub, claim.mac), 'a valid claim is accepted');
	const hs = e2e.handshakeFor(deviceId);
	assert.equal(hs.e, 0);
	const keys = await phone.completeHandshake({ ps, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId, hk: hs.hk, hm: hs.hm });
	return { ps, claim, keys, deviceId, out: { s: Date.now(), n: 0 }, guard: new phone.ReplayGuard() };
}

const phoneSend = (p, message) => phone.seal(p.keys.c2h, { deviceId: p.deviceId, dir: 'c2h', s: p.out.s, n: p.out.n++ }, message);
const phoneRecv = async (p, frame) => {
	const o = await phone.open(p.keys.h2c, { deviceId: p.deviceId, dir: 'h2c' }, frame);
	return p.guard.accept(o.s, o.n) ? o.message : undefined;
};

// Full pairing, then traffic both ways.
{
	const s = stores();
	const e2e = new HostE2E(s.keys, s.state);
	const p = await pair(e2e, 'dev1');
	assert.deepEqual(e2e.confirmedDevices(), [], 'not confirmed until the phone sends a valid frame');
	assert.deepEqual(await e2e.sealForAll({ type: 'x' }), [], 'nothing is sent to an unconfirmed device');
	const first = await e2e.openFrom(await phoneSend(p, { type: 'hello' }));
	assert.deepEqual(first, { deviceId: 'dev1', message: { type: 'hello' } });
	assert.deepEqual(e2e.confirmedDevices(), ['dev1']);
	assert.equal(e2e.handshakeFor('dev1'), undefined, 'no more handshakes once confirmed');
	const [frame] = await e2e.sealForAll({ type: 'token', delta: 'secret text' });
	assert.ok(!JSON.stringify(frame).includes('secret text'), 'the message is not in the frame');
	assert.deepEqual(await phoneRecv(p, frame), { type: 'token', delta: 'secret text' });
	// Replays, in both directions.
	assert.equal(await e2e.openFrom(await phoneSend(p, { n: 2 })).then(r => r?.message.n), 2);
	assert.equal(await phoneRecv(p, frame), undefined, 'a replayed desktop frame is dropped');
	const old = await phoneSend(p, { n: 3 });
	assert.ok(await e2e.openFrom(old));
	assert.equal(await e2e.openFrom(old), undefined, 'a replayed phone frame is dropped');
	// Tampering and misdirection.
	const bad = { ...(await phoneSend(p, { n: 4 })) };
	bad.c = bad.c.slice(0, -2) + (bad.c.endsWith('AA') ? 'BB' : 'AA');
	assert.equal(await e2e.openFrom(bad), undefined, 'a changed frame is dropped');
	const moved = { ...(await phoneSend(p, { n: 5 })), n: 99 };
	assert.equal(await e2e.openFrom(moved), undefined, 'a renumbered frame is dropped');
	const [again] = await e2e.sealForAll({ type: 'y' });
	await assert.rejects(() => phone.open(p.keys.c2h, { deviceId: 'dev1', dir: 'h2c' }, again), 'wrong key');
	await assert.rejects(() => phone.open(p.keys.h2c, { deviceId: 'other', dir: 'h2c' }, again), 'wrong device');
	await assert.rejects(() => phone.open(p.keys.h2c, { deviceId: 'dev1', dir: 'c2h' }, again), 'wrong direction');
	assert.equal(await e2e.openFrom({ e: 1, d: 'nobody', s: 1, n: 0, c: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), undefined, 'unknown device');
	assert.equal(await e2e.openFrom({ type: 'send', text: 'plaintext' }), undefined, 'plaintext is never accepted');
}

// Wrong pairing secret: the claim is refused, and so is a handshake made with another secret.
{
	const s = stores();
	const e2e = new HostE2E(s.keys, s.state);
	await e2e.completePairing(e2e.beginPairing());
	const claim = await phone.makeClaim(new Uint8Array(16).fill(7), 'Evil');
	assert.equal(await e2e.acceptDevice('evil', 'Evil', claim.pub, claim.mac), false);
	assert.equal(e2e.has('evil'), false);
	// A name changed after the claim breaks the MAC.
	const pending = e2e.beginPairing();
	const ps = b32decode(pending.secret);
	const good = await phone.makeClaim(ps, 'Alice');
	assert.equal(await e2e.acceptDevice('d', 'Mallory', good.pub, good.mac), false);
	// A relay that swaps in its own key pair cannot produce the host MAC.
	assert.equal(await e2e.acceptDevice('d', 'Alice', good.pub, good.mac), true);
	const hs = e2e.handshakeFor('d');
	const mitm = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const mitmPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', mitm.publicKey)));
	await assert.rejects(() => phone.completeHandshake({ ps, privateKey: good.privateKey, phonePub: good.phonePub, deviceId: 'd', hk: mitmPub, hm: hs.hm }));
	await assert.rejects(() => phone.completeHandshake({ ps, privateKey: good.privateKey, phonePub: good.phonePub, deviceId: 'other', hk: hs.hk, hm: hs.hm }), 'bound to the device id');
}

// An expired pairing is refused.
{
	const s = stores();
	let t = 1_000_000;
	const e2e = new HostE2E(s.keys, s.state, () => t);
	const pending = await e2e.completePairing(e2e.beginPairing());
	const claim = await phone.makeClaim(b32decode(pending.secret), 'Late');
	t += host.PAIRING_TTL_MS + 1;
	assert.equal(await e2e.acceptDevice('late', 'Late', claim.pub, claim.mac), false);
}

// A secret works once.
{
	const s = stores();
	const e2e = new HostE2E(s.keys, s.state);
	const pending = await e2e.completePairing(e2e.beginPairing());
	const ps = b32decode(pending.secret);
	const a = await phone.makeClaim(ps, 'A');
	const b = await phone.makeClaim(ps, 'B');
	assert.equal(await e2e.acceptDevice('a', 'A', a.pub, a.mac), true);
	assert.equal(await e2e.acceptDevice('b', 'B', b.pub, b.mac), false, 'a second phone cannot reuse the secret');
}

// Restart: state persists, a recorded frame is not accepted again, new streams work.
{
	const s = stores();
	let e2e = new HostE2E(s.keys, s.state);
	const p = await pair(e2e, 'dev1');
	const recorded = await phoneSend(p, { type: 'send', text: 'run it' });
	assert.ok(await e2e.openFrom(recorded));
	const [before] = await e2e.sealForAll({ type: 'a' });
	e2e = new HostE2E(s.keys, s.state);
	assert.deepEqual(e2e.confirmedDevices(), ['dev1']);
	assert.equal(await e2e.openFrom(recorded), undefined, 'a recorded frame is not replayable into a restarted desktop');
	const fresh = { ...p, out: { s: p.out.s + 1000, n: 0 } };
	assert.ok(await e2e.openFrom(await phoneSend(fresh, { type: 'again' })), 'a newer phone stream works');
	const [after] = await e2e.sealForAll({ type: 'b' });
	assert.ok(after.s > before.s, 'the desktop starts a newer stream');
	assert.ok(await phoneRecv(p, before), 'the phone accepts the old stream first');
	assert.ok(await phoneRecv(p, after), 'and then the newer one');
	assert.equal(await phoneRecv(p, before), undefined, 'but never goes back');
	assert.ok(![...s.secrets.values()].some(v => v.includes('"type"')), 'only keys are in the secret store');
}

// Several devices: each gets its own frame; unconfirmed and removed ones get none.
{
	const s = stores();
	const e2e = new HostE2E(s.keys, s.state);
	const a = await pair(e2e, 'a');
	const b = await pair(e2e, 'b');
	const c = await pair(e2e, 'c');
	await e2e.openFrom(await phoneSend(a, { hi: 1 }));
	await e2e.openFrom(await phoneSend(b, { hi: 1 }));
	const frames = await e2e.sealForAll({ type: 'z' });
	assert.deepEqual(frames.map(f => f.d).sort(), ['a', 'b'], 'the unconfirmed device gets nothing');
	assert.deepEqual(await phoneRecv(a, frames.find(f => f.d === 'a')), { type: 'z' });
	await assert.rejects(() => phoneRecv(a, frames.find(f => f.d === 'b')), "a device cannot read another's frame");
	await e2e.remove('b');
	assert.deepEqual((await e2e.sealForAll({ type: 'q' })).map(f => f.d), ['a']);
	assert.equal(await e2e.openFrom(await phoneSend(b, { late: 1 })), undefined, 'a removed device is ignored');
	assert.ok(![...s.secrets.keys()].some(k => k.endsWith('.b')), 'its keys are deleted');
	await e2e.removeAll();
	assert.deepEqual(e2e.confirmedDevices(), []);
	void c;
}

// The grouped secret is for typing and decodes to the same bytes.
{
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const secret = host.b32encode(bytes);
	assert.equal(secret.length, host.PAIRING_SECRET_CHARS);
	assert.equal(host.groupSecret(secret).replace(/[^0-9A-Z]/g, ''), secret);
	assert.deepEqual(b32decode(secret.toLowerCase()), bytes);
	assert.equal(phone.b32encode(bytes), secret);
	assert.deepEqual(phone.b32decode(secret), bytes);
}

console.log('test-remote-e2e-crypto: all assertions passed');
