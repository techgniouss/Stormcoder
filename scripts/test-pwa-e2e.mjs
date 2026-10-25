// Tests for the phone app's end-to-end encryption module (openvs-relay/pwa/e2e.js) against
// docs/REMOTE-E2E.md. The known-answer parts use Node's own crypto (createHmac, createECDH,
// hkdfSync, createCipheriv) so a mistake in the WebCrypto code cannot hide behind itself.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
	b64u, unb64u, b32encode, b32decode, deriveCode, makeClaim, completeHandshake, seal, open, ReplayGuard, nextStreamId,
} from '../openvs-relay/pwa/e2e.js';

let passed = 0;
/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		console.error(`FAIL: ${name}`);
		throw err;
	}
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {RegExp} [re]
 */
async function rejects(fn, re) {
	await assert.rejects(fn, re);
}

const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)))).digest();
const Z = Buffer.from([0]);
const ps = Uint8Array.from({ length: 16 }, (_, i) => i);
const deviceId = 'dev_0123456789abcdef';
const NAME = 'Pixel 8 · Chrome (Stormcoder PWA)';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Plays the desktop: given a claim, makes the host key pair and handshake frame, and the keys it derives with Node's crypto.
 * @param {{ pub: string, mac: string }} claim
 * @param {{ ps?: Uint8Array, deviceId?: string }} [over]
 */
function desktop(claim, over = {}) {
	const secret = Buffer.from(over.ps || ps);
	const id = over.deviceId || deviceId;
	const phonePub = Buffer.from(unb64u(claim.pub));
	assert.equal(Buffer.compare(hmac(secret, 'stormcoder-e2e-v1 claim', Z, phonePub, Z, NAME), Buffer.from(unb64u(claim.mac))), 0, 'claim MAC matches independent HMAC');
	const host = crypto.createECDH('prime256v1');
	host.generateKeys();
	const hostPub = host.getPublicKey();
	const shared = host.computeSecret(phonePub);
	const okm = Buffer.from(crypto.hkdfSync('sha256', shared, secret, Buffer.concat([Buffer.from('stormcoder-e2e-v1 keys'), Z, Buffer.from(id)]), 64));
	const hostMac = hmac(secret, 'stormcoder-e2e-v1 host', Z, Buffer.from(id), Z, hostPub, Z, phonePub);
	return {
		hk: b64u(hostPub), hm: b64u(hostMac), hostPub, hostMac, kC2H: okm.subarray(0, 32), kH2C: okm.subarray(32, 64),
	};
}

/**
 * Node-side AES-256-GCM seal producing the wire payload.
 * @param {Buffer} key
 * @param {string} dir
 * @param {string} id
 * @param {number} s
 * @param {number} n
 * @param {unknown} message
 */
function nodeSeal(key, dir, id, s, n, message) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(`stormcoder-e2e-v1 ${dir} ${id} ${s} ${n}`));
	const ct = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
	return { e: 1, d: id, s, n, c: b64u(Buffer.concat([iv, ct, cipher.getAuthTag()])) };
}

/**
 * Node-side open of a wire payload.
 * @param {Buffer} key
 * @param {string} dir
 * @param {string} id
 * @param {any} p
 */
