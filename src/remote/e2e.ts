/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { webcrypto } from 'crypto';

/**
 * End-to-end encryption between the desktop and a paired phone. The wire format is specified in
 * `docs/REMOTE-E2E.md`; `openvs-relay/pwa/e2e.js` is the phone's half and
 * `scripts/test-remote-e2e-crypto.mjs` checks the two agree byte for byte. This file holds the
 * primitives (pure functions over bytes) and {@link HostE2E}, the desktop's per-device state.
 *
 * Everything here uses the platform's Web Crypto (`crypto.webcrypto`), so there is no dependency
 * to install and the phone's browser runs the same algorithms.
 */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Domain-separation strings. Part of the wire format: changing one breaks pairing with every phone. */
const LABEL_CODE = 'stormcoder-e2e-v1 code';
const LABEL_CLAIM = 'stormcoder-e2e-v1 claim';
const LABEL_HOST = 'stormcoder-e2e-v1 host';
const LABEL_KEYS = 'stormcoder-e2e-v1 keys';
const LABEL_AAD = 'stormcoder-e2e-v1';

const PS_BYTES = 16;
const PUB_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** The pairing secret, as shown and as carried in the link: Crockford base32 of 16 bytes. */
export const PAIRING_SECRET_CHARS = 26;

// ---- Encodings ---------------------------------------------------------------------------------

/** base64url without padding. */
export function b64u(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

/** Inverse of {@link b64u}. Throws on anything that is not unpadded base64url. */
export function unb64u(text: string): Uint8Array {
	if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
		throw new Error('Not base64url.');
	}
	return new Uint8Array(Buffer.from(text, 'base64url'));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 without padding. */
export function b32encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	if (bits > 0) {
		out += CROCKFORD[(value << (5 - bits)) & 31];
	}
	return out;
}

/** Inverse of {@link b32encode}; lenient about case, spaces and hyphens, and maps I/L to 1 and O to 0. Throws on anything else. */
export function b32decode(text: string): Uint8Array {
	const clean = String(text).replace(/[\s-]+/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		const v = CROCKFORD.indexOf(ch);
		if (v < 0) {
			throw new Error('Not a pairing key: it contains a character that cannot be part of one.');
		}
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
		value &= (1 << bits) - 1;
	}
	return new Uint8Array(out);
}

/** Concatenates byte strings and UTF-8 text, with single zero bytes between parts when `sep` is set. */
function join(parts: Array<Uint8Array | string>, sep = true): Uint8Array {
	const chunks = parts.map(p => (typeof p === 'string' ? enc.encode(p) : p));
	const total = chunks.reduce((n, c) => n + c.length, 0) + (sep ? Math.max(0, chunks.length - 1) : 0);
	const out = new Uint8Array(total);
	let at = 0;
	chunks.forEach((c, i) => {
		out.set(c, at);
		at += c.length;
		if (sep && i < chunks.length - 1) {
			out[at++] = 0;
		}
	});
	return out;
}

/** Constant-time equality of two byte strings. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await subtle.sign('HMAC', k, data));
}

function checkSecret(ps: Uint8Array): void {
	if (!(ps instanceof Uint8Array) || ps.length !== PS_BYTES) {
		throw new Error('The pairing secret must be 16 bytes.');
	}
}

function checkPublic(pub: Uint8Array): void {
	if (!(pub instanceof Uint8Array) || pub.length !== PUB_BYTES || pub[0] !== 4) {
		throw new Error('Not an uncompressed P-256 public key.');
	}
}

// ---- Pairing -----------------------------------------------------------------------------------

/** The relay pairing code derived from the pairing secret: 8 Crockford characters. */
export async function deriveCode(ps: Uint8Array): Promise<string> {
	checkSecret(ps);
	return b32encode(await hmac(ps, enc.encode(LABEL_CODE))).slice(0, 8);
}

/** The proof a phone sends with its public key: `HMAC(ps, claim || 0 || phonePub || 0 || name)`. */
export async function claimMac(ps: Uint8Array, phonePub: Uint8Array, name: string): Promise<Uint8Array> {
	checkSecret(ps);
	checkPublic(phonePub);
	return hmac(ps, join([LABEL_CLAIM, phonePub, name]));
}

/** Whether `mac` proves the sender of `pub`/`name` knew `ps`. Never throws: malformed input is simply not valid. */
export async function verifyClaim(ps: Uint8Array, name: string, pub: string, mac: string): Promise<boolean> {
	try {
		return equal(await claimMac(ps, unb64u(pub), name), unb64u(mac));
	} catch {
		return false;
	}
}

