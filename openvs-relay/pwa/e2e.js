// Stormcoder Remote: end-to-end encryption for the phone app.
//
// Pure functions that implement docs/REMOTE-E2E.md byte for byte. No DOM, no storage: only
// `globalThis.crypto` (WebCrypto), `btoa`/`atob` and `TextEncoder`, so the same file runs in the
// browser and under Node in tests. The desktop twin is src/remote/e2e.ts; the two must agree.
'use strict';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** Version prefix shared by every domain-separation string in the spec. */
const PREFIX = 'stormcoder-e2e-v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PS_LENGTH = 16;
const PUB_LENGTH = 65;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DIRECTIONS = ['c2h', 'h2c'];

/** @returns {SubtleCrypto} the WebCrypto subtle interface, or throws if the platform has none. */
function subtle() {
	const s = globalThis.crypto && globalThis.crypto.subtle;
	if (!s) { throw new Error('WebCrypto is not available'); }
	return s;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Uint8Array}
 */
function needBytes(value, what) {
	if (!(value instanceof Uint8Array)) { throw new Error(`${what} must be a Uint8Array`); }
	return value;
}

/**
 * @param {unknown} ps
 * @returns {Uint8Array} the same value, once it is known to be a 16-byte pairing secret
 */
function needPs(ps) {
	if (needBytes(ps, 'pairing secret').length !== PS_LENGTH) { throw new Error('pairing secret must be 16 bytes'); }
	return ps;
}

/**
 * @param {unknown} pub
 * @param {string} what
 * @returns {Uint8Array} the same value, once it is known to look like an uncompressed P-256 point
 */
function needPub(pub, what) {
	if (needBytes(pub, what).length !== PUB_LENGTH || pub[0] !== 0x04) { throw new Error(`${what} must be a 65-byte uncompressed P-256 point`); }
	return pub;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function needString(value, what) {
	if (typeof value !== 'string') { throw new Error(`${what} must be a string`); }
	return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {number}
 */
function needCounter(value, what) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { throw new Error(`${what} must be a non-negative integer`); }
	return value;
}

/**
 * Concatenates byte arrays and strings (UTF-8) into one array.
 * @param {(Uint8Array | string)[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
	const chunks = parts.map(p => typeof p === 'string' ? enc.encode(p) : p);
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) { out.set(c, at); at += c.length; }
	return out;
}

const ZERO = new Uint8Array([0]);

/**
 * Base64url without padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b64u(bytes) {
	needBytes(bytes, 'bytes');
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes base64url without padding. Strict: any other character, padding, or an impossible
 * length throws.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function unb64u(text) {
	needString(text, 'base64url text');
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) { throw new Error('invalid base64url'); }
	const std = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(std + '='.repeat((4 - std.length % 4) % 4));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) { out[i] = binary.charCodeAt(i); }
	return out;
}

/**
 * Crockford base32 (alphabet 0-9 A-Z without I L O U), no padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b32encode(bytes) {
	needBytes(bytes, 'bytes');
	let out = '';
	let acc = 0;
	let bits = 0;
	for (const byte of bytes) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(acc >>> (bits - 5)) & 31];
			bits -= 5;
		}
		acc &= (1 << bits) - 1;
	}
	if (bits > 0) { out += CROCKFORD[(acc << (5 - bits)) & 31]; }
	return out;
}

/**
 * Decodes Crockford base32 leniently: case-insensitive, spaces and hyphens ignored, `I` and `L`
 * read as `1`, `O` as `0`. Any other character throws. Leftover bits at the end are dropped.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function b32decode(text) {
	needString(text, 'base32 text');
	const clean = text.replace(/[\s-]+/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
	const out = [];
	let acc = 0;
	let bits = 0;
	for (const ch of clean) {
		const v = CROCKFORD.indexOf(ch);
		if (v < 0) { throw new Error('invalid character in key'); }
		acc = (acc << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((acc >>> (bits - 8)) & 255);
			bits -= 8;
		}
		acc &= (1 << bits) - 1;
	}
	return Uint8Array.from(out);
}

/**
 * HMAC-SHA-256 with `key` over the concatenation of `parts`.
 * @param {Uint8Array} key
 * @param {(Uint8Array | string)[]} parts
 * @returns {Promise<Uint8Array>}
 */
async function hmac(key, parts) {
	const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await subtle().sign('HMAC', k, concat(parts)));
}

/**
 * Compares two byte arrays without an early exit on the first difference.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
	if (a.length !== b.length) { return false; }
	let diff = 0;
	for (let i = 0; i < a.length; i++) { diff |= a[i] ^ b[i]; }
	return diff === 0;
}

/**
 * The relay's pairing code, derived from the pairing secret so the phone never types it:
 * `B32(HMAC(ps, "stormcoder-e2e-v1 code")).slice(0, 8)`.
 * @param {Uint8Array} ps 16-byte pairing secret
 * @returns {Promise<string>} 8 characters
 */