function nodeOpen(key, dir, id, p) {
	const raw = Buffer.from(unb64u(p.c));
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	decipher.setAAD(Buffer.from(`stormcoder-e2e-v1 ${dir} ${id} ${p.s} ${p.n}`));
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

/** @returns {Promise<{ keys: { c2h: CryptoKey, h2c: CryptoKey }, host: ReturnType<typeof desktop> }>} */
async function pairedPair() {
	const claim = await makeClaim(ps, NAME);
	const host = desktop(claim);
	const keys = await completeHandshake({ ps, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId, hk: host.hk, hm: host.hm });
	return { keys, host };
}

// ---- Encodings ----------------------------------------------------------------------------------

await test('b64u round trips and has no padding or +/', () => {
	for (let len = 0; len < 70; len++) {
		const bytes = crypto.randomBytes(len);
		const text = b64u(bytes);
		assert.match(text, /^[A-Za-z0-9_-]*$/);
		assert.equal(text, bytes.toString('base64url'));
		assert.deepEqual(Buffer.from(unb64u(text)), bytes);
	}
	assert.equal(b64u(Uint8Array.from([0xfb, 0xff, 0xfe])), '-__-');
	assert.equal(b64u(new Uint8Array(0)), '');
});

await test('unb64u is strict', () => {
	assert.throws(() => unb64u('AA=='));
	assert.throws(() => unb64u('A'));
	assert.throws(() => unb64u('a+b/'));
	assert.throws(() => unb64u('a b'));
	assert.throws(() => unb64u(5));
});

await test('b32 known answers and round trip', () => {
	assert.equal(b32encode(new Uint8Array(16)), '0'.repeat(26));
	assert.equal(b32encode(Uint8Array.from([0xff])), 'ZW');
	assert.equal(b32encode(Uint8Array.from(Buffer.from('foobar'))), 'CSQPYRK1E8');
	for (let len = 0; len < 40; len++) {
		const bytes = crypto.randomBytes(len);
		const text = b32encode(bytes);
		assert.match(text, /^[0-9A-HJKMNP-TV-Z]*$/);
		assert.deepEqual(Buffer.from(b32decode(text)), bytes);
	}
	assert.equal(b32encode(ps).length, 26);
});

await test('b32decode is lenient and strict where it must be', () => {
	const text = b32encode(ps);
	const spaced = text.toLowerCase().replace(/(.{4})/g, '$1 - ').trim();
	assert.deepEqual(Buffer.from(b32decode(spaced)), Buffer.from(ps));
	assert.deepEqual(Buffer.from(b32decode('\tCSQP-YRK1 E8\n')), Buffer.from('foobar'));
	assert.deepEqual(b32decode('oOiIlL'), b32decode('001111'));
	for (const bad of ['U', 'CSQ*', 'abc!', 'é', '=']) {
		assert.throws(() => b32decode(bad), /invalid character/);
	}
	assert.equal(B32.length, 32);
});

// ---- deriveCode ---------------------------------------------------------------------------------

await test('deriveCode matches Node HMAC and is deterministic', async () => {
	const expected = b32encode(hmac(Buffer.from(ps), 'stormcoder-e2e-v1 code')).slice(0, 8);
	const code = await deriveCode(ps);
	assert.equal(code, expected);
	assert.equal(code.length, 8);
	assert.equal(await deriveCode(ps), code);
	const other = Uint8Array.from(ps);
	other[15] ^= 1;
	assert.notEqual(await deriveCode(other), code);
	// Independent Crockford check: re-encode the digest with a bit-string implementation.
	const bits = [...hmac(Buffer.from(ps), 'stormcoder-e2e-v1 code')].map(b => b.toString(2).padStart(8, '0')).join('');
	let manual = '';
	for (let i = 0; i < 8; i++) { manual += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]; }
	assert.equal(code, manual);
});

await test('deriveCode rejects bad secrets', async () => {
	await rejects(() => deriveCode(new Uint8Array(15)), /16 bytes/);
	await rejects(() => deriveCode(new Uint8Array(17)), /16 bytes/);
	await rejects(() => deriveCode('0123456789abcdef'), /Uint8Array/);
});

// ---- Claim and handshake --------------------------------------------------------------------------

await test('makeClaim produces a valid public key, a MAC and a non-extractable private key', async () => {
	const claim = await makeClaim(ps, NAME);
	const pub = unb64u(claim.pub);
	assert.equal(pub.length, 65);
	assert.equal(pub[0], 4);
	assert.deepEqual(Buffer.from(claim.phonePub), Buffer.from(pub));
	assert.equal(unb64u(claim.mac).length, 32);
	assert.equal(claim.privateKey.extractable, false);
	assert.deepEqual([...claim.privateKey.usages], ['deriveBits']);
	await rejects(() => crypto.subtle.exportKey('pkcs8', claim.privateKey));
	// Node must accept the point as being on the curve.
	const probe = crypto.createECDH('prime256v1');
	probe.generateKeys();
	probe.computeSecret(Buffer.from(pub));
	const second = await makeClaim(ps, NAME);
	assert.notEqual(second.pub, claim.pub);
	await rejects(() => makeClaim(new Uint8Array(8), NAME), /16 bytes/);
	await rejects(() => makeClaim(ps, 5), /string/);
	// The name is MACed exactly as given, including non-ASCII characters.
	const odd = await makeClaim(ps, 'Zoë’s phone');
	assert.equal(Buffer.compare(hmac(Buffer.from(ps), 'stormcoder-e2e-v1 claim', Z, Buffer.from(odd.phonePub), Z, 'Zoë’s phone'), Buffer.from(unb64u(odd.mac))), 0);
});