/** What the desktop produces when it accepts a claim. */
export interface AcceptedClaim {
	readonly hostPub: Uint8Array;
	readonly hostMac: Uint8Array;
	/** Phone to desktop. */
	readonly c2h: Uint8Array;
	/** Desktop to phone. */
	readonly h2c: Uint8Array;
}

/**
 * Derives the two keys for a device and the proof that goes back to it. The desktop's key pair
 * exists only inside this call: nothing about it is kept, so these keys cannot be recomputed
 * from anything stored.
 */
export async function acceptClaim(ps: Uint8Array, deviceId: string, phonePub: Uint8Array): Promise<AcceptedClaim> {
	checkSecret(ps);
	checkPublic(phonePub);
	const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const hostPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	const phoneKey = await subtle.importKey('raw', phonePub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: phoneKey }, pair.privateKey, 256));
	const okm = await hkdf(shared, ps, join([LABEL_KEYS, deviceId]), 64);
	const hostMac = await hmac(ps, join([LABEL_HOST, deviceId, hostPub, phonePub]));
	return { hostPub, hostMac, c2h: okm.slice(0, KEY_BYTES), h2c: okm.slice(KEY_BYTES) };
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, length * 8));
}

// ---- Sealed frames -----------------------------------------------------------------------------

/** Which way a frame travels: it selects the key and is part of what is authenticated. */
export type Direction = 'c2h' | 'h2c';

/** The wire form of a sealed message — the payload of a `t: 'm'` envelope. */
export interface SealedFrame {
	readonly e: 1;
	readonly d: string;
	readonly s: number;
	readonly n: number;
	readonly c: string;
}

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<webcrypto.CryptoKey> {
	return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

function aad(dir: Direction, deviceId: string, s: number, n: number): Uint8Array {
	return enc.encode(`${LABEL_AAD} ${dir} ${deviceId} ${s} ${n}`);
}

function isCounter(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Seals a message object for `deviceId` with the 32-byte key for `dir`. */
export async function seal(key: Uint8Array, meta: { deviceId: string; dir: Direction; s: number; n: number }, message: unknown): Promise<SealedFrame> {
	if (key.length !== KEY_BYTES || !isCounter(meta.s) || !isCounter(meta.n)) {
		throw new Error('Cannot seal: bad key or counters.');
	}
	const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
	const body = new Uint8Array(await subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(meta.dir, meta.deviceId, meta.s, meta.n), tagLength: TAG_BYTES * 8 },
		await aesKey(key, 'encrypt'),
		enc.encode(JSON.stringify(message))));
	return { e: 1, d: meta.deviceId, s: meta.s, n: meta.n, c: b64u(join([iv, body], false)) };
}

/** Opens a sealed frame. Throws unless it is well formed, for this device and direction, and authentic. */
export async function open(key: Uint8Array, expect: { deviceId: string; dir: Direction }, frame: unknown): Promise<{ s: number; n: number; message: unknown }> {
	const f = frame as Partial<SealedFrame> | null;
	if (!f || typeof f !== 'object' || f.e !== 1 || f.d !== expect.deviceId || !isCounter(f.s) || !isCounter(f.n) || typeof f.c !== 'string') {
		throw new Error('Not a sealed frame for this device.');
	}
	const raw = unb64u(f.c);
	if (key.length !== KEY_BYTES || raw.length < IV_BYTES + TAG_BYTES) {
		throw new Error('Sealed frame is too short.');
	}
	const plain = await subtle.decrypt(
		{ name: 'AES-GCM', iv: raw.slice(0, IV_BYTES), additionalData: aad(expect.dir, expect.deviceId, f.s, f.n), tagLength: TAG_BYTES * 8 },
		await aesKey(key, 'decrypt'),
		raw.slice(IV_BYTES));
	return { s: f.s, n: f.n, message: JSON.parse(dec.decode(plain)) };
}

/**
 * Accepts a frame only if it is newer than the last one taken: a larger stream id, or the same
 * stream and a larger counter. Replays, reordering and old streams are refused.
 */
export class ReplayGuard {
	private s: number;
	private n: number;

	constructor(initial?: { s: number; n: number }) {
		this.s = initial?.s ?? -1;
		this.n = initial?.n ?? -1;
	}

	accept(s: number, n: number): boolean {
		if (!isCounter(s) || !isCounter(n)) {
			return false;
		}
		if (s > this.s || (s === this.s && n > this.n)) {
			this.s = s;
			this.n = n;
			return true;
		}
		return false;
	}

	state(): { s: number; n: number } {
		return { s: this.s, n: this.n };
	}
}