export async function deriveCode(ps) {
	needPs(ps);
	return b32encode(await hmac(ps, [`${PREFIX} code`])).slice(0, 8);
}

/**
 * Starts a pairing: makes the phone's P-256 key pair (private key non-extractable) and the claim
 * MAC `HMAC(ps, "stormcoder-e2e-v1 claim" || 0x00 || phonePub || 0x00 || name)`.
 * @param {Uint8Array} ps 16-byte pairing secret
 * @param {string} name device name, used exactly as it is sent to the relay
 * @returns {Promise<{ pub: string, mac: string, privateKey: CryptoKey, phonePub: Uint8Array }>}
 *   `pub` and `mac` are base64url, ready for the `/pair/claim` body
 */
export async function makeClaim(ps, name) {
	needPs(ps);
	needString(name, 'name');
	const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
	const phonePub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
	needPub(phonePub, 'generated public key');
	const mac = await hmac(ps, [`${PREFIX} claim`, ZERO, phonePub, ZERO, name]);
	return { pub: b64u(phonePub), mac: b64u(mac), privateKey: pair.privateKey, phonePub };
}

/**
 * Finishes a pairing from the desktop's handshake frame. Verifies `hm` (constant time), then
 * derives `shared = ECDH(phonePriv, hostPub)` and
 * `okm = HKDF(shared, salt = ps, info = "stormcoder-e2e-v1 keys" || 0x00 || deviceId, 64)`;
 * `c2h = okm[0..32)` and `h2c = okm[32..64)`. Returns non-extractable AES-GCM keys.
 * @param {{ ps: Uint8Array, privateKey: CryptoKey, phonePub: Uint8Array, deviceId: string, hk: string, hm: string }} args
 *   `hk` and `hm` are the base64url fields of the handshake frame
 * @returns {Promise<{ c2h: CryptoKey, h2c: CryptoKey }>}
 * @throws {Error} on malformed input or a MAC that does not match
 */
export async function completeHandshake(args) {
	if (!args || typeof args !== 'object') { throw new Error('handshake arguments are required'); }
	const { ps, privateKey, phonePub, deviceId, hk, hm } = args;
	needPs(ps);
	needPub(phonePub, 'phone public key');
	needString(deviceId, 'device id');
	if (!deviceId) { throw new Error('device id is empty'); }
	if (!privateKey || typeof privateKey !== 'object') { throw new Error('private key is required'); }
	let hostPub;
	let hostMac;
	try {
		hostPub = unb64u(needString(hk, 'hk'));
		hostMac = unb64u(needString(hm, 'hm'));
	} catch {
		throw new Error('malformed handshake');
	}
	needPub(hostPub, 'host public key');
	if (hostMac.length !== 32) { throw new Error('malformed handshake'); }
	const expected = await hmac(ps, [`${PREFIX} host`, ZERO, deviceId, ZERO, hostPub, ZERO, phonePub]);
	if (!constantTimeEqual(expected, hostMac)) { throw new Error('handshake MAC mismatch'); }
	const peer = await subtle().importKey('raw', hostPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
	const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
	shared.fill(0);
	const okm = new Uint8Array(await subtle().deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: ps, info: concat([`${PREFIX} keys`, ZERO, deviceId]) },
		ikm,
		512,
	));
	try {
		const c2h = await subtle().importKey('raw', okm.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt']);
		const h2c = await subtle().importKey('raw', okm.slice(32, 64), { name: 'AES-GCM' }, false, ['decrypt']);
		return { c2h, h2c };
	} finally {
		okm.fill(0);
	}
}

/**
 * The associated data that binds a frame to its device, direction, stream and counter.
 * @param {string} dir
 * @param {string} deviceId
 * @param {number} s
 * @param {number} n
 * @returns {Uint8Array}
 */
function aad(dir, deviceId, s, n) {
	return enc.encode(`${PREFIX} ${dir} ${deviceId} ${s} ${n}`);
}

/**
 * Seals one message into a `t: 'm'` payload: `{ e: 1, d, s, n, c: b64u(iv || ciphertext || tag) }`.
 * @param {CryptoKey} key AES-GCM key (the c2h key when the phone sends)
 * @param {{ deviceId: string, dir: 'c2h' | 'h2c', s: number, n: number }} meta
 * @param {unknown} message JSON-serializable message object
 * @returns {Promise<{ e: 1, d: string, s: number, n: number, c: string }>}
 */