await test('handshake succeeds and yields non-extractable AES-GCM keys', async () => {
	const { keys } = await pairedPair();
	assert.equal(keys.c2h.extractable, false);
	assert.equal(keys.h2c.extractable, false);
	assert.deepEqual([...keys.c2h.usages], ['encrypt']);
	assert.deepEqual([...keys.h2c.usages], ['decrypt']);
	assert.equal(keys.c2h.algorithm.name, 'AES-GCM');
	assert.equal(keys.c2h.algorithm.length, 256);
});

await test('handshake is rejected for a wrong secret, device id, substituted host key, tampered MAC', async () => {
	const claim = await makeClaim(ps, NAME);
	const host = desktop(claim);
	const base = { ps, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId, hk: host.hk, hm: host.hm };
	await completeHandshake(base);

	const badPs = Uint8Array.from(ps);
	badPs[0] ^= 0x80;
	await rejects(() => completeHandshake({ ...base, ps: badPs }), /MAC/);
	await rejects(() => completeHandshake({ ...base, deviceId: `${deviceId}x` }), /MAC/);

	// A relay that swaps in its own key but cannot compute the MAC without ps.
	const evil = crypto.createECDH('prime256v1');
	evil.generateKeys();
	await rejects(() => completeHandshake({ ...base, hk: b64u(evil.getPublicKey()) }), /MAC/);
	// Even re-MACed with a guessed secret it fails.
	const guessed = b64u(hmac(Buffer.alloc(16, 7), 'stormcoder-e2e-v1 host', Z, Buffer.from(deviceId), Z, evil.getPublicKey(), Z, Buffer.from(claim.phonePub)));
	await rejects(() => completeHandshake({ ...base, hk: b64u(evil.getPublicKey()), hm: guessed }), /MAC/);

	// Every bit position of the MAC matters.
	const hm = Buffer.from(unb64u(host.hm));
	for (const i of [0, 15, 31]) {
		const t = Buffer.from(hm);
		t[i] ^= 1;
		await rejects(() => completeHandshake({ ...base, hm: b64u(t) }), /MAC/);
	}
	// MAC bound to this phone's key: a handshake meant for another phone fails.
	const otherClaim = await makeClaim(ps, NAME);
	await rejects(() => completeHandshake({ ...base, privateKey: otherClaim.privateKey, phonePub: otherClaim.phonePub }), /MAC/);
});

await test('handshake rejects malformed input', async () => {
	const claim = await makeClaim(ps, NAME);
	const host = desktop(claim);
	const base = { ps, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId, hk: host.hk, hm: host.hm };
	await rejects(() => completeHandshake(undefined));
	await rejects(() => completeHandshake({ ...base, hm: '' }), /malformed/);
	await rejects(() => completeHandshake({ ...base, hm: 'not base64!' }), /malformed/);
	await rejects(() => completeHandshake({ ...base, hk: b64u(new Uint8Array(65)) }), /uncompressed/);
	await rejects(() => completeHandshake({ ...base, hk: b64u(host.hostPub.subarray(0, 64)) }), /65-byte/);
	await rejects(() => completeHandshake({ ...base, hk: undefined }), /malformed/);
	await rejects(() => completeHandshake({ ...base, ps: new Uint8Array(15) }), /16 bytes/);
	await rejects(() => completeHandshake({ ...base, phonePub: claim.phonePub.subarray(0, 64) }), /65-byte/);
	await rejects(() => completeHandshake({ ...base, deviceId: '' }), /empty/);
	await rejects(() => completeHandshake({ ...base, deviceId: 7 }), /string/);
	// A point that is not on the curve, with a MAC that would otherwise be valid, is refused by ECDH.
	const offCurve = Buffer.alloc(65, 1);
	offCurve[0] = 4;
	const hm = b64u(hmac(Buffer.from(ps), 'stormcoder-e2e-v1 host', Z, Buffer.from(deviceId), Z, offCurve, Z, Buffer.from(claim.phonePub)));
	await rejects(() => completeHandshake({ ...base, hk: b64u(offCurve), hm }));
});

// ---- Known-answer interop with Node's crypto ------------------------------------------------------