/** A new stream id: the clock, but always larger than the last one used (so it survives a clock that stepped back). */
export function nextStreamId(lastUsed: number, now: number = Date.now()): number {
	return Math.max(now, lastUsed + 1);
}

// ---- The desktop's per-device state ------------------------------------------------------------

/** Where {@link HostE2E} keeps secrets (the OS keychain in the app): the two keys of each device. */
export interface KeyStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

/** Where it keeps small non-secret state: which devices exist and their stream counters. */
export interface StateStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

/** The minimal promise-like the VS Code-shaped stores return. */
interface Thenable<T> { then<R>(onfulfilled: (value: T) => R | PromiseLike<R>): PromiseLike<R> }

const DEVICES_KEY = 'stormcoder.remote.e2e.devices';
const KEY_PREFIX = 'stormcoder.remote.e2e.key.';
/** How long a shown pairing secret stays usable on the desktop. */
export const PAIRING_TTL_MS = 120_000;

/** What is remembered about one paired device (no keys: those are in the {@link KeyStore}). */
interface DeviceState {
	name: string;
	createdAt: number;
	/** True once a valid sealed frame has come from the device, i.e. the phone has the keys. */
	confirmed: boolean;
	/** The handshake to (re)send until `confirmed`. */
	hk?: string;
	hm?: string;
	/** The highest stream id this side has used toward the device / has accepted from it. */
	lastOutS: number;
	lastInS: number;
}

interface LiveDevice {
	c2h: Uint8Array;
	h2c: Uint8Array;
	guard: ReplayGuard;
	out?: { s: number; n: number };
}

/** A pairing the desktop is showing right now. */
export interface PendingPairing {
	readonly ps: Uint8Array;
	/** `B32(ps)`: what the link and QR code carry. */
	readonly secret: string;
	readonly code: string;
	readonly expiresAt: number;
}

/**
 * The desktop's end of the encryption: pairing secrets in flight, the keys of paired devices, and
 * the stream counters that stop replays. Holds no plaintext anywhere on disk.
 */
export class HostE2E {
	private readonly pending: PendingPairing[] = [];
	private readonly live = new Map<string, LiveDevice>();
	private loaded = false;
	private devices: Record<string, DeviceState> = {};

	constructor(private readonly keys: KeyStore, private readonly state: StateStore, private readonly now: () => number = Date.now) { }

	private load(): void {
		if (!this.loaded) {
			this.devices = { ...(this.state.get<Record<string, DeviceState>>(DEVICES_KEY) ?? {}) };
			this.loaded = true;
		}
	}

	private async save(): Promise<void> {
		await this.state.update(DEVICES_KEY, this.devices);
	}

	/** Starts a pairing: a fresh secret, its relay code and expiry. At most a few are kept. */
	beginPairing(): PendingPairing {
		const ps = webcrypto.getRandomValues(new Uint8Array(PS_BYTES));
		const t = this.now();
		const fresh = this.pending.filter(p => p.expiresAt > t);
		this.pending.length = 0;
		this.pending.push(...fresh.slice(-3));
		const pairing: PendingPairing = { ps, secret: b32encode(ps), code: '', expiresAt: t + PAIRING_TTL_MS };
		this.pending.push(pairing);
		return pairing;
	}

	/** Fills in the relay code for a pairing started with {@link beginPairing} (it needs an await to derive). */
	async completePairing(pairing: PendingPairing): Promise<PendingPairing> {
		const done: PendingPairing = { ...pairing, code: await deriveCode(pairing.ps) };
		const at = this.pending.indexOf(pairing);
		if (at >= 0) {
			this.pending[at] = done;
		}
		return done;
	}

	/**
	 * Handles a claim the relay forwarded. Returns true when the proof matched one of the pairings
	 * on screen (the device then has keys and a handshake to send), false when it matched none:
	 * the caller must revoke the device.
	 */
	async acceptDevice(deviceId: string, name: string, pub: string, mac: string): Promise<boolean> {
		this.load();
		const t = this.now();
		for (const p of this.pending.filter(x => x.expiresAt > t)) {
			if (!await verifyClaim(p.ps, name, pub, mac)) {
				continue;
			}
			let phonePub: Uint8Array;
			try {
				phonePub = unb64u(pub);
			} catch {
				return false;
			}
			const accepted = await acceptClaim(p.ps, deviceId, phonePub);
			await this.keys.store(KEY_PREFIX + deviceId, b64u(join([accepted.c2h, accepted.h2c], false)));
			this.devices[deviceId] = {
				name, createdAt: t, confirmed: false, hk: b64u(accepted.hostPub), hm: b64u(accepted.hostMac), lastOutS: 0, lastInS: 0,
			};
			await this.save();
			this.live.delete(deviceId);
			this.pending.splice(this.pending.indexOf(p), 1);
			return true;
		}
		return false;
	}