export async function seal(key, meta, message) {
	if (!meta || typeof meta !== 'object') { throw new Error('frame metadata is required'); }
	const { deviceId, dir, s, n } = meta;
	needString(deviceId, 'device id');
	if (!deviceId) { throw new Error('device id is empty'); }
	if (!DIRECTIONS.includes(dir)) { throw new Error('direction must be c2h or h2c'); }
	needCounter(s, 's');
	needCounter(n, 'n');
	const text = JSON.stringify(message);
	if (typeof text !== 'string') { throw new Error('message is not serializable'); }
	const iv = new Uint8Array(IV_LENGTH);
	globalThis.crypto.getRandomValues(iv);
	const sealed = new Uint8Array(await subtle().encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(dir, deviceId, s, n), tagLength: TAG_LENGTH * 8 },
		key,
		enc.encode(text),
	));
	return { e: 1, d: deviceId, s, n, c: b64u(concat([iv, sealed])) };
}

/**
 * Opens one `t: 'm'` payload. Fails closed: a malformed payload, a frame for another device, a
 * bad tag or the wrong direction all throw.
 * @param {CryptoKey} key AES-GCM key (the h2c key when the phone receives)
 * @param {{ deviceId: string, dir: 'c2h' | 'h2c' }} meta
 * @param {unknown} payload the envelope payload `p`
 * @returns {Promise<{ s: number, n: number, message: any }>}
 */
export async function open(key, meta, payload) {
	if (!meta || typeof meta !== 'object') { throw new Error('frame metadata is required'); }
	const { deviceId, dir } = meta;
	needString(deviceId, 'device id');
	if (!deviceId) { throw new Error('device id is empty'); }
	if (!DIRECTIONS.includes(dir)) { throw new Error('direction must be c2h or h2c'); }
	if (!payload || typeof payload !== 'object') { throw new Error('malformed frame'); }
	const p = /** @type {any} */ (payload);
	if (p.e !== 1 || p.d !== deviceId) { throw new Error('frame is not for this device'); }
	needCounter(p.s, 's');
	needCounter(p.n, 'n');
	if (typeof p.c !== 'string') { throw new Error('malformed frame'); }
	let raw;
	try { raw = unb64u(p.c); } catch { throw new Error('malformed frame'); }
	if (raw.length < IV_LENGTH + TAG_LENGTH) { throw new Error('malformed frame'); }
	let plain;
	try {
		plain = await subtle().decrypt(
			{ name: 'AES-GCM', iv: raw.slice(0, IV_LENGTH), additionalData: aad(dir, deviceId, p.s, p.n), tagLength: TAG_LENGTH * 8 },
			key,
			raw.slice(IV_LENGTH),
		);
	} catch {
		throw new Error('authentication failed');
	}
	let message;
	try { message = JSON.parse(dec.decode(plain)); } catch { throw new Error('malformed message'); }
	return { s: p.s, n: p.n, message };
}

/**
 * Remembers the last `(s, n)` accepted from the desktop and decides whether a frame is fresh:
 * accepted iff `s` is larger than the stored stream, or equal with a larger `n`.
 */
export class ReplayGuard {
	/**
	 * @param {{ s: number, n: number }} [initial] state restored from storage; anything invalid starts fresh
	 */
	constructor(initial) {
		this.s = -1;
		this.n = -1;
		if (initial && Number.isSafeInteger(initial.s) && Number.isSafeInteger(initial.n) && initial.s >= 0 && initial.n >= 0) {
			this.s = initial.s;
			this.n = initial.n;
		}
	}

	/**
	 * Checks a frame's counters and, only if it is fresh, records them.
	 * @param {number} s stream id
	 * @param {number} n counter within the stream
	 * @returns {boolean} whether the frame is acceptable
	 */
	accept(s, n) {
		if (!Number.isSafeInteger(s) || !Number.isSafeInteger(n) || s < 0 || n < 0) { return false; }
		if (s > this.s || (s === this.s && n > this.n)) {
			this.s = s;
			this.n = n;
			return true;
		}
		return false;
	}

	/**
	 * @returns {{ s: number, n: number }} the last accepted counters (`-1` before any frame)
	 */
	state() {
		return { s: this.s, n: this.n };
	}
}

/**
 * A new stream id: a millisecond timestamp that never goes backwards, `max(now, lastUsed + 1)`.
 * @param {number} lastUsed the last stream id this sender used (0 if none)
 * @param {number} [now] defaults to `Date.now()`
 * @returns {number}
 */
export function nextStreamId(lastUsed, now = Date.now()) {
	const last = Number.isSafeInteger(lastUsed) && lastUsed >= 0 ? lastUsed : 0;
	return Math.max(now, last + 1);
}