await test('keys derived by WebCrypto equal keys derived by Node (both directions)', async () => {
	const { keys, host } = await pairedPair();
	// Node seals h2c with its independently derived kH2C; e2e.open must read it.
	const fromHost = nodeSeal(host.kH2C, 'h2c', deviceId, 1700000000000, 0, { type: 'hello', text: 'héllo \u{1F600}' });
	const got = await open(keys.h2c, { deviceId, dir: 'h2c' }, fromHost);
	assert.deepEqual(got, { s: 1700000000000, n: 0, message: { type: 'hello', text: 'héllo \u{1F600}' } });
	// e2e.seal with c2h; Node decrypts with its independently derived kC2H.
	const sealed = await seal(keys.c2h, { deviceId, dir: 'c2h', s: 1700000000001, n: 7 }, { type: 'send', text: 'ünï' });
	assert.deepEqual(nodeOpen(host.kC2H, 'c2h', deviceId, sealed), { type: 'send', text: 'ünï' });
	// The two directions use different keys.
	assert.notDeepEqual(Buffer.from(host.kC2H), Buffer.from(host.kH2C));
	assert.throws(() => nodeOpen(host.kH2C, 'c2h', deviceId, sealed));
	// Wire shape.
	assert.deepEqual(Object.keys(sealed).sort(), ['c', 'd', 'e', 'n', 's']);
	assert.equal(sealed.e, 1);
	assert.equal(sealed.d, deviceId);
	const raw = unb64u(sealed.c);
	assert.equal(raw.length, 12 + Buffer.byteLength(JSON.stringify({ type: 'send', text: 'ünï' })) + 16);
});

await test('HKDF inputs matter: a different salt or info gives different keys', async () => {
	const claim = await makeClaim(ps, NAME);
	const host = desktop(claim);
	const keys = await completeHandshake({ ps, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId, hk: host.hk, hm: host.hm });
	// Keys Node would derive with a different info string must not interoperate.
	const wrong = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 3), Buffer.from(ps), Buffer.from('stormcoder-e2e-v1 keys'), 64));
	const p = nodeSeal(wrong.subarray(32), 'h2c', deviceId, 5, 0, { a: 1 });
	await rejects(() => open(keys.h2c, { deviceId, dir: 'h2c' }, p), /authentication/);
});

// ---- Seal / open --------------------------------------------------------------------------------

await test('seal/open round trip across many shapes', async () => {
	const { keys, host } = await pairedPair();
	const messages = [{ type: 'ready' }, { type: 'send', text: 'x'.repeat(100000) }, { a: [1, 2, { b: null }], c: 'ü \u{1F4A5}' }, [], 'str', 5, null, true];
	for (const [i, m] of messages.entries()) {
		const frame = nodeSeal(host.kH2C, 'h2c', deviceId, 10, i, m);
		assert.deepEqual((await open(keys.h2c, { deviceId, dir: 'h2c' }, frame)).message, m);
		const out = await seal(keys.c2h, { deviceId, dir: 'c2h', s: 10, n: i }, m);
		assert.deepEqual(nodeOpen(host.kC2H, 'c2h', deviceId, out), m);
	}
});

await test('seal uses a fresh IV every time', async () => {
	const { keys } = await pairedPair();
	const meta = { deviceId, dir: 'c2h', s: 1, n: 0 };
	const ivs = new Set();
	for (let i = 0; i < 50; i++) {
		const f = await seal(keys.c2h, meta, { x: 1 });
		ivs.add(Buffer.from(unb64u(f.c).subarray(0, 12)).toString('hex'));
	}
	assert.equal(ivs.size, 50);
});