	/** Whether the desktop holds keys for `deviceId`. */
	has(deviceId: string): boolean {
		this.load();
		return deviceId in this.devices;
	}

	/** The devices the desktop can talk to (confirmed ones only: an unconfirmed phone has not got its keys yet). */
	confirmedDevices(): string[] {
		this.load();
		return Object.entries(this.devices).filter(([, d]) => d.confirmed).map(([id]) => id);
	}

	/** The handshake payload to send a device that has not yet proven it has its keys; undefined once it has. */
	handshakeFor(deviceId: string): { e: 0; d: string; hk: string; hm: string } | undefined {
		this.load();
		const d = this.devices[deviceId];
		return d && !d.confirmed && d.hk && d.hm ? { e: 0, d: deviceId, hk: d.hk, hm: d.hm } : undefined;
	}

	private async device(deviceId: string): Promise<LiveDevice | undefined> {
		this.load();
		const known = this.devices[deviceId];
		if (!known) {
			return undefined;
		}
		let entry = this.live.get(deviceId);
		if (!entry) {
			const stored = await this.keys.get(KEY_PREFIX + deviceId);
			if (!stored) {
				return undefined;
			}
			const raw = unb64u(stored);
			if (raw.length !== KEY_BYTES * 2) {
				return undefined;
			}
			// After a restart only a stream newer than the last one seen is accepted, so frames a
			// relay recorded earlier cannot be replayed into this process.
			entry = { c2h: raw.slice(0, KEY_BYTES), h2c: raw.slice(KEY_BYTES), guard: new ReplayGuard({ s: known.lastInS, n: Number.MAX_SAFE_INTEGER }) };
			this.live.set(deviceId, entry);
		}
		return entry;
	}

	/** Starts a new outgoing stream to a device (it connected, or the desktop restarted). */
	async newStream(deviceId: string): Promise<void> {
		const entry = await this.device(deviceId);
		if (!entry) {
			return;
		}
		const known = this.devices[deviceId];
		const s = nextStreamId(known.lastOutS, this.now());
		known.lastOutS = s;
		entry.out = { s, n: 0 };
		await this.save();
	}

	/** Seals `message` once for each confirmed device, in order. Nothing is ever sent unsealed. */
	async sealForAll(message: unknown): Promise<SealedFrame[]> {
		const frames: SealedFrame[] = [];
		for (const deviceId of this.confirmedDevices()) {
			const entry = await this.device(deviceId);
			if (!entry) {
				continue;
			}
			if (!entry.out) {
				await this.newStream(deviceId);
			}
			const out = entry.out!;
			frames.push(await seal(entry.h2c, { deviceId, dir: 'h2c', s: out.s, n: out.n++ }, message));
		}
		return frames;
	}

	/**
	 * Opens a frame from a phone. Returns the device and message, or undefined for anything that
	 * is not a valid, fresh frame from a device the desktop holds keys for.
	 */
	async openFrom(payload: unknown): Promise<{ deviceId: string; message: unknown } | undefined> {
		const deviceId = (payload as { d?: unknown } | null)?.d;
		if (typeof deviceId !== 'string') {
			return undefined;
		}
		const entry = await this.device(deviceId);
		if (!entry) {
			return undefined;
		}
		let opened: { s: number; n: number; message: unknown };
		try {
			opened = await open(entry.c2h, { deviceId, dir: 'c2h' }, payload);
		} catch {
			return undefined;
		}
		if (!entry.guard.accept(opened.s, opened.n)) {
			return undefined;
		}
		const known = this.devices[deviceId];
		if (opened.s > known.lastInS || !known.confirmed) {
			known.lastInS = Math.max(known.lastInS, opened.s);
			known.confirmed = true;
			await this.save();
		}
		return { deviceId, message: opened.message };
	}

	/** Forgets a device and its keys (revoked, or never proved itself). */
	async remove(deviceId: string): Promise<void> {
		this.load();
		delete this.devices[deviceId];
		this.live.delete(deviceId);
		await this.keys.delete(KEY_PREFIX + deviceId);
		await this.save();
	}

	/** Forgets every device (the relay changed, so none of the old pairings can work). */
	async removeAll(): Promise<void> {
		this.load();
		for (const id of Object.keys(this.devices)) {
			await this.remove(id);
		}
	}
}

/** Groups a pairing secret for typing: `ABCD-EFGH-…`. */
export function groupSecret(secret: string): string {
	return secret.replace(/(.{4})(?=.)/g, '$1-');
}