await test('open fails on any tampered byte of c, wrong key, wrong dir, wrong d, and AAD binding of s and n', async () => {
	const { keys, host } = await pairedPair();
	const meta = { deviceId, dir: 'h2c' };
	const frame = nodeSeal(host.kH2C, 'h2c', deviceId, 500, 3, { type: 'config', n: 1 });
	await open(keys.h2c, meta, frame);

	const raw = Buffer.from(unb64u(frame.c));
	for (let i = 0; i < raw.length; i++) {
		const t = Buffer.from(raw);
		t[i] ^= 0x01;
		await rejects(() => open(keys.h2c, meta, { ...frame, c: b64u(t) }), /authentication/);
	}
	await rejects(() => open(keys.h2c, meta, { ...frame, c: b64u(raw.subarray(0, raw.length - 1)) }), /authentication/);
	await rejects(() => open(keys.h2c, meta, { ...frame, c: b64u(Buffer.concat([raw, Buffer.from([0])])) }), /authentication/);
	await rejects(() => open(keys.h2c, meta, { ...frame, c: b64u(raw.subarray(0, 20)) }), /malformed/);
	await rejects(() => open(keys.h2c, meta, { ...frame, c: '' }), /malformed/);

	// Wrong direction (frame sealed as c2h with the same key material is not accepted as h2c).
	const asC2h = nodeSeal(host.kH2C, 'c2h', deviceId, 500, 3, { a: 1 });
	await rejects(() => open(keys.h2c, meta, asC2h), /authentication/);
	await rejects(() => open(keys.h2c, { deviceId, dir: 'c2h' }, frame), /authentication/);
	// Wrong key.
	const other = await pairedPair();
	await rejects(() => open(other.keys.h2c, meta, frame), /authentication/);
	// Wrong device: payload d, and AAD d.
	await rejects(() => open(keys.h2c, meta, { ...frame, d: 'dev_other' }), /not for this device/);
	await rejects(() => open(keys.h2c, { deviceId: 'dev_other', dir: 'h2c' }, frame), /not for this device/);
	const sameDifferentAad = nodeSeal(host.kH2C, 'h2c', 'dev_other', 500, 3, { a: 1 });
	await rejects(() => open(keys.h2c, meta, { ...sameDifferentAad, d: deviceId }), /authentication/);
	// s and n are authenticated.
	await rejects(() => open(keys.h2c, meta, { ...frame, s: 501 }), /authentication/);
	await rejects(() => open(keys.h2c, meta, { ...frame, n: 4 }), /authentication/);
	// Malformed payloads.
	for (const bad of [null, undefined, 'x', 5, {}, { ...frame, e: 0 }, { ...frame, e: 2 }, { ...frame, e: '1' }, { ...frame, s: -1 }, { ...frame, s: 1.5 }, { ...frame, n: NaN }, { ...frame, n: '3' }, { ...frame, c: 5 }, { ...frame, c: 'a b' }]) {
		await rejects(() => open(keys.h2c, meta, bad));
	}
	await rejects(() => open(keys.h2c, { deviceId, dir: 'x' }, frame), /direction/);
	await rejects(() => open(keys.h2c, undefined, frame));
});

await test('open rejects a frame whose plaintext is not JSON', async () => {
	const { keys, host } = await pairedPair();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', host.kH2C, iv);
	cipher.setAAD(Buffer.from(`stormcoder-e2e-v1 h2c ${deviceId} 1 1`));
	const ct = Buffer.concat([cipher.update('{nope', 'utf8'), cipher.final()]);
	const frame = { e: 1, d: deviceId, s: 1, n: 1, c: b64u(Buffer.concat([iv, ct, cipher.getAuthTag()])) };
	await rejects(() => open(keys.h2c, { deviceId, dir: 'h2c' }, frame), /malformed message/);
});

await test('seal validates its inputs', async () => {
	const { keys } = await pairedPair();
	const ok = { deviceId, dir: 'c2h', s: 1, n: 0 };
	await seal(keys.c2h, ok, {});
	await rejects(() => seal(keys.c2h, { ...ok, dir: 'x' }, {}), /direction/);
	await rejects(() => seal(keys.c2h, { ...ok, s: -1 }, {}), /non-negative/);
	await rejects(() => seal(keys.c2h, { ...ok, s: 1.5 }, {}), /non-negative/);
	await rejects(() => seal(keys.c2h, { ...ok, n: NaN }, {}), /non-negative/);
	await rejects(() => seal(keys.c2h, { ...ok, deviceId: '' }, {}), /empty/);
	await rejects(() => seal(keys.c2h, { ...ok, deviceId: 1 }, {}), /string/);
	await rejects(() => seal(keys.c2h, ok, undefined), /serializ/);
	// The decrypt-only key cannot seal.
	await rejects(() => seal(keys.h2c, ok, {}));
	// The encrypt-only key cannot open.
	await rejects(() => open(keys.c2h, { deviceId, dir: 'c2h' }, { e: 1, d: deviceId, s: 1, n: 0, c: b64u(new Uint8Array(40)) }));
});

// ---- ReplayGuard and stream ids -------------------------------------------------------------------

await test('ReplayGuard rules', () => {
	const g = new ReplayGuard();
	assert.equal(g.accept(100, 0), true);
	assert.equal(g.accept(100, 0), false, 'equal (s,n) rejected');
	assert.equal(g.accept(100, 1), true);
	assert.equal(g.accept(100, 5), true, 'gaps allowed');
	assert.equal(g.accept(100, 3), false, 'reorder rejected');
	assert.equal(g.accept(99, 99), false, 'old stream rejected');
	assert.equal(g.accept(101, 0), true, 'new stream resets n');
	assert.equal(g.accept(100, 100), false, 'old stream stays rejected after a newer one');
	assert.equal(g.accept(101, 0), false);
	assert.equal(g.accept(101, 1), true);
	assert.deepEqual(g.state(), { s: 101, n: 1 });
	// Rejects leave state untouched.
	g.accept(50, 50);
	assert.deepEqual(g.state(), { s: 101, n: 1 });
	for (const [s, n] of [[NaN, 1], [1, NaN], [-1, 0], [200, -1], [1.5, 0], [200, 1.5], [Infinity, 0], ['200', 1], [200, '1'], [undefined, 0], [null, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
		assert.equal(g.accept(s, n), false, `reject ${String(s)},${String(n)}`);
	}
	assert.deepEqual(g.state(), { s: 101, n: 1 });
});

await test('ReplayGuard interleaved streams and restore', () => {
	const g = new ReplayGuard();
	assert.equal(g.accept(10, 0), true);
	assert.equal(g.accept(20, 0), true);
	assert.equal(g.accept(10, 1), false, 'stream 10 is dead once 20 was seen');
	assert.equal(g.accept(20, 1), true);
	const restored = new ReplayGuard(g.state());
	assert.equal(restored.accept(20, 1), false);
	assert.equal(restored.accept(20, 2), true);
	assert.equal(restored.accept(19, 1000), false);
	assert.equal(restored.accept(21, 0), true);
	// Invalid stored state starts fresh rather than throwing.
	for (const junk of [undefined, null, {}, { s: 'a', n: 1 }, { s: -5, n: 0 }, { s: 1.5, n: 0 }]) {
		const f = new ReplayGuard(junk);
		assert.equal(f.accept(0, 0), true);
	}
});

await test('nextStreamId', () => {
	assert.equal(nextStreamId(0, 1000), 1000);
	assert.equal(nextStreamId(999, 1000), 1000);
	assert.equal(nextStreamId(1000, 1000), 1001);
	assert.equal(nextStreamId(5000, 1000), 5001);
	assert.equal(nextStreamId(Number.NaN, 1000), 1000);
	const before = Date.now();
	const id = nextStreamId(0);
	assert.ok(id >= before && id <= Date.now() + 1);
	assert.equal(nextStreamId(id + 1e6), id + 1e6 + 1);
});

// ---- Full flow ----------------------------------------------------------------------------------

await test('end to end: derived code, claim, handshake, conversation with replay protection', async () => {
	const secret = crypto.randomBytes(16);
	const text = b32encode(secret);
	const phoneSecret = b32decode(text.toLowerCase());
	assert.equal(phoneSecret.length, 16);
	assert.equal(await deriveCode(phoneSecret), b32encode(hmac(secret, 'stormcoder-e2e-v1 code')).slice(0, 8));
	const id = 'dev_flow';
	const claim = await makeClaim(phoneSecret, NAME);
	const host = desktop(claim, { ps: secret, deviceId: id });
	const keys = await completeHandshake({ ps: phoneSecret, privateKey: claim.privateKey, phonePub: claim.phonePub, deviceId: id, hk: host.hk, hm: host.hm });
	const guard = new ReplayGuard();
	let s = nextStreamId(0);
	const frames = [0, 1, 2].map(n => nodeSeal(host.kH2C, 'h2c', id, s, n, { type: 'sessions', n }));
	for (const f of frames) {
		const o = await open(keys.h2c, { deviceId: id, dir: 'h2c' }, f);
		assert.equal(guard.accept(o.s, o.n), true);
	}
	const replay = await open(keys.h2c, { deviceId: id, dir: 'h2c' }, frames[1]);
	assert.equal(guard.accept(replay.s, replay.n), false);
	s = nextStreamId(s, s);
	const fresh = await open(keys.h2c, { deviceId: id, dir: 'h2c' }, nodeSeal(host.kH2C, 'h2c', id, s, 0, { type: 'done' }));
	assert.equal(guard.accept(fresh.s, fresh.n), true);
});

console.log(`pwa e2e: ${passed} tests passed`);
