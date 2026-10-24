// Stormcoder Relay — Cloudflare Worker + Durable Object + PWA
//
// The PWA's core client: pairing-code claim, the envelope protocol (mirrored from
// ../src/protocol.ts — this file ships as a plain browser module with no bundler, so it cannot
// `import` the TypeScript source; the shape is duplicated here by hand and kept honest by
// scripts/test-pwa-contract.mjs), and the `t: 'm'` app-message switch, which is a deliberately
// plain-text port of extensions/openvs-chat/media/main.js's own switch — same message types,
// none of its markdown rendering or rich tool-call formatting. Outbound app messages are
// constructed only from `REMOTE_ALLOWED` types (extensions/openvs-chat/src/remote/policy.ts);
// this file also duplicates that list by hand, and the contract test checks the two stay equal.
'use strict';

import { render as renderTranscript, renderPending, appendEntry, updateToolRow, appendNotice, renderTodos } from './transcript.js';
import { create as createCards } from './cards.js';
import { b32decode, deriveCode, makeClaim, completeHandshake, seal, open as openFrame, ReplayGuard, nextStreamId } from './e2e.js';

// ---- Envelope protocol (mirrors ../src/protocol.ts) ------------------------------------------

/**
 * @typedef {{ v: 1, t: 'm' | 'c' | 'a', seq: number, ack?: number, p?: any }} Envelope
 */

const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * How long a `ping` is allowed to go unanswered before it counts as missed. Mirrors
 * `extensions/openvs-chat/src/remote/socket.ts`'s `RemoteSocket` (the *host*'s own client to
 * this same relay) exactly — including its "2 missed pongs" threshold below — which already
 * has this staleness check; this file, the mobile-facing side of the same protocol and the one
 * actually prone to a backgrounded tab zombying its socket, never did.
 */
const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Mirrors `../src/room.ts`'s `HEARTBEAT_PING_JSON` byte for byte — see `sendPing`. */
const HEARTBEAT_PING_JSON = JSON.stringify({ v: 1, t: 'c', seq: 0, p: { c: 'ping' } });
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Consecutive failed reconnect attempts (never reaching `open`) before the status line stops
 * just saying "Reconnecting…" and starts hinting this might be a revocation, not an outage — see
 * `connect()`'s `close` handler doc for why a revoked-while-disconnected device can't be told
 * apart from an ordinary network drop from the close event alone. Below this threshold, a normal
 * blip (elevator, tunnel, backgrounded app) shouldn't get an alarming message; above it, a device
 * that keeps failing to even complete the WebSocket upgrade — which is exactly what `/ws/client`
 * rejecting a revoked token looks like from here — has been retrying for roughly 10-15 seconds
 * (the sum of the first three backoff delays: ~1s + ~2s + ~4s, before jitter), which is enough
 * repeated failure that the user deserves more than a spinner that will never resolve on its own.
 */
const REVOKE_HINT_AFTER_FAILURES = 4;
/** Mirrors `../src/room.ts`'s `DEVICE_REVOKED_CLOSE_CODE` — the close code the relay uses on a live socket when the host revokes this device, so the `close` handler below can tell "revoked, stop retrying" apart from an ordinary drop that's worth reconnecting from. */
const DEVICE_REVOKED_CLOSE_CODE = 4001;

// ---- Image attachments (Phase 6c) -------------------------------------------------------------
//
// `resizeImageForUpload`/`uploadImage` below are a hand-copied, PWA-side take on
// extensions/openvs-chat/media/main.js's own `resizeImage`/`pendingImages` pipeline — same
// approach (FileReader + <canvas>, downscale to a long-edge cap, re-encode as JPEG), kept as an
// independent copy per this file's established cross-package duplication pattern (see the
// top-of-file doc) rather than a shared import, since a plain browser module here cannot import
// from the extension's TypeScript sources anyway. Unlike the desktop webview, this PWA cannot
// paste/drop into a native file input, so the image goes to the host over `attachImage`'s
// chunked-upload channel instead of a local `pendingImages` array — see
// extensions/openvs-chat/src/remote/attachments.ts for the host-side reassembly and the real
// size ceilings (8MB/upload, 32MB/session) that actually bound this, not anything below.
const MAX_IMAGE_DIM = 1568; // Matches media/main.js's own cap — a sane default everywhere.
/** Base64 *text* characters per `attachImage` chunk (not raw bytes) — slices of one already-encoded string, per the plan's "64KB base64 chunks". */
const ATTACH_CHUNK_CHARS = 64 * 1024;

// ---- DOM shell -----------------------------------------------------------------------------

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

/** Stroke paths (24×24 grid, 1.75 stroke) for the icons drawn from script — index.html inlines the same set for its static buttons. */
const ICON_PATHS = {
	x: 'M6 6l12 12M18 6L6 18',
	file: 'M14 3H6v18h12V7l-4-4zM14 3v4h4M10 12l-2 2 2 2M14 12l2 2-2 2',
	image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 8.5h.01',
	clock: 'M12 8v4l2.5 1.5M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
};

/**
 * An inline SVG icon from {@link ICON_PATHS}, decorative (`aria-hidden`) — the control that
 * holds it carries the accessible name.
 * @param {keyof typeof ICON_PATHS} name
 */
function icon(name) {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', 'icon');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(NS, 'path');
	path.setAttribute('d', ICON_PATHS[name]);
	svg.appendChild(path);
	return svg;
}

const els = {
	status: document.getElementById('status'),
	tabs: document.getElementById('tabs'),
	messages: document.getElementById('messages'),
	todos: document.getElementById('todos'),
	composer: /** @type {HTMLTextAreaElement} */ (document.getElementById('composer')),
	sendBtn: document.getElementById('sendBtn'),
	stopBtn: document.getElementById('stopBtn'),
	newSessionBtn: document.getElementById('newSessionBtn'),
	historyBtn: document.getElementById('historyBtn'),
	historyCloseBtn: document.getElementById('historyCloseBtn'),
	historyPanel: document.getElementById('historyPanel'),
	historyList: document.getElementById('historyList'),
	slashMenu: document.getElementById('slashMenu'),
	enhanceBtn: document.getElementById('enhanceBtn'),
	modeSelect: /** @type {HTMLSelectElement} */ (document.getElementById('modeSelect')),
	providerSelect: /** @type {HTMLSelectElement} */ (document.getElementById('providerSelect')),
	modelSelect: /** @type {HTMLSelectElement} */ (document.getElementById('modelSelect')),
	skillsList: document.getElementById('skillsList'),
	skillsPanel: /** @type {HTMLDetailsElement} */ (document.getElementById('skillsPanel')),
	skillsSummary: document.getElementById('skillsSummary'),
	contextChip: document.getElementById('contextChip'),
	queueChips: document.getElementById('queueChips'),
	attachImageInput: /** @type {HTMLInputElement} */ (document.getElementById('attachImageInput')),
	attachImageBtn: document.getElementById('attachImageBtn'),
	attachActiveBtn: document.getElementById('attachActiveBtn'),
	pairForm: document.getElementById('pairForm'),
	scanBtn: document.getElementById('scanBtn'),
	modeSeg: document.getElementById('modeSeg'),
	pairScreenRoot: document.getElementById('pairScreen'),
	pairCode: /** @type {HTMLInputElement} */ (document.getElementById('pairCode')),
	pairError: document.getElementById('pairError'),
	app: document.getElementById('app'),
	pairScreen: document.getElementById('pairScreen'),
	unpairBtn: document.getElementById('unpairBtn'),
};

const cards = createCards({ container: els.messages, post: sendApp });

// ---- Connection state ------------------------------------------------------------------------

let ws = null;
let outSeq = 0;
/** @type {number | undefined} */
let heartbeatTimer;
/** @type {number | undefined} */
let pongTimeoutTimer;
let awaitingPong = false;
let missedPongs = 0;
let reconnectDelayMs = RECONNECT_MIN_MS;
/** Consecutive `close` events without an intervening `open` — see `REVOKE_HINT_AFTER_FAILURES`'s own doc. Reset to 0 the moment a connection actually opens. */
let consecutiveReconnectFailures = 0;
let roomId = '';
let deviceToken = '';

/** @type {any[]} */
let sessions = [];
let activeSessionId = '';
let providers = [];
let selectedProvider = '';
/** @type {Record<string, any[]>} */
let fetchedModels = {};
/** Why a provider's last catalog fetch failed (the host's `models` message carries it), by provider id. @type {Record<string, string>} */
let modelErrors = {};
/**
 * Images uploaded via `attachImage` and acknowledged, by session — the host holds them per
 * session and merges them into that session's next send (`takePendingImages`).
 * @type {Map<string, number>}
 */
const pendingImages = new Map();
/** Which session each in-flight upload belongs to, until its `attachOk` arrives. @type {Map<string, string>} */
const uploadSessions = new Map();

/** @param {string} sessionId */
function pendingImageCount(sessionId) {
	return pendingImages.get(sessionId) || 0;
}
/**
 * Whether VS Code itself is connected to the relay, as the relay last reported (`welcome`'s
 * `hostOnline`, then `hostStatus`) — `null` for a relay too old to say. Without it a phone
 * connected to the relay while VS Code was closed showed "Connected" over an empty app that
 * could never answer.
 * @type {boolean | null}
 */
let hostOnline = null;
/**
 * The `{ provider, model }` this device most recently asked the host to switch to, held until
 * a `config` message confirms it (or the provider changes again) — see `renderModelSelect`'s
 * doc for why this exists: over the relay's real network round trip a `models` catalog refresh
 * (`listModels`, kicked off by this same provider switch, or an unrelated `postConfig` on the
 * host) can land *after* the user's pick but *before* the `config` that confirms it, and would
 * otherwise reset the dropdown back to the pre-pick model out from under them.
 * @type {{provider: string, model: string} | null}
 */
let pendingModel = null;
/**
 * Per-session queue edits this device has made locally but the host hasn't yet confirmed via a
 * `sessions` snapshot that actually reflects them — same problem `pendingModel` solves for the
 * model picker, applied to `session.queue`: `case 'sessions':` preserves a session's `.messages`
 * across a rebuild but has no such protection for `.queue`, so an edit still in flight (or lost
 * to a disconnect before it reached the host) was silently overwritten by whatever queue the
 * host's snapshot carried — reconnecting could make a just-queued or just-removed follow-up
 * reappear/vanish out from under the user. Also replayed on reconnect (`case 'welcome':`) for
 * an edit that never reached the host at all before the socket dropped.
 * @type {Map<string, string[]>}
 */
let pendingQueues = new Map();
let skillsCatalog = [];
/**
 * The slash-command catalog pushed by the host's `commands` message (`session/slash.ts`'s
 * `SLASH_COMMANDS`) — mirrors media/main.js's own `slashCommands`. Used only to drive
 * {@link updateSlashMenu}'s autocomplete; the actual dispatch of a typed command goes through
 * `handleSlash` → the host's `slash` message regardless of whether this catalog has loaded yet.
 * @type {{cmd: string, desc: string}[]}
 */
let slashCommands = [];
/** Archived conversations, from the host's `history` message — used by the History panel below. @type {{id: string, title?: string, savedAt?: number}[]} */
let historyEntries = [];
/**
 * The current `attachContext`/`attachActive` reply, awaiting the next `send` — mirrors
 * media/main.js's own `currentContext`. Set from a `context` message, cleared once actually
 * sent (or removed via the chip's own ✕).
 * @type {{label: string, content: string} | null}
 */
let attachedContext = null;

// ---- Storage (bearer-token-only for this phase; the non-extractable ECDSA key binding from
// the plan's Auth step 5 is Phase 7 work, tracked in src/room.ts's upgradeClient comment) -------

/**
 * The native shell (android/), when this page runs inside one. It sets `globalThis.StormcoderNative`
 * before this file loads: `{ platform, scanQr?() }`. In a browser it is undefined and nothing below
 * changes. A shell serves this app from its own bundle, so the relay is not the page's origin and
 * its address is learned from the pairing link and remembered with the device.
 */
const native = globalThis.StormcoderNative;
/** The relay's origin when the app is bundled in a native shell (`https://host`); unused in a browser. */
let nativeOrigin = '';

/** Where the relay is: the page's own origin in a browser, the paired relay's in a native shell. */
function relayBase() {
	return native ? nativeOrigin : location.origin;
}

function storageKey(room) {
	return `openvsRelay.device.${room}`;
}

function loadDevice(room) {
	try {
		const raw = localStorage.getItem(storageKey(room));
		return raw ? JSON.parse(raw) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Remembers which room this browser most recently paired to, so a launch that carries no room
 * of its own (see {@link loadLastRoom}'s doc) can still recover an existing pairing instead of
 * always landing back on the pairing screen.
 */
const LAST_ROOM_KEY = 'openvsRelay.lastRoom';

function saveDevice(room, device) {
	try {
		localStorage.setItem(storageKey(room), JSON.stringify(device));
		// Every successful pairing is "the most recent one" — recorded here, the one place a
		// device actually gets persisted, rather than at each call site that happens to know a
		// room id, so this can never drift out of sync with what {@link loadDevice} would find.
		localStorage.setItem(LAST_ROOM_KEY, room);
	} catch {
		// Storage can be unavailable (private browsing, quota) — pairing simply has to be
		// redone next visit; nothing here is safety-critical to persist.
	}
}

/**
 * The room this browser most recently paired to, or `''` if none/unavailable. `boot()`'s
 * {@link parseLocation} falls back to this when the launch URL carries no room of its own —
 * critically, the *installed* PWA's own icon: `manifest.webmanifest`'s `start_url` is the fixed
 * `"/"`, not the `/p/<roomId>#<code>` URL pairing actually happened at, so without this every
 * launch from the home-screen icon parsed an empty `roomId`, found nothing under `storageKey('')`
 * and showed the pairing screen again — every single time — even though the device was already
 * paired and its real token was sitting in storage under the room it actually paired to. A
 * bookmarked or shared plain `/pair` link with no room is the one case this is *not* wanted; those
 * still explicitly carry `?room=` and take precedence in `parseLocation` regardless.
 */
function loadLastRoom() {
	try {
		return localStorage.getItem(LAST_ROOM_KEY) || '';
	} catch {
		return '';
	}
}

// ---- End-to-end encryption state (docs/REMOTE-E2E.md) ------------------------------------------
//
// After pairing, every `t: 'm'` payload is sealed with a key the relay never sees (e2e.js). The
// keys are non-extractable CryptoKeys kept in IndexedDB (they structured-clone, localStorage
// cannot hold them). Until they exist the app is "securing the connection" and sends nothing.

const E2E_DB_NAME = 'openvs-relay-e2e';
const E2E_STORE_NAME = 'e2e';
/** How long a freshly paired phone waits for the desktop's handshake frame before giving up. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** Persist the receive replay state at least this often (in accepted frames); it is also saved whenever the stream changes and when the page is hidden. */
const RECV_PERSIST_EVERY = 25;
const SECURING_TEXT = 'Securing the connection…';

/** Keys for this room, once the handshake finished. @type {{ deviceId: string, c2h: CryptoKey, h2c: CryptoKey } | null} */
let e2eKeys = null;
/** The claimed-but-not-yet-completed pairing: the secret and the phone's private key. @type {{ deviceId: string, ps: Uint8Array, privateKey: CryptoKey, phonePub: Uint8Array } | null} */
let pendingHs = null;
/** Frames from the desktop are accepted only if newer than the last one seen. */
let recvGuard = new ReplayGuard();
let recvSincePersist = 0;
let lastRecvStream = -1;
/** The last stream id this phone used to send; persisted so stream ids only ever grow. */
let lastStreamId = 0;
/** The stream the phone is currently sending on. */
let sendStream = { s: 0, n: 0 };
/** Whether `welcome` has arrived on the current socket (the app bootstrap waits for keys and welcome). */
let welcomeSeen = false;
/** @type {number | undefined} */
let handshakeTimer;
/** Serializes sealing and opening so frame counters stay in order even though WebCrypto is async. @type {Promise<void>} */
let sendChain = Promise.resolve();
/** @type {Promise<void>} */
let recvChain = Promise.resolve();

/** @returns {Promise<IDBDatabase>} */
function openE2eDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(E2E_DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(E2E_STORE_NAME)) {
				req.result.createObjectStore(E2E_STORE_NAME);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Runs one request against the E2E store. Best-effort: resolves `undefined` if IndexedDB is
 * unavailable, so the app still works for the life of the page.
 * @param {'readonly' | 'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<any>}
 */
async function e2eStore(mode, run) {
	try {
		const db = await openE2eDb();
		try {
			return await new Promise((resolve, reject) => {
				const tx = db.transaction(E2E_STORE_NAME, mode);
				const req = run(tx.objectStore(E2E_STORE_NAME));
				tx.oncomplete = () => resolve(req.result);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * @param {string} kind `keys`, `pending`, `recv` or `stream`
 * @param {string} room
 */
function e2eKey(kind, room) {
	return `${kind}:${room}`;
}
const e2eGet = (/** @type {string} */ kind, /** @type {string} */ room) => e2eStore('readonly', s => s.get(e2eKey(kind, room)));
const e2ePut = (/** @type {string} */ kind, /** @type {string} */ room, /** @type {unknown} */ value) => e2eStore('readwrite', s => s.put(value, e2eKey(kind, room)));
const e2eDel = (/** @type {string} */ kind, /** @type {string} */ room) => e2eStore('readwrite', s => s.delete(e2eKey(kind, room)));

/** Deletes the keys, the pending pairing and the receive state for `room` (the stream counter is kept so ids stay monotonic). @param {string} room */
async function wipeE2e(room) {
	if (!room) { return; }
	await Promise.all([e2eDel('keys', room), e2eDel('pending', room), e2eDel('recv', room)]);
}

/** Saves the receive replay state so a reload does not reopen the door to old frames. */
function persistRecvState() {
	if (!roomId || !e2eKeys) { return; }
	const state = recvGuard.state();
	if (state.s < 0) { return; }
	recvSincePersist = 0;
	lastRecvStream = state.s;
	void e2ePut('recv', roomId, state);
}

/** Begins a new sending stream (`n` restarts at 0) and persists the id. */
function startSendStream() {
	lastStreamId = nextStreamId(lastStreamId);
	sendStream = { s: lastStreamId, n: 0 };
	if (roomId) { void e2ePut('stream', roomId, lastStreamId); }
}

/** Loads keys, pending pairing, replay state and the stream counter for `room` into memory. @param {string} room */
async function loadE2e(room) {
	e2eKeys = null;
	pendingHs = null;
	recvGuard = new ReplayGuard();
	lastStreamId = 0;
	if (!room) { return; }
	const [keys, pending, recv, stream] = await Promise.all([e2eGet('keys', room), e2eGet('pending', room), e2eGet('recv', room), e2eGet('stream', room)]);
	if (keys && typeof keys.deviceId === 'string' && keys.c2h && keys.h2c) {
		e2eKeys = { deviceId: keys.deviceId, c2h: keys.c2h, h2c: keys.h2c };
		recvGuard = new ReplayGuard(recv);
		lastRecvStream = recvGuard.state().s;
	} else if (pending && typeof pending.deviceId === 'string' && pending.ps instanceof Uint8Array && pending.privateKey && pending.phonePub instanceof Uint8Array) {
		pendingHs = { deviceId: pending.deviceId, ps: pending.ps, privateKey: pending.privateKey, phonePub: pending.phonePub };
	}
	if (typeof stream === 'number' && Number.isSafeInteger(stream) && stream > 0) { lastStreamId = stream; }
}

function clearHandshakeTimer() {
	if (handshakeTimer) { window.clearTimeout(handshakeTimer); handshakeTimer = undefined; }
}

/** Gives the desktop {@link HANDSHAKE_TIMEOUT_MS} to answer the claim, then abandons the pairing with a clear message. */
function armHandshakeTimer() {
	clearHandshakeTimer();
	handshakeTimer = window.setTimeout(() => {
		handshakeTimer = undefined;
		if (!e2eKeys && pendingHs) {
			void resetPairing('The desktop did not finish securing the connection. Pair again from the desktop.');
		}
	}, HANDSHAKE_TIMEOUT_MS);
}

/**
 * Forgets this pairing completely (device token, keys, pending handshake, service-worker record)
 * and returns to the pairing screen with `message`. Used for a revoke, a failed or timed-out
 * handshake, a pairing from before end-to-end encryption, and "Unpair this phone".
 * @param {string} message shown on the pairing screen
 */
async function resetPairing(message) {
	clearHandshakeTimer();
	stopHeartbeat();
	const dead = ws;
	ws = null;
	if (dead) { try { dead.close(); } catch { /* already closed */ } }
	const room = roomId;
	deviceToken = '';
	nativeOrigin = '';
	e2eKeys = null;
	if (pendingHs) { pendingHs.ps.fill(0); }
	pendingHs = null;
	recvGuard = new ReplayGuard();
	welcomeSeen = false;
	if (room) {
		try { localStorage.removeItem(storageKey(room)); } catch { /* best-effort */ }
	}
	// The copies a revoked token must not outlive: the "last room" pointer, and the record the
	// service worker reads to fetch pending notifications.
	try { localStorage.removeItem(LAST_ROOM_KEY); } catch { /* best-effort */ }
	void clearAuthRecord();
	showPairScreen(message);
	await wipeE2e(room);
}

/** @param {string} message */
function showPairScreen(message) {
	setStatus(message, 'status-warn');
	if (els.app) { els.app.hidden = true; }
	if (els.pairScreen) { els.pairScreen.hidden = false; }
	if (els.historyPanel) { els.historyPanel.hidden = true; }
	if (els.pairError) { els.pairError.textContent = message; }
}

// ---- Service worker auth handoff (Phase 6b: web push triggers) -------------------------------
//
// `sw.js`'s `readActiveAuth()` needs the active device token + room id to authenticate its own
// `/api/pending` fetch when it wakes on a payload-less push — a service worker cannot reach
// `localStorage`. Written to IndexedDB, which a service worker *can* read directly and which
// survives the worker being evicted and restarted between pushes (unlike an in-memory value
// cached only from a `message` event). Also `postMessage`d to an already-running worker as an
// immediate, best-effort update; `sw.js` persists that into the same IndexedDB store on receipt,
// so either path — a direct write from here, or a relayed one via the worker — lands in the one
// place `readActiveAuth()` reads from. `sw.js` hand-duplicates the constants and open/write
// helpers below (a classic, non-module service worker script can't `import` this file) — the
// same cross-boundary duplication this file already does for the wire protocol itself.
const AUTH_DB_NAME = 'openvs-relay-auth';
const AUTH_DB_VERSION = 1;
const AUTH_STORE_NAME = 'auth';
const AUTH_RECORD_KEY = 'active';

/** @returns {Promise<IDBDatabase>} */
function openAuthDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(AUTH_STORE_NAME)) {
				req.result.createObjectStore(AUTH_STORE_NAME);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** Removes the `{room, token}` record the service worker reads. Best-effort, like every write to it. */
async function clearAuthRecord() {
	try {
		const db = await openAuthDb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(AUTH_STORE_NAME, 'readwrite');
			tx.objectStore(AUTH_STORE_NAME).delete(AUTH_RECORD_KEY);
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// Not fatal: the token it holds is revoked, so it opens nothing.
	}
}

/**
 * Writes `{room, token}` to the shared auth store, then — for an already-running service worker
 * — also posts it directly so a live worker doesn't have to wait for a restart to see it.
 * Best-effort throughout: IndexedDB and `serviceWorker.ready` can each fail or be unavailable the
 * same way `localStorage` can (private browsing, an old browser, no worker registered yet), and
 * a push arriving before any of this succeeds still falls back to `sw.js`'s generic notification.
 * @param {string} room
 * @param {string} token
 */
async function syncAuthToServiceWorker(room, token) {
	try {
		const db = await openAuthDb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(AUTH_STORE_NAME, 'readwrite');
			tx.objectStore(AUTH_STORE_NAME).put({ room, token }, AUTH_RECORD_KEY);
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// See this function's doc — not fatal, sw.js's own read just misses this update.
	}
	if (native || !('serviceWorker' in navigator)) { return; }
	try {
		const registration = await navigator.serviceWorker.ready;
		if (registration.active) {
			registration.active.postMessage({ type: 'auth', room, token });
		}
	} catch {
		// No controller yet, or the worker isn't ready — the IndexedDB write above still stands.
	}
}

/** Registers `/sw.js`, if this browser supports service workers at all. Idempotent — a second registration for the same script/scope is a no-op per the spec. */
function registerServiceWorker() {
	// A native shell serves the app from its bundle: no worker to cache it, no Web Push to receive.
	if (!native && 'serviceWorker' in navigator) {
		navigator.serviceWorker.register('/sw.js').catch(() => { /* offline-support is best-effort */ });
	}
}

// ---- Pairing claim ------------------------------------------------------------------------

/**
 * A name that tells this phone apart from the others in the desktop's device list ("Pixel 8",
 * "iPhone", "Mac · Chrome") instead of every device being the same string.
 */
function deviceName() {
	const ua = navigator.userAgent || '';
	const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android[^;]*;\s*([^;)]+)/.exec(ua)?.[1]?.replace(/\s*Build.*$/, '').trim()
		|| (/Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Phone');
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
	return `${device}${browser ? ` · ${browser}` : ''} (Stormcoder PWA)`.slice(0, 80);
}

/**
 * Claims the pairing with the secret from the link: derives the relay code from it, sends the
 * phone's public key with a proof that the sender knew the secret (docs/REMOTE-E2E.md), and keeps
 * the private key and secret as the pending handshake until the desktop answers.
 * @param {string} room
 * @param {Uint8Array} ps the 16-byte pairing secret
 * @returns {Promise<string>} the device token
 */
async function claim(room, ps) {
	const name = deviceName();
	const code = await deriveCode(ps);
	const proof = await makeClaim(ps, name);
	const res = await fetch(`${relayBase()}/pair/claim?room=${encodeURIComponent(room)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code, name, pub: proof.pub, mac: proof.mac }),
	});
	if (!res.ok) {
		// `room.ts`'s handlePairClaim responds with a plain-text reason (`code expired`, `invalid
		// or already-used code`, `too many attempts`, `signup key required`), not JSON — surface
		// it verbatim rather than collapsing every 4xx/5xx into the same opaque status code, which
		// made "expired" and "already used" and "wrong signup key" all read identically here.
		const reason = await res.text().catch(() => '');
		throw new Error(reason || `pairing failed (${res.status})`);
	}
	const body = await res.json();
	if (!body || typeof body.deviceId !== 'string' || typeof body.token !== 'string') {
		throw new Error('pairing failed (unexpected reply)');
	}
	// A new pairing replaces whatever keys this room had.
	roomId = room;
	await wipeE2e(room);
	e2eKeys = null;
	pendingHs = { deviceId: body.deviceId, ps: Uint8Array.from(ps), privateKey: proof.privateKey, phonePub: proof.phonePub };
	recvGuard = new ReplayGuard();
	await e2ePut('pending', room, pendingHs);
	saveDevice(room, { deviceId: body.deviceId, token: body.token, ...(native ? { origin: nativeOrigin } : {}) });
	// Fire-and-forget, not awaited: `syncAuthToServiceWorker` is explicitly best-effort (see its
	// own doc) and — critically — `navigator.serviceWorker.ready` never rejects or times out on
	// its own. On a first-ever pairing no service worker has registered yet at this point
	// (`registerServiceWorker()` only runs after `claim()` returns, further down in both
	// callers), so `.ready` waits for a controller that will never arrive and `await`ing it here
	// hung the entire pairing flow forever — no error, no UI change, exactly "click Pair, nothing
	// happens". Letting it run in the background costs nothing: a push arriving before it finishes
	// (or fails) still falls back to `sw.js`'s generic notification, same as this function's own
	// doc already says for every other failure mode here.
	void syncAuthToServiceWorker(room, body.token);
	return body.token;
}

/**
 * Reads a pairing secret from what the person pasted or typed: the whole link
 * (`https://host/p/<room>#<key>`), the part after the `#`, or just the key, with or without
 * spaces and hyphens.
 * @param {string} input
 * @returns {{ ps: Uint8Array, room?: string, origin?: string }}
 * @throws {Error} with a message fit to show
 */
function parsePairingInput(input) {
	let text = String(input).trim();
	let room;
	let origin;
	const hash = text.lastIndexOf('#');
	if (hash >= 0) {
		const link = text.slice(0, hash);
		text = text.slice(hash + 1);
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) {
			let url;
			try { url = new URL(link); } catch { throw new Error('That link is not valid. Paste the whole pairing link from the desktop.'); }
			if (native) {
				// The shell has no relay of its own: the link says where it is. Only https, so the
				// pairing claim and token never cross the network in the clear.
				if (url.protocol !== 'https:') { throw new Error('That pairing link is not an https link.'); }
				origin = url.origin;
			} else if (url.origin !== location.origin) {
				throw new Error('That pairing link is for a different relay than this page.');
			}
			const m = /^\/p\/([^/]+)/.exec(url.pathname);
			if (m) { room = decodeURIComponent(m[1]); }
		}
	}
	try { text = decodeURIComponent(text); } catch { /* keep as typed */ }
	const compact = text.replace(/[\s-]+/g, '');
	if (!compact) { throw new Error('Paste the pairing link from the desktop, or type the key shown under the QR code.'); }
	if (compact.length === 8) {
		throw new Error('That is the old 8-character code. Paste the whole pairing link, or type the 26-character key shown under the QR code.');
	}
	let ps;
	try { ps = b32decode(compact); } catch { throw new Error('That is not a pairing key. Paste the pairing link, or type the key shown under the QR code.'); }
	if (ps.length !== 16) { throw new Error('That key is the wrong length. Paste the whole pairing link, or type all 26 characters of the key.'); }
	return { ps, room, origin };
}

// ---- Wire send helpers ----------------------------------------------------------------------

/**
 * Seals `payload` and sends it as a `t: 'm'` envelope. Every call site below must construct a
 * `type` that appears in {@link REMOTE_ALLOWED} — see this file's own top-of-file doc. Nothing is
 * ever sent unsealed: with no keys yet the call does nothing. Sealing is asynchronous, so frames
 * go through one queue that keeps their counters in order.
 * @param {Record<string, unknown> & { type: string }} payload
 * @returns {boolean} whether the frame was accepted for sending — callers that clear UI state (composer text, chips, …) on send must check this instead of assuming success (see `sendMessage`).
 */
function sendApp(payload) {
	const sock = ws;
	const keys = e2eKeys;
	if (!sock || sock.readyState !== WebSocket.OPEN || !keys) { return false; }
	let snapshot;
	try {
		// Copied now: callers may keep editing the objects they passed.
		snapshot = JSON.parse(JSON.stringify(payload));
	} catch {
		return false;
	}
	sendChain = sendChain.then(async () => {
		if (ws !== sock || sock.readyState !== WebSocket.OPEN || e2eKeys !== keys) { return; }
		const stream = sendStream;
		const sealed = await seal(keys.c2h, { deviceId: keys.deviceId, dir: 'c2h', s: stream.s, n: stream.n++ }, snapshot);
		if (ws !== sock || sock.readyState !== WebSocket.OPEN || e2eKeys !== keys) { return; }
		outSeq += 1;
		sock.send(JSON.stringify({ v: 1, t: 'm', seq: outSeq, p: sealed }));
	}).catch(() => { /* a frame that cannot be sealed is dropped, like one sent into a closed socket */ });
	return true;
}

/** @param {Record<string, unknown> & { c: string }} frame */
function sendControl(frame) {
	if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
	outSeq += 1;
	ws.send(JSON.stringify({ v: 1, t: 'c', seq: outSeq, p: frame }));
}

/**
 * The exact set of `extensions/openvs-chat/src/remote/policy.ts`'s `REMOTE_ALLOWED` array,
 * copied by hand. `scripts/test-pwa-contract.mjs` asserts every type this file actually sends is
 * both in this list AND in the real `REMOTE_ALLOWED` — so a drift between the two fails loudly
 * instead of silently letting the phone send a message the relay's own policy would reject.
 */
const REMOTE_ALLOWED = [
	'ready', 'send', 'promptResponse', 'stop', 'stopAll', 'setProvider', 'setModel', 'listModels',
	'listSkills', 'setSkill', 'toggleSkill', 'listMcp', 'enhancePrompt', 'steer', 'createSession',
	'switchSession', 'closeSession', 'clearSession', 'restoreSession', 'setMode', 'setQueue',
	'sync', 'fetchTranscript', 'undoRun', 'slash', 'attachActive', 'attachImage',
];
void REMOTE_ALLOWED; // referenced by the contract test via source text, not by import

// ---- Session helpers --------------------------------------------------------------------------

function activeSession() {
	return sessions.find(s => s.id === activeSessionId);
}

function sessionFor(msg) {
	return sessions.find(s => s.id === msg.sessionId) || (msg.sessionId ? undefined : activeSession());
}

// ---- Rendering ---------------------------------------------------------------------------------

function renderTabs() {
	if (!els.tabs) { return; }
	els.tabs.replaceChildren();
	// One chat needs no strip: the header already says where this is, and the space goes to the chat.
	if (sessions.length < 2) { return; }
	for (const session of sessions) {
		// A wrapper div, not a button: it holds two independently-clickable controls
		// (switch, close), and a button can't nest a button per HTML's interactive-content rule.
		const classes = ['tab', session.id === activeSessionId ? 'tab-active' : '', session.streaming ? 'tab-streaming' : ''];
		const tab = el('div', classes.filter(Boolean).join(' '));
		if (session.streaming) {
			// A run can be going in a *background* tab — nothing else in this tab strip would show
			// it, since `renderAll()` (the transcript/stop-button/etc. refresh) only ever runs for
			// the active session. This dot is what answers "is anything happening in one of my
			// other chats right now" without switching to look, mirrors the desktop panel's own
			// spinner-per-tab, and is what makes `switchSession` below worth reaching for.
			tab.appendChild(el('span', 'tab-spinner'));
		}
		// A real <button>, not a <span>: the old single-element tab was itself a <button> and
		// so was keyboard-focusable/Enter-activatable — splitting it into title+close must not
		// silently drop that for the switch half.
		const title = el('button', 'tab-title', session.title || 'Chat');
		title.type = 'button';
		if (session.id === activeSessionId) { title.setAttribute('aria-current', 'true'); }
		title.addEventListener('click', () => switchSession(session.id));
		const close = el('button', 'tab-close');
		close.type = 'button';
		close.setAttribute('aria-label', `Close ${session.title || 'chat'}`);
		close.appendChild(icon('x'));
		close.addEventListener('click', (e) => {
			e.stopPropagation();
			closeSession(session.id);
		});
		tab.appendChild(title);
		// Only the chat being read can be closed, so a thumb aimed at another tab cannot close it.
		if (session.id === activeSessionId) { tab.appendChild(close); }
		els.tabs.appendChild(tab);
		if (session.id === activeSessionId && typeof tab.scrollIntoView === 'function') {
			tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}
}

/**
 * Whether the messages pane should auto-scroll to the bottom after the next render — a plain
 * `replaceChildren()` rebuild (see `transcript.js`'s `render`) resets `scrollTop` to 0 on every
 * single token, which without this reads as "the chat won't stay scrolled down", the opposite of
 * every native messaging app. Tracked rather than unconditional so a user who has scrolled up to
 * reread earlier turns mid-stream isn't yanked back down on the next token — see the `scroll`
 * listener below, which is what keeps this honest.
 */
let stickToBottom = true;
/** Distance (px) from the true bottom still counted as "at the bottom" — matches the small rubber-band slop touch scrolling leaves even when a user meant to land at the end. */
const STICK_BOTTOM_THRESHOLD_PX = 48;

if (els.messages) {
	els.messages.addEventListener('scroll', () => {
		const el = els.messages;
		stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_THRESHOLD_PX;
	});
}

/**
 * Full rebuild of the visible conversation — for a genuinely new view only: a tab switch, a
 * fresh `transcript`, a reconnect. Streaming never comes through here (see
 * {@link schedulePendingPaint}); rebuilding the whole list per token is what made long chats
 * stutter and wiped tool rows, notices and approval cards appended between rebuilds.
 */
function renderAll(scrollToEnd = true) {
	const session = activeSession();
	if (!session || !els.messages) { return; }
	renderTranscript(els.messages, session, { onLoadEarlier: loadEarlier });
	renderUndoBar(session);
	// Approval/question cards live outside the transcript — put back the ones still waiting
	// on an answer in this tab, or a rebuild would silently strand the run behind them.
	cards.reattach(session.id);
	renderChrome();
	if (scrollToEnd) { scrollIfStuck(true); }
}

/** The Undo bar under the tab's latest run that changed files; mirrors media/main.js's `renderUndoBar`. */
function renderUndoBar(session) {
	if (!els.messages) { return; }
	els.messages.querySelector('.undo-bar')?.remove();
	if (!session.undo || !session.undo.files.length) { return; }
	const undo = session.undo;
	const bar = document.createElement('div');
	bar.className = 'notice notice-info undo-bar';
	const label = document.createElement('span');
	label.textContent = `This run changed ${undo.files.length} file${undo.files.length === 1 ? '' : 's'}: ${undo.files.join(', ')} `;
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = 'Undo';
	button.addEventListener('click', () => {
		if (sendApp({ type: 'undoRun', sessionId: session.id, runId: undo.runId })) {
			button.disabled = true;
			button.textContent = 'Undoing…';
		}
	});
	bar.append(label, button);
	els.messages.appendChild(bar);
}

/** Everything around the transcript that tracks the active session: todos, mode, Stop, queue, composer hint. */
function renderChrome() {
	const session = activeSession();
	if (!session) { return; }
	if (els.todos) { renderTodos(els.todos, session.todos || []); }
	if (els.modeSelect) { els.modeSelect.value = session.mode || 'ask'; syncModeSeg(); }
	if (els.stopBtn) { els.stopBtn.hidden = !session.streaming; }
	if (els.composer) {
		els.composer.placeholder = session.streaming
			? (session.runMode === 'agent' && session.steerable !== false ? 'Steer the running agent…' : 'Queue a follow-up…')
			: 'Message…';
	}
	renderQueueChips();
	renderContextChip();
}

/** Scrolls to the newest content if the reader is following along (see `stickToBottom`), or unconditionally with `force`. */
function scrollIfStuck(force) {
	if (!els.messages) { return; }
	if (force) { stickToBottom = true; }
	if (stickToBottom) { els.messages.scrollTop = els.messages.scrollHeight; }
}

let paintQueued = false;

/**
 * Repaints only the streaming row, at most once per frame. Token frames arrive faster than a
 * phone can lay out a growing markdown block; coalescing to animation frames keeps typing
 * smooth and costs nothing in freshness (nothing paints faster than a frame anyway).
 */
function schedulePendingPaint() {
	if (paintQueued) { return; }
	paintQueued = true;
	requestAnimationFrame(() => {
		paintQueued = false;
		const session = activeSession();
		if (!session || !els.messages) { return; }
		renderPending(els.messages, session);
		scrollIfStuck(false);
	});
}

/**
 * Adds a finished entry to `session` and, if it's on screen, appends just that row.
 * @param {any} session
 * @param {any} entry
 * @returns {any} the appended row, or `undefined` for a background tab
 */
function pushEntry(session, entry) {
	(session.messages = session.messages || []).push(entry);
	if (session.id !== activeSessionId || !els.messages) { return undefined; }
	const row = appendEntry(els.messages, entry);
	renderPending(els.messages, session);
	scrollIfStuck(false);
	return row;
}

/** Turns the streamed text so far into a finished assistant entry — at a tool call, a step boundary, or the end of the run. Mirrors media/main.js's `commitPending`. */
function commitPending(session) {
	const text = typeof session.pending === 'string' ? session.pending.trim() : '';
	session.pending = '';
	if (text) {
		pushEntry(session, { role: 'assistant', content: text });
	} else if (session.id === activeSessionId && els.messages) {
		renderPending(els.messages, session);
	}
}

/**
 * Records a one-line notice in `session` (so a later rebuild keeps it), or shows it
 * unattached when there is no session to own it.
 * @param {any} session
 * @param {'info' | 'error'} kind
 * @param {string} text
 */
function note(session, kind, text) {
	if (!text) { return; }
	if (session) {
		pushEntry(session, { role: 'assistant', kind, content: text });
	} else if (els.messages) {
		appendNotice(els.messages, kind === 'error' ? 'notice-error' : 'notice-info', text);
		scrollIfStuck(false);
	}
}

/** Live tool rows by `<sessionId>:<callId>` — the entry and, for the visible tab, its row. */
const liveTools = new Map();

/** Mirrors media/main.js's `modelSupportsTools` (and src/providers/types.ts's `entrySupportsTools`) — keep them in sync. */
function modelSupportsTools(provider, model) {
	if (!provider || !provider.supportsTools) { return false; }
	const entry = (fetchedModels[provider.id] || []).find(e => e && e.id === model);
	if (entry && typeof entry.toolCapable === 'boolean') { return entry.toolCapable; }
	const patterns = provider.toolModelPatterns || [];
	if (!patterns.length) { return true; }
	return patterns.some(p => {
		try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
	});
}

/**
 * Gives a <select> a customizable-select author button (`<button><selectedcontent>`), which
 * styles.css's Dropdowns block uses on pointer devices so a long model id ellipsizes inside
 * the pill. Inert where `appearance: base-select` is not applied — a phone keeps its native
 * picker. Mirrors `media/main.js`'s `withSelectButton`.
 * @param {HTMLSelectElement | null} select
 */
function withSelectButton(select) {
	if (select && !select.querySelector(':scope > button')) {
		const button = el('button');
		button.type = 'button';
		button.tabIndex = -1;
		button.appendChild(document.createElement('selectedcontent'));
		select.prepend(button);
	}
}

/**
 * Removes a select's options but not its {@link withSelectButton} button.
 * @param {HTMLSelectElement} select
 */
function clearOptions(select) {
	for (const child of [...select.children]) {
		if (child.tagName !== 'BUTTON') { child.remove(); }
	}
}

function renderProviderSelect() {
	if (!els.providerSelect) { return; }
	// With one provider there is nothing to choose, so the control is not shown.
	els.providerSelect.hidden = providers.length < 2;
	clearOptions(els.providerSelect);
	for (const provider of providers) {
		// A provider with no credential can't answer; say so in the list rather than let a pick
		// fail on the next send with "No API key".
		const needsKey = provider.requiresApiKey && !provider.hasApiKey;
		const opt = el('option', undefined, `${provider.label || provider.id}${needsKey ? ' — no key' : ''}`);
		opt.setAttribute('value', provider.id);
		els.providerSelect.appendChild(opt);
	}
	els.providerSelect.value = selectedProvider;
}

/**
 * Model ids offered for the selected provider — the host's live catalog once it has arrived,
 * the provider's suggestions until then (media/main.js's `providerModelIds` does the same).
 * The configured model and a still-unconfirmed pick (see `pendingModel`) are always listed, so
 * the select can show what is actually selected before any catalog lands.
 */
function renderModelSelect() {
	if (!els.modelSelect) { return; }
	clearOptions(els.modelSelect);
	const p = providers.find(x => x.id === selectedProvider);
	const live = fetchedModels[selectedProvider] || [];
	const error = modelErrors[selectedProvider];
	const seen = new Set();
	const addOption = id => {
		if (!id || seen.has(id)) { return; }
		seen.add(id);
		const entry = live.find(e => e && e.id === id);
		const tags = [modelSupportsTools(p, id) ? 'agent' : '', entry && entry.free ? 'free' : ''].filter(Boolean);
		const opt = el('option', undefined, tags.length ? `${id} · ${tags.join(' · ')}` : id);
		opt.setAttribute('value', id);
		els.modelSelect.appendChild(opt);
	};
	if (error) {
		// Touch has no hover, so the `title` below never shows on a phone — say it in the list.
		const warn = el('option', undefined, 'Couldn’t load models — showing suggestions');
		warn.disabled = true;
		els.modelSelect.appendChild(warn);
	}
	const effective = (pendingModel && pendingModel.provider === selectedProvider) ? pendingModel.model : (p && p.model);
	if (effective) { addOption(effective); }
	for (const model of live.length ? live : (p && p.suggestedModels) || []) {
		addOption(typeof model === 'string' ? model : model && model.id);
	}
	if (effective) { els.modelSelect.value = effective; }
	els.modelSelect.title = error
		? `Couldn't load models (${error}) — showing suggestions`
		: live.length ? `${live.length} models available` : 'Suggested models — the live list has not loaded yet';
	els.modelSelect.classList.toggle('select-warn', !!error);
}

function renderSkills() {
	if (!els.skillsList) { return; }
	els.skillsList.replaceChildren();
	if (els.skillsPanel) { els.skillsPanel.hidden = !skillsCatalog.length; }
	const active = skillsCatalog.filter(skill => skill.active).length;
	if (els.skillsSummary) { els.skillsSummary.textContent = active ? `Skills · ${active} on` : 'Skills'; }
	for (const skill of skillsCatalog) {
		const chip = el('button', 'skill-chip', skill.name || skill.id);
		chip.type = 'button';
		chip.setAttribute('aria-pressed', skill.active ? 'true' : 'false');
		// Field name must be `text`, not `id` — `chatViewProvider.ts`'s `case 'toggleSkill':` reads
		// `message.text` (see `media/main.js`'s own `{ type: 'toggleSkill', text: skill.id }`).
		// `toggleSkill` flips current state on the host, which answers with a fresh `skills`.
		chip.addEventListener('click', () => sendApp({ type: 'toggleSkill', text: skill.id }));
		els.skillsList.appendChild(chip);
	}
}

/** Renders the pending `attachedContext` as a removable chip above the composer, or hides it. */
function renderContextChip() {
	if (!els.contextChip) { return; }
	els.contextChip.replaceChildren();
	const session = activeSession();
	const imageCount = session ? pendingImageCount(session.id) : 0;
	if (!attachedContext && !imageCount) {
		els.contextChip.hidden = true;
		return;
	}
	els.contextChip.hidden = false;
	if (attachedContext) {
		const chip = el('span', 'chip');
		chip.appendChild(icon('file'));
		chip.appendChild(el('span', 'chip-text', attachedContext.label || 'Active file'));
		const remove = el('button', 'chip-remove');
		remove.type = 'button';
		remove.setAttribute('aria-label', 'Remove attached file');
		remove.appendChild(icon('x'));
		remove.addEventListener('click', () => { attachedContext = null; renderContextChip(); });
		chip.appendChild(remove);
		els.contextChip.appendChild(chip);
	}
	if (imageCount) {
		// No remove control: the images are already held by the host (`attachImage`), which has
		// no message to drop them — they go out with the next send, and saying so beats a ✕ that
		// would only hide them here.
		const chip = el('span', 'chip');
		chip.appendChild(icon('image'));
		chip.appendChild(el('span', 'chip-text', `${imageCount} image${imageCount === 1 ? '' : 's'} · sends with your next message`));
		els.contextChip.appendChild(chip);
	}
}

/**
 * Mirrors the host's copy of a session's queue (see `setQueue`'s doc for why the host needs its
 * own copy at all) — a wholesale replace, like `src/session/store.ts`'s own `setQueue`, so a
 * chip removed locally can't race a host-side incremental push into a different order.
 * @param {any} session
 */
function persistQueue(session) {
	const queue = (session.queue || []).slice();
	// Marked pending *before* the send attempt, not just on failure — a `sendApp` that
	// genuinely goes out can still have its `config`/`sessions` confirmation lost to a drop
	// that happens moments later; `case 'sessions':` clears this once the host actually
	// confirms it, same as `pendingModel`'s equivalent guard.
	pendingQueues.set(session.id, queue);
	sendApp({ type: 'setQueue', sessionId: session.id, queue });
}

/** Shallow string-array equality — used to tell a `sessions` snapshot's queue apart from a still-unconfirmed local edit (see `pendingQueues`'s own doc). */
function sameQueue(a, b) {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) { return false; }
	}
	return true;
}

/** Renders the active session's queued follow-ups as removable chips above the composer — mirrors media/main.js's own `renderQueueChips`. */
function renderQueueChips() {
	if (!els.queueChips) { return; }
	const session = activeSession();
	els.queueChips.replaceChildren();
	const queue = (session && session.queue) || [];
	if (!queue.length) {
		els.queueChips.hidden = true;
		return;
	}
	els.queueChips.hidden = false;
	queue.forEach((text, index) => {
		const chip = el('span', 'queue-chip');
		chip.title = text;
		chip.appendChild(icon('clock'));
		chip.appendChild(el('span', 'queue-chip-text', text));
		const remove = el('button');
		remove.type = 'button';
		remove.setAttribute('aria-label', 'Remove queued message');
		remove.appendChild(icon('x'));
		remove.addEventListener('click', () => {
			session.queue.splice(index, 1);
			persistQueue(session);
			renderQueueChips();
		});
		chip.appendChild(remove);
		els.queueChips.appendChild(chip);
	});
}

// ---- History panel (Phase 6 polish: `history`/`restoreSession` were already wired end-to-end —
// the host pushes `history` unprompted on every `ready`, and `restoreSession` is REMOTE_ALLOWED
// — but nothing on this side ever rendered the one or sent the other, so a closed/cleared chat
// was reachable from the desktop panel and permanently gone from the phone. ------------------

/** Relative "saved at" time, mirroring `extensions/openvs-chat/media/pairing.js`'s own `relDeviceTime` — duplicated, not shared, for the same cross-package reason as this file's other hand-copies (see its top-of-file doc). */
function relTime(ts) {
	if (!ts) { return ''; }
	const min = Math.floor((Date.now() - ts) / 60000);
	if (min < 1) { return 'just now'; }
	if (min < 60) { return `${min}m ago`; }
	const hr = Math.floor(min / 60);
	if (hr < 24) { return `${hr}h ago`; }
	const day = Math.floor(hr / 24);
	if (day < 7) { return `${day}d ago`; }
	return new Date(ts).toLocaleDateString();
}

function renderHistoryList() {
	if (!els.historyList) { return; }
	els.historyList.replaceChildren();
	if (!historyEntries.length) {
		els.historyList.appendChild(el('div', 'history-empty', 'No archived chats yet — closed or cleared tabs land here.'));
		return;
	}
	// Newest first — `savedAt` is a `Date.now()` ms timestamp; entries with none (shouldn't
	// happen, but a wire payload is never fully trusted) sort last rather than throwing.
	const sorted = historyEntries.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
	for (const entry of sorted) {
		const row = el('button', 'history-row');
		row.type = 'button';
		row.appendChild(el('span', 'history-row-title', entry.title || 'Chat'));
		row.appendChild(el('span', 'history-row-time', relTime(entry.savedAt)));
		row.addEventListener('click', () => {
			if (sendApp({ type: 'restoreSession', historyId: entry.id, mode: 'ask' })) {
				openNextNewSession = true;
			}
			closeHistoryPanel();
		});
		els.historyList.appendChild(row);
	}
}

function openHistoryPanel() {
	if (!els.historyPanel) { return; }
	renderHistoryList();
	els.historyPanel.hidden = false;
}

function closeHistoryPanel() {
	if (!els.historyPanel) { return; }
	els.historyPanel.hidden = true;
}

/** Draws the Ask / Plan / Agent segmented control; the hidden `#modeSelect` stays the source of truth. */
function buildModeSeg() {
	if (!els.modeSeg || !els.modeSelect) { return; }
	for (const option of [...els.modeSelect.querySelectorAll('option')]) {
		const button = el('button', 'seg-btn', option.textContent || option.value);
		button.type = 'button';
		button.setAttribute('role', 'radio');
		button.dataset.mode = option.value;
		button.addEventListener('click', () => {
			if (!els.modeSelect || els.modeSelect.value === option.value) { return; }
			els.modeSelect.value = option.value;
			els.modeSelect.dispatchEvent(new Event('change'));
		});
		els.modeSeg.appendChild(button);
	}
	syncModeSeg();
}

/** Marks the segment matching the select's value. */
function syncModeSeg() {
	if (!els.modeSeg || !els.modeSelect) { return; }
	for (const button of els.modeSeg.querySelectorAll('.seg-btn')) {
		button.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (button).dataset.mode === els.modeSelect.value));
	}
}

function historyPanelOpen() {
	return !!els.historyPanel && !els.historyPanel.hidden;
}

// ---- Slash-command autocomplete menu (mirrors media/main.js's own updateSlashMenu/
// renderSlashMenu/applySlashSelection — a tap-to-complete list here rather than arrow-key
// navigation, since a phone's on-screen keyboard has no arrow keys to navigate one with). ----

/** @type {{cmd: string, desc: string}[]} */
let slashMatches = [];

function hideSlashMenu() {
	if (!els.slashMenu) { return; }
	els.slashMenu.hidden = true;
	els.slashMenu.replaceChildren();
	slashMatches = [];
}

/**
 * Shows or hides the slash-command menu for the composer's current content. Only while the
 * whole draft is still just `/` plus the command word being typed — once a space follows, the
 * command is decided and `handleSlash` takes it from there; matches this exactly (`^\/(\w*)$`,
 * no trailing content) — same regex as media/main.js's own `updateSlashMenu`.
 */
function updateSlashMenu() {
	if (!els.slashMenu || !els.composer) { return; }
	const m = /^\/(\w*)$/.exec(els.composer.value);
	if (!m) { hideSlashMenu(); return; }
	const partial = m[1].toLowerCase();
	slashMatches = slashCommands.filter(c => c.cmd.startsWith(partial));
	if (!slashMatches.length) { hideSlashMenu(); return; }
	els.slashMenu.replaceChildren();
	for (const match of slashMatches) {
		const row = el('button', 'slash-item');
		row.type = 'button';
		row.appendChild(el('span', 'slash-cmd', `/${match.cmd}`));
		row.appendChild(el('span', 'slash-desc', match.desc));
		// mousedown, not click: fires before the textarea would blur on a touch tap, keeping
		// focus (and the on-screen keyboard) up — same reasoning as media/main.js's own menu.
		row.addEventListener('mousedown', e => {
			e.preventDefault();
			if (!els.composer) { return; }
			els.composer.value = `/${match.cmd} `;
			hideSlashMenu();
			els.composer.focus();
			const len = els.composer.value.length;
			els.composer.setSelectionRange(len, len);
		});
		els.slashMenu.appendChild(row);
	}
	els.slashMenu.hidden = false;
}

/**
 * After any break in the link — this device reconnecting, or VS Code rejoining the relay —
 * a reply that was streaming lost whatever tokens were sent in between (the relay keeps no
 * replay buffer). Drop the partial text and flag the run, so its `done` fetches the real reply
 * (see `case 'done':`) instead of committing a spliced one.
 */
function markStreamGaps() {
	for (const s of sessions) {
		if (s.streaming) {
			s.gap = true;
			s.pending = '';
		}
	}
	const s = activeSession();
	if (s && els.messages) { renderPending(els.messages, s); }
}

/**
 * `ready` only carries the host's *own* active chat's transcript; when this device had a
 * different chat open before the link dropped, ask for that one too.
 */
function resyncOwnSession() {
	if (activeSessionId) {
		sendApp({ type: 'sync', sessionId: activeSessionId });
	}
}

/** Asks the host for the page of messages before the oldest one shown. */
function loadEarlier() {
	const s = activeSession();
	if (!s || !s.from || s.loadingEarlier) { return; }
	if (sendApp({ type: 'fetchTranscript', sessionId: s.id, before: s.from, count: 30 })) {
		s.loadingEarlier = true;
	}
}

/** The steady-state status line once the relay has welcomed this device — see {@link hostOnline}. */
/** The desktop's folder name, from the host's `config`: shown beside "Connected" so the phone names what it is driving. */
let workspaceName = '';

function refreshStatus() {
	if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
	if (!e2eKeys) {
		setStatus(SECURING_TEXT, 'status-warn');
	} else if (hostOnline === false) {
		setStatus('Stormcoder is closed on your computer — open it to continue', 'status-warn');
	} else {
		setStatus('Connected', 'status-ok', workspaceName);
	}
}

/**
 * @param {string} text
 * @param {string} [className]
 * @param {string} [scope] what the status is about (the desktop's folder), muted after the text
 */
function setStatus(text, className, scope) {
	if (!els.status) { return; }
	els.status.textContent = text;
	if (scope) { els.status.appendChild(el('span', 'status-scope', `· ${scope}`)); }
	els.status.className = `status ${className || ''}`.trim();
}

// ---- Outbound actions (each type here must be in REMOTE_ALLOWED) ------------------------------

/**
 * Echoes `text` into `session`'s transcript as a user turn the moment it's sent — the host
 * tells every *other* client via `userTurn` but skips the one that sent it, so every path that
 * actually delivers a turn (an ordinary send, a drained queue entry, a steer) needs this, same
 * as media/main.js's own `sendText`/`steer` do inline.
 * @param {any} session
 * @param {string} text
 * @param {number} [imageCount] images the host merges into this turn (an ordinary send only)
 */
function echoUserTurn(session, text, imageCount = 0) {
	pushEntry(session, { role: 'user', content: text, imageCount });
	if (session.id === activeSessionId) {
		// Sending (or steering) a turn always lands the view on it, the same as every native
		// chat app — even if the user had scrolled up to reread something first.
		scrollIfStuck(true);
	}
}

/**
 * Sends `text` as a new turn in `session` right now — the shared path behind the composer's own
 * (non-streaming) send, a queue entry drained on `done`, and a bounced steer that falls back to
 * an immediate send once its run has actually ended (see `case 'steerRejected'`). `modeOverride`
 * lets a drain/bounce resend in the run's own `runMode` rather than whatever the mode dropdown
 * currently shows, which may have changed since — mirrors media/main.js's own queue drain.
 * @param {any} session
 * @param {string} text
 * @param {string} [modeOverride]
 * @returns {boolean} whether the frame actually went out — see `sendApp`'s own doc.
 */
function dispatchSend(session, text, modeOverride, fromQueue = false) {
	// `provider`/`model` must be sent explicitly, same as `media/main.js` always does (see
	// its own `send` payload) — `handleSend`'s fallback (`message.provider ||
	// registry.getDefaultProviderId()`) only kicks in when they're absent, and this used to
	// always omit them, so picking a provider/model here only ever worked by way of a shared
	// *global* setting (`setProvider`/`setModel`'s `openvsChat.defaultProvider`/`<id>.model`)
	// that anything else touching those settings — the desktop webview included, which never
	// writes them itself — could leave stale. Sending them directly is what the desktop
	// already does and is the only way this client's own dropdowns reliably drive its own runs.
	//
	// `attachedContext` is only ever meant for whatever the user is *actively* composing —
	// this function is now also the queue-drain and steer-bounce path (both of which can fire
	// for a *background* session, e.g. a different tab's run finishing while the user is
	// looking at and attaching context to another one entirely). Scoping it to the active
	// session avoids two bugs a global read here would otherwise cause: a background session's
	// queued follow-up silently picking up context the user attached for a completely
	// different chat, and — worse — that background send then clearing the chip out from under
	// context the user is still actively composing with in the tab they're looking at.
	const isActiveSend = session.id === activeSessionId;
	const context = isActiveSend ? attachedContext : undefined;
	const ok = sendApp({
		type: 'send', sessionId: session.id, text, mode: modeOverride || session.mode || 'ask',
		provider: selectedProvider, model: els.modelSelect ? els.modelSelect.value : '',
		...(context ? { context } : {}),
		// Marks a queue drain: the desktop panel drains the same queue on the same `done`, and
		// the host accepts only the first drain per finished run (see handleSend).
		...(fromQueue ? { fromQueue: true } : {}),
	});
	if (!ok) { return false; }
	echoUserTurn(session, text, pendingImageCount(session.id));
	// The host merged this session's held `attachImage` uploads into the turn just sent.
	pendingImages.delete(session.id);
	if (isActiveSend) {
		attachedContext = null;
		renderContextChip();
	}
	return true;
}

/**
 * True if `text` was consumed as a leading-slash command, forwarded to the host's `slash`
 * dispatch (`extensions/openvs-chat/src/session/slash.ts`'s `runSlash`) instead of an ordinary
 * `send` — a plain-text port of `media/main.js`'s own `handleSlash`. Checked, like there, *before*
 * the streaming steer-vs-queue decision below: `/clear`, `/mode`, `/skill`, … must act immediately
 * even mid-run, not get queued behind whatever the current run is doing. `/history` and `/enhance`
 * stay client-owned on the desktop (a UI panel and a composer prefill, respectively) — this shell
 * has no history panel yet (see `case 'history':`'s own doc) and `/enhance` already has its own
 * ✨ button, so both are simply left to fall through to the host's "unrecognized — forward as an
 * ordinary message" fallback, exactly as an unrecognized command like `/foo` already does.
 * @param {any} session
 * @param {string} text
 * @returns {boolean}
 */
function handleSlash(session, rawText) {
	const text = rawText.trim();
	if (!/^\/\w+/.test(text)) { return false; }
	hideSlashMenu();
	// `/history` is client-owned on the desktop too (opens a local panel; the host has no
	// business acting on it — see `session/slash.ts`'s `runSlash` doc) — handled fully locally,
	// same as `media/main.js`'s own `handleSlash`, rather than forwarded to fall through the
	// host's "unrecognized — send as a normal message" path and get read out to the model.
	if (/^\/history\b/i.test(text)) {
		openHistoryPanel();
		return true;
	}
	if (/^\/clear\b/i.test(text)) {
		// Composer attachments are client-only UI state; the host owns archiving/resetting the
		// session itself (`SessionStore.clearSession`, reached via `slash` below) — mirrors
		// `media/main.js`'s own `/clear` handling.
		attachedContext = null;
		pendingImages.delete(session.id);
		renderContextChip();
	}
	// The host appends this turn to the session store itself and broadcasts the resulting
	// `sessions`/`transcript` update to every connected sink (see `sendFollowUp`/each
	// `SlashEffects` callback in `chatViewProvider.ts`) — unlike `dispatchSend`, this must not
	// also echo the turn locally, or it would show twice once that broadcast arrives.
	sendApp({ type: 'slash', sessionId: session.id, command: text });
	return true;
}

function sendMessage() {
	const session = activeSession();
	if (!session || !els.composer) { return; }
	const text = els.composer.value;
	if (!text.trim() && !(pendingImageCount(session.id) && !session.streaming)) { return; }
	if (handleSlash(session, text)) {
		clearComposer();
		return;
	}
	if (session.streaming) {
		// Mid-run input: steer a live agent run, queue for anything else — mirrors
		// media/main.js's own `send()` decision (`s.runMode === 'agent' && s.steerable !== false`).
		if (session.runMode === 'agent' && session.steerable !== false) {
			const ok = sendApp({ type: 'steer', sessionId: session.id, runId: session.runId, text });
			// `sendApp` silently no-ops while the socket isn't OPEN (e.g. a reconnect in flight
			// after the phone was backgrounded) — bail out before touching any UI state so the
			// text stays in the composer and the user knows to wait for "Connected" and retry,
			// instead of believing it went out.
			if (!ok) {
				note(session, 'error', 'Not connected — nothing was sent. Your message is still in the composer; send it again once reconnected.');
				return;
			}
			echoUserTurn(session, text);
			clearComposer();
			return;
		}
		// Not steerable right now (no agent loop, or the host said this run can't be): queue it
		// instead — sent once this session's current run finishes (see the `done` handler's own
		// drain) — rather than delivering it into a run that has nothing steering to receive it.
		// Not echoed into the transcript: nothing has actually been sent yet, only queued —
		// the chip above the composer is what shows it is pending.
		(session.queue = session.queue || []).push(text);
		persistQueue(session);
		renderQueueChips();
		clearComposer();
		return;
	}
	if (!dispatchSend(session, text)) {
		note(session, 'error', 'Not connected — nothing was sent. Your message is still in the composer; send it again once reconnected.');
		return;
	}
	clearComposer();
}

/** Empties the composer and shrinks it back to one line. */
function clearComposer() {
	if (!els.composer) { return; }
	els.composer.value = '';
	autosizeComposer();
}

/** Grows the composer with its content up to a cap, so a long prompt is readable without scrolling a two-line box. */
function autosizeComposer() {
	if (!els.composer) { return; }
	els.composer.style.height = 'auto';
	els.composer.style.height = `${Math.min(els.composer.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
}

/**
 * Reads an image File, downscales it to at most {@link MAX_IMAGE_DIM} on its long edge,
 * re-encodes as JPEG, and resolves a base64 payload — see this file's "Image attachments"
 * section doc for how this relates to media/main.js's own `resizeImage`.
 * @param {File} file
 * @returns {Promise<{mimeType: string, data: string}>}
 */
function resizeImageForUpload(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error || new Error('Failed to read image.'));
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => reject(new Error('Failed to decode image.'));
			img.onload = () => {
				let width = img.naturalWidth;
				let height = img.naturalHeight;
				const longEdge = Math.max(width, height);
				if (longEdge > MAX_IMAGE_DIM) {
					const scale = MAX_IMAGE_DIM / longEdge;
					width = Math.round(width * scale);
					height = Math.round(height * scale);
				}
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('Canvas unavailable.')); return; }
				// JPEG has no alpha: without a fill, a transparent PNG's clear pixels encode as
				// black (media/main.js's resizeImage fills the same way).
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, width, height);
				ctx.drawImage(img, 0, 0, width, height);
				const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
				resolve({ mimeType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
			};
			img.src = /** @type {string} */ (reader.result);
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Resizes `file` client-side, then ships it to the host as a chunked `attachImage` upload:
 * {@link ATTACH_CHUNK_CHARS}-character slices of the already-base64-encoded image, so
 * reassembly on the host is plain concatenation (see `UploadAssembler`'s doc). The resize here
 * is a courtesy for well-behaved uploads, not a security boundary — the host enforces the real
 * per-upload/per-session ceilings regardless of what this function sends.
 * @param {File} file
 */
async function uploadImage(file) {
	const session = activeSession();
	if (!session) { return; }
	let resized;
	try {
		resized = await resizeImageForUpload(file);
	} catch (err) {
		note(session, 'error', `Couldn’t attach the image: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const uploadId = crypto.randomUUID();
	uploadSessions.set(uploadId, session.id);
	const total = Math.max(1, Math.ceil(resized.data.length / ATTACH_CHUNK_CHARS));
	for (let index = 0; index < total; index++) {
		sendApp({
			type: 'attachImage',
			sessionId: session.id,
			uploadId,
			index,
			total,
			chunk: resized.data.slice(index * ATTACH_CHUNK_CHARS, (index + 1) * ATTACH_CHUNK_CHARS),
			// Carried on chunk 0 only — see AttachImageChunk's doc on the host side.
			...(index === 0 ? { mimeType: resized.mimeType } : {}),
		});
	}
}

/**
 * Set while this device waits for a chat it asked for (`createSession`, `restoreSession`) to
 * show up in a `sessions` push — the push that lists a new id is the only thing that names it,
 * so the new id seen then is the one to open. Cleared once that happens.
 */
let openNextNewSession = false;

function createSession() {
	// `activate: false`: this device opens its new chat itself (see `openNextNewSession`); the
	// desktop stays on whatever chat it has open instead of being switched away mid-thought.
	if (sendApp({ type: 'createSession', activate: false, mode: (els.modeSelect && els.modeSelect.value) || 'ask' })) {
		openNextNewSession = true;
	}
}

/**
 * Opens one of the chats on this device only. Each device keeps its own open chat: switching
 * here used to move the desktop to the same chat too (and the desktop's switches yanked the
 * phone along), which made "start something on the phone, come back to it later" fight with
 * whatever the desktop was doing. Opens from the cache at once, then asks the host for that
 * chat's current transcript and run state (`sync` answers this device alone).
 * @param {string} id
 */
function switchSession(id) {
	if (id === activeSessionId || !sessions.some(s => s.id === id)) { return; }
	activeSessionId = id;
	renderTabs();
	renderAll();
	sendApp({ type: 'sync', sessionId: id });
}

function closeSession(id) {
	sendApp({ type: 'closeSession', sessionId: id });
}

function clearSession() {
	const session = activeSession();
	if (!session) { return; }
	sendApp({ type: 'clearSession', sessionId: session.id });
}

function stopRun() {
	const session = activeSession();
	if (!session) { return; }
	sendApp({ type: 'stop', sessionId: session.id });
}

function setMode(mode) {
	const session = activeSession();
	if (!session) { return; }
	session.mode = mode;
	sendApp({ type: 'setMode', sessionId: session.id, mode });
	if (mode === 'agent') { ensureAgentModel(); }
	renderChrome();
}

/**
 * Agent mode needs a tool-calling model; picking it with one that can't just fails on the
 * next send. Switch to the first capable model listed instead, and say so — the same
 * invariant media/main.js's `ensureAgentModel` keeps on the desktop.
 */
function ensureAgentModel() {
	const p = providers.find(x => x.id === selectedProvider);
	if (!p || !els.modelSelect) { return; }
	const model = els.modelSelect.value;
	if (modelSupportsTools(p, model)) { return; }
	const alt = [...els.modelSelect.options].map(o => o.value).find(id => modelSupportsTools(p, id));
	if (alt) {
		els.modelSelect.value = alt;
		setModel(alt);
		note(activeSession(), 'info', `${model || 'This model'} can’t run Agent mode, so the model was switched to ${alt}.`);
	} else {
		note(activeSession(), 'error', `No ${p.label || p.id} model listed here supports Agent mode — pick another provider, or use Ask or Plan.`);
	}
}

function setProvider(providerId) {
	selectedProvider = providerId;
	// A pending pick belongs to the provider it was made under — switching providers drops it
	// rather than let it wrongly win a race under the new one (see `pendingModel`'s own doc).
	pendingModel = null;
	sendApp({ type: 'setProvider', provider: providerId });
	// The host answers from its cache when it has one, so asking costs nothing when it's warm.
	if (!fetchedModels[providerId] || !fetchedModels[providerId].length) {
		sendApp({ type: 'listModels', provider: providerId });
	}
	renderModelSelect();
	const session = activeSession();
	if (session && session.mode === 'agent') { ensureAgentModel(); }
}

function setModel(model) {
	pendingModel = { provider: selectedProvider, model };
	sendApp({ type: 'setModel', provider: selectedProvider, model });
}

function enhancePrompt() {
	if (!els.composer) { return; }
	const text = els.composer.value.trim();
	if (!text) { return; }
	sendApp({ type: 'enhancePrompt', text });
}

// ---- Inbound dispatch (mirrors media/main.js's `case 'x':` switch) -----------------------------

function handleAppMessage(msg) {
	switch (msg.type) {
		// Only the provider catalog + default selection are pulled out of `config` — mirrors
		// `media/main.js`'s own `case 'config':` for that part. The rest of the payload
		// (baseUrl/approval/systemPrompt/rules/…) is desktop-settings-only. `models` don't need
		// requesting here: the host pushes one `models` message per provider right after
		// `config` (`pushAvailableModels`), handled by `case 'models':` below.
		case 'config': {
			providers = Array.isArray(msg.providers) ? msg.providers : [];
			// Always follow the host's `selectedProvider` — it's the one shared setting any
			// connected client can change, including the desktop panel, and a switch made there
			// has to reach this device too.
			if (typeof msg.selectedProvider === 'string' && providers.some(p => p.id === msg.selectedProvider)) {
				selectedProvider = msg.selectedProvider;
			} else if (!providers.some(p => p.id === selectedProvider)) {
				selectedProvider = (providers[0] && providers[0].id) || '';
			}
			// The pending pick is confirmed once this config actually carries it (or it no
			// longer matches the current provider) — see `pendingModel`'s own doc.
			if (pendingModel) {
				const current = providers.find(p => p.id === pendingModel.provider);
				if (pendingModel.provider !== selectedProvider || !current || current.model === pendingModel.model) {
					pendingModel = null;
				}
			}
			if (typeof msg.workspaceName === 'string') { workspaceName = msg.workspaceName.slice(0, 60); }
			renderProviderSelect();
			renderModelSelect();
			refreshStatus();
			break;
		}
		case 'sessions': {
			const prevById = new Map(sessions.map(s => [s.id, s]));
			// Which chat this device shows is its own choice (see `switchSession`): keep it while
			// it exists, open a chat this device just asked for, and only fall back to the host's
			// active chat on first load or when ours was closed elsewhere.
			const listed = new Set((msg.sessions || []).map(s => s.id));
			const created = openNextNewSession && prevById.size ? (msg.sessions || []).find(s => !prevById.has(s.id)) : undefined;
			let nextActive = activeSessionId;
			if (created) {
				openNextNewSession = false;
				nextActive = created.id;
			} else if (!nextActive || !listed.has(nextActive)) {
				nextActive = msg.activeSessionId;
			}
			const activeChanged = nextActive !== activeSessionId;
			sessions = (msg.sessions || []).map(s => {
				const prev = prevById.get(s.id) || {};
				let queue = Array.isArray(s.queue) ? s.queue : [];
				const pending = pendingQueues.get(s.id);
				if (pending) {
					if (sameQueue(pending, queue)) {
						// The host has caught up — this edit is confirmed, stop overriding it.
						pendingQueues.delete(s.id);
					} else {
						// Still ahead of (or diverged from) what the host just sent — keep the
						// local edit rather than let a stale snapshot revert it. `case 'welcome':`'s
						// reconnect flush gets it confirmed if the original send never landed.
						queue = pending;
					}
				}
				return {
					...s,
					queue,
					// The host never tracks streamed text (its `pending` is always null) — keeping
					// ours is what stops a metadata push mid-reply (someone changed a mode, a queue,
					// a tab) from blanking the reply being streamed on this device. Kept even once
					// the host says the run is over: `done` may still be on its way to commit it.
					pending: prev.pending ?? '',
					gap: !!prev.gap,
					from: prev.from ?? 0,
					messages: prev.messages || [],
				};
			});
			// Drop pending edits for sessions this snapshot no longer lists (closed elsewhere).
			const liveIds = new Set(sessions.map(s => s.id));
			for (const id of [...pendingQueues.keys()]) {
				if (!liveIds.has(id)) { pendingQueues.delete(id); }
			}
			activeSessionId = nextActive;
			renderTabs();
			if (activeChanged) {
				// A different conversation: its rows are the only thing worth a full rebuild.
				renderAll();
			} else {
				renderChrome();
				const s = activeSession();
				if (s && els.messages) { renderPending(els.messages, s); }
			}
			break;
		}
		case 'transcript': {
			const s = sessions.find(x => x.id === msg.sessionId);
			if (!s) { break; }
			const page = Array.isArray(msg.messages) ? msg.messages : [];
			const from = typeof msg.from === 'number' ? msg.from : 0;
			if (s.loadingEarlier && from < (s.from ?? 0) && from + page.length === s.from) {
				// The page directly before what's shown (`fetchTranscript`) — prepend it and keep
				// the reader's place instead of jumping them to the top or bottom.
				s.loadingEarlier = false;
				s.messages = page.concat(s.messages || []);
				s.from = from;
				if (s.id === activeSessionId && els.messages) {
					const offset = els.messages.scrollHeight - els.messages.scrollTop;
					renderAll(false);
					els.messages.scrollTop = els.messages.scrollHeight - offset;
				}
				break;
			}
			s.loadingEarlier = false;
			s.messages = page;
			s.from = from;
			// The authoritative transcript supersedes this device's live tool rows.
			for (const key of [...liveTools.keys()]) {
				if (key.startsWith(`${s.id}:`)) { liveTools.delete(key); }
			}
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'runStart': {
			const s = sessions.find(x => x.id === msg.sessionId);
			if (!s) { break; }
			s.runId = msg.runId;
			s.runMode = msg.mode;
			s.streaming = true;
			s.steerable = true;
			s.pending = '';
			s.gap = false;
			// Unconditional: a run can start in a tab that isn't on screen, and the tab strip's
			// running dot is the only thing that has to know.
			renderTabs();
			if (s.id === activeSessionId) {
				renderChrome();
				if (els.messages) { renderPending(els.messages, s); }
				scrollIfStuck(true);
			}
			break;
		}
		case 'userTurn': {
			// A turn typed on another client (the desktop panel, another phone) — this device's
			// own sends are echoed by `dispatchSend` and never come back here.
			const s = sessions.find(x => x.id === msg.sessionId);
			if (!s) { break; }
			pushEntry(s, { role: 'user', content: typeof msg.content === 'string' ? msg.content : '', imageCount: msg.imageCount || 0 });
			if (s.id === activeSessionId) { scrollIfStuck(true); }
			break;
		}
		case 'token': {
			const s = sessionFor(msg);
			if (!s || typeof msg.delta !== 'string') { break; }
			s.pending = (s.pending || '') + msg.delta;
			if (s.id === activeSessionId) { schedulePendingPaint(); }
			break;
		}
		case 'agentStepStart': {
			// A new agent step starts a new assistant turn, the same as on the desktop — without
			// this, every step's narration ran together into one paragraph.
			const s = sessionFor(msg);
			if (s) { commitPending(s); }
			break;
		}
		case 'agentStepEnd': {
			// The step's authoritative text (covers providers that don't stream, and anything a
			// coalesced batch was still holding).
			const s = sessionFor(msg);
			if (!s) { break; }
			if (typeof msg.content === 'string' && msg.content) { s.pending = msg.content; }
			commitPending(s);
			break;
		}
		case 'toolStart': {
			const s = sessionFor(msg);
			if (!s) { break; }
			commitPending(s);
			const entry = { role: 'tool', live: true, name: msg.name || 'tool', args: msg.args, status: 'running' };
			const row = pushEntry(s, entry);
			liveTools.set(`${s.id}:${msg.id || entry.name}`, { entry, row });
			break;
		}
		case 'toolEnd': {
			const s = sessionFor(msg);
			if (!s) { break; }
			const key = `${s.id}:${msg.id || msg.name}`;
			const live = liveTools.get(key);
			if (!live) { break; }
			liveTools.delete(key);
			live.entry.status = msg.isError ? 'error' : 'done';
			live.entry.result = typeof msg.result === 'string' ? msg.result : String(msg.result ?? '');
			if (live.row && s.id === activeSessionId) {
				updateToolRow(live.row, live.entry);
				if (els.messages) { renderPending(els.messages, s); }
				scrollIfStuck(false);
			}
			break;
		}
		case 'todos': {
			// The host sends `items` of `{ content, status }` (`SessionTodo`) — this read `todos`
			// before, which the message never carries, so the checklist never appeared here.
			const s = sessionFor(msg);
			if (!s) { break; }
			s.todos = Array.isArray(msg.items) ? msg.items : [];
			if (s.id === activeSessionId && els.todos) { renderTodos(els.todos, s.todos); }
			break;
		}
		case 'done': {
			const s = sessionFor(msg);
			if (!s) { break; }
			s.streaming = false;
			if (s.gap) {
				// Tokens were lost while this device (or VS Code) was off the relay, so the text
				// streamed here has a hole in it — fetch the reply as the host recorded it
				// rather than commit a spliced one.
				s.gap = false;
				s.pending = '';
				sendApp({ type: 'sync', sessionId: s.id });
			} else {
				commitPending(s);
			}
			// A run that ends between toolStart and toolEnd (Stop, an error) leaves its row
			// spinning forever otherwise.
			for (const [key, live] of [...liveTools]) {
				if (!key.startsWith(`${s.id}:`)) { continue; }
				live.entry.status = 'stopped';
				if (live.row) { updateToolRow(live.row, live.entry); }
				liveTools.delete(key);
			}
			// A queued follow-up starts as soon as the tab is idle again — mirrors media/main.js's
			// own drain, in the run's own `runMode`, not whatever the mode dropdown now shows.
			if (s.queue && s.queue.length) {
				const next = s.queue.shift();
				persistQueue(s);
				if (!dispatchSend(s, next, s.runMode, true)) {
					// Couldn't reach the host — put it back rather than lose it; it's retried the
					// next time this session goes idle or the queue is otherwise touched.
					s.queue.unshift(next);
					persistQueue(s);
					if (s.id === activeSessionId) { note(s, 'info', 'Not connected — your queued message will send once reconnected.'); }
				}
			}
			renderTabs();
			if (s.id === activeSessionId) {
				renderChrome();
				if (els.messages) { renderPending(els.messages, s); }
			}
			break;
		}
		case 'error': {
			const s = msg.sessionId ? sessions.find(x => x.id === msg.sessionId) : activeSession();
			note(s, 'error', String(msg.message || 'Something went wrong.'));
			break;
		}
		case 'checkpoint': {
			// The Undo button for a run that changed files; an empty list means it was undone.
			const s = msg.sessionId ? sessions.find(x => x.id === msg.sessionId) : activeSession();
			if (!s) { break; }
			const files = Array.isArray(msg.files) ? msg.files.map(String) : [];
			const runId = String(msg.checkpointRunId || '');
			if (files.length) {
				s.undo = { runId, files };
			} else if (s.undo && s.undo.runId === runId) {
				s.undo = undefined;
			}
			if (s === activeSession()) { renderUndoBar(s); }
			break;
		}
		case 'info': {
			// The host's field is `message` (media/main.js reads the same) — this read `text`,
			// so every slash-command reply and connection notice arrived here blank.
			const s = msg.sessionId ? sessions.find(x => x.id === msg.sessionId) : activeSession();
			note(s, 'info', String(msg.message ?? msg.text ?? ''));
			break;
		}
		case 'approvalRequest':
		case 'askRequest': {
			const s = msg.sessionId ? sessions.find(x => x.id === msg.sessionId) : activeSession();
			if (s) { commitPending(s); }
			// Rendered into the transcript only while its tab is on screen; `renderAll`'s
			// `cards.reattach` brings it back when that tab is switched to.
			cards.render(msg, !s || s.id === activeSessionId);
			scrollIfStuck(true);
			break;
		}
		case 'promptCancel':
			cards.cancel(msg.id, msg.reason);
			break;
		case 'commands':
			slashCommands = Array.isArray(msg.commands) ? msg.commands : [];
			break;
		case 'remote':
			// The host's own relay link — reaching us at all means it's up; nothing to show.
			break;
		case 'models': {
			fetchedModels[msg.provider] = Array.isArray(msg.models) ? msg.models : [];
			if (typeof msg.error === 'string' && msg.error) {
				modelErrors[msg.provider] = msg.error;
			} else {
				delete modelErrors[msg.provider];
			}
			if (msg.provider === selectedProvider) { renderModelSelect(); }
			break;
		}
		case 'skills':
			skillsCatalog = Array.isArray(msg.skills) ? msg.skills : [];
			renderSkills();
			break;
		case 'mcp':
			// MCP server/tool catalog — no server-management UI on the phone.
			break;
		case 'history':
			historyEntries = Array.isArray(msg.history) ? msg.history : [];
			// Pushed unprompted (every `ready`, and after every close/clear/restore) — keep an
			// open panel showing the current list.
			if (historyPanelOpen()) { renderHistoryList(); }
			break;
		case 'steerable': {
			const s = sessionFor(msg);
			if (s) {
				s.steerable = !!msg.steerable;
				if (s.id === activeSessionId) { renderChrome(); }
			}
			break;
		}
		case 'steerRejected': {
			const s = sessionFor(msg);
			if (!s || typeof msg.text !== 'string') { break; }
			// The host had no agent loop to deliver this into — take back the optimistic bubble
			// `sendMessage`'s steer branch showed (mirrors media/main.js's `undoSteer`).
			if (Array.isArray(s.messages)) {
				for (let i = s.messages.length - 1; i >= 0; i--) {
					if (s.messages[i].role === 'user' && s.messages[i].content === msg.text) {
						s.messages.splice(i, 1);
						break;
					}
				}
			}
			if (s.streaming) {
				// The run is still going (just not steerable) — queue it instead of losing it.
				(s.queue = s.queue || []).push(msg.text);
				persistQueue(s);
			} else if (!dispatchSend(s, msg.text, s.runMode)) {
				(s.queue = s.queue || []).push(msg.text);
				persistQueue(s);
				if (s.id === activeSessionId) { note(s, 'info', 'Not connected — your message was queued and will send once reconnected.'); }
			}
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'autoPhase': {
			const s = sessionFor(msg);
			if (!s) { break; }
			commitPending(s);
			note(s, 'info', `${msg.label || 'Phase'} · ${msg.model || msg.provider || ''}`.replace(/ · $/, ''));
			break;
		}
		case 'autoSummary': {
			const s = sessionFor(msg);
			if (s) { pushEntry(s, { role: 'assistant', kind: 'auto', content: '', phases: msg.phases }); }
			break;
		}
		case 'compacted': {
			const s = sessionFor(msg);
			note(s, 'info', 'Earlier turns were summarized to fit the model’s context.');
			break;
		}
		case 'enhancedPrompt':
			if (els.composer) {
				els.composer.value = msg.text || els.composer.value;
				autosizeComposer();
			}
			break;
		case 'enhanceError':
			note(activeSession(), 'error', `Couldn’t enhance the prompt: ${msg.message || 'unknown error'}`);
			break;
		case 'context':
			// The reply to `attachActive` (`attachContext` itself is REMOTE_DENIED). Shown as a
			// removable chip and sent with the next `send`, like media/main.js's `currentContext`.
			attachedContext = (msg.context && typeof msg.context.label === 'string') ? msg.context : null;
			renderContextChip();
			break;
		case 'attachOk': {
			const sessionId = uploadSessions.get(msg.uploadId) || activeSessionId;
			uploadSessions.delete(msg.uploadId);
			pendingImages.set(sessionId, pendingImageCount(sessionId) + 1);
			renderContextChip();
			break;
		}
		default:
			// Anything else (selectProvider/newChat/inline/editProposal) is desktop-editor-only
			// traffic — see scripts/test-pwa-contract.mjs's documented exclusion list.
			break;
	}
}

// ---- Control-frame dispatch ---------------------------------------------------------------------

/**
 * What the app asks the host for once the link is secure: the same catch-up the plain `welcome`
 * used to trigger. Runs when both the relay's `welcome` and the keys exist.
 */
function bootstrapApp() {
	sendApp({ type: 'ready' });
	resyncOwnSession();
	sendApp({ type: 'listSkills' });
	sendApp({ type: 'listMcp' });
	// Replays any queue edit this device made that never reached the host before the
	// socket dropped (see `pendingQueues`'s own doc) — otherwise a chip removed or added
	// while offline silently reverts once the fresh `ready` catch-up's `sessions`
	// snapshot arrives, since that snapshot only ever reflects what the host actually saw.
	for (const [sessionId, queue] of pendingQueues) {
		sendApp({ type: 'setQueue', sessionId, queue });
	}
}

function handleControlFrame(frame) {
	switch (frame.c) {
		case 'welcome':
			hostOnline = typeof frame.hostOnline === 'boolean' ? frame.hostOnline : null;
			welcomeSeen = true;
			// The desktop is there (again): start a fresh stream so it accepts what follows.
			if (hostOnline) { startSendStream(); }
			refreshStatus();
			markStreamGaps();
			if (e2eKeys) { bootstrapApp(); }
			break;
		case 'hostStatus': {
			const wasOffline = hostOnline === false;
			hostOnline = !!frame.online;
			if (hostOnline) { startSendStream(); }
			refreshStatus();
			// VS Code (re)joined after this device did: the `ready` sent at `welcome` went to
			// nobody, so ask again — otherwise the app stays empty until the next reconnect.
			if (hostOnline && wasOffline && e2eKeys) {
				markStreamGaps();
				sendApp({ type: 'ready' });
				resyncOwnSession();
				sendApp({ type: 'listSkills' });
			}
			break;
		}
		case 'snapshotNeeded':
			sendApp({ type: 'sync', ...(activeSessionId ? { sessionId: activeSessionId } : {}) });
			break;
		case 'pong':
			handlePong();
			break;
		case 'revoke':
			handleRevoked();
			break;
		case 'bye':
			if (ws) { ws.close(); }
			break;
		default:
			break;
	}
}

// ---- Connection lifecycle -------------------------------------------------------------------

/**
 * Terminal state for a revoked device: drops the dead token (retrying `connect()` with it would
 * just hit `/ws/client`'s 403 forever — see `room.ts`'s revocation check) and sends the user back
 * to the pairing screen instead of leaving `status` stuck on "Reconnecting…" forever, which read
 * as "still trying to get back in" rather than the plain, permanent "no" it actually is. Reached
 * two ways: a live socket closed with `DEVICE_REVOKED_CLOSE_CODE` (the `close` handler below), or
 * — if a later relay change starts sending it — an explicit `{c: 'revoke'}` app frame.
 */
function handleRevoked() {
	void resetPairing('This device was revoked. Scan a new QR code or paste a fresh pairing link to reconnect.');
}

/**
 * Handles the desktop's plaintext handshake frame `{ e: 0, d, hk, hm }` for a pending pairing:
 * verifies it with the pairing secret, derives the keys and stores them. Anything else is
 * ignored; a frame that fails verification abandons the pairing (the relay may be interfering).
 * @param {any} p
 */
async function handleHandshake(p) {
	const hs = pendingHs;
	if (e2eKeys || !hs || p.d !== hs.deviceId || typeof p.hk !== 'string' || typeof p.hm !== 'string') { return; }
	let derived;
	try {
		derived = await completeHandshake({ ps: hs.ps, privateKey: hs.privateKey, phonePub: hs.phonePub, deviceId: hs.deviceId, hk: p.hk, hm: p.hm });
	} catch {
		if (pendingHs === hs) { await resetPairing('The desktop’s reply did not match. Pair again from the desktop.'); }
		return;
	}
	if (pendingHs !== hs || e2eKeys) { return; }
	const room = roomId;
	e2eKeys = { deviceId: hs.deviceId, c2h: derived.c2h, h2c: derived.h2c };
	pendingHs = null;
	hs.ps.fill(0);
	clearHandshakeTimer();
	recvGuard = new ReplayGuard();
	startSendStream();
	refreshStatus();
	if (welcomeSeen) { bootstrapApp(); }
	await e2ePut('keys', room, e2eKeys);
	await e2eDel('pending', room);
}

/**
 * Handles one `t: 'm'` payload from the relay: only sealed frames for this device that
 * authenticate and are newer than the last one accepted reach the app; everything else is dropped
 * silently.
 * @param {any} p
 */
async function handleInbound(p) {
	if (!p || typeof p !== 'object') { return; }
	if (p.e === 0) { await handleHandshake(p); return; }
	const keys = e2eKeys;
	if (p.e !== 1 || !keys || p.d !== keys.deviceId) { return; }
	let opened;
	try {
		opened = await openFrame(keys.h2c, { deviceId: keys.deviceId, dir: 'h2c' }, p);
	} catch {
		return;
	}
	if (e2eKeys !== keys || !recvGuard.accept(opened.s, opened.n)) { return; }
	recvSincePersist++;
	if (opened.s !== lastRecvStream || recvSincePersist >= RECV_PERSIST_EVERY) { persistRecvState(); }
	if (!opened.message || typeof opened.message !== 'object') { return; }
	try {
		handleAppMessage(opened.message);
	} catch (err) {
		console.error('message handler failed:', err instanceof Error ? err.message : 'error');
	}
}

/** Stops the heartbeat interval and any armed missed-pong timeout. Mirrors socket.ts's `stopHeartbeat`. */
function stopHeartbeat() {
	if (heartbeatTimer) { window.clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); pongTimeoutTimer = undefined; }
	awaitingPong = false;
}

/** Sends one heartbeat ping and arms the missed-pong timeout. Mirrors socket.ts's `sendPing`. */
function sendPing() {
	awaitingPong = true;
	// Exactly the relay's `HEARTBEAT_PING_JSON` (seq 0, this key order): it answers pings by
	// exact-string match, so a ping stamped with a running seq was never answered and the
	// missed-pong check below dropped and re-dialled the socket about once a minute.
	if (ws && ws.readyState === WebSocket.OPEN) { ws.send(HEARTBEAT_PING_JSON); }
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); }
	pongTimeoutTimer = window.setTimeout(handleMissedPong, HEARTBEAT_TIMEOUT_MS);
}

/** A `pong` arrived for the outstanding ping — connection's alive. Mirrors socket.ts's `handlePong`. */
function handlePong() {
	if (!awaitingPong) { return; }
	awaitingPong = false;
	missedPongs = 0;
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); pongTimeoutTimer = undefined; }
}

/**
 * A ping went unanswered past `HEARTBEAT_TIMEOUT_MS`. One miss is tolerated (a slow relay
 * round trip, not necessarily a dead link) — mirrors socket.ts's own "2 missed pongs"
 * threshold. On the second, `readyState` may still report OPEN while nothing is actually
 * getting through (the zombie-socket case the `visibilitychange` resync above can't fix on
 * its own, since a `sync` sent into a truly dead socket goes nowhere either) — force-closing
 * hands off to the `close` handler's existing reconnect/backoff, the only path that reliably
 * re-syncs session state afterward.
 */
function handleMissedPong() {
	if (!awaitingPong) { return; }
	missedPongs++;
	awaitingPong = false;
	if (missedPongs >= 2 && ws) {
		ws.close(4000, 'heartbeat timeout');
	}
}

function connect() {
	if (!deviceToken) { return; }
	const base = new URL(relayBase());
	const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
	const url = `${scheme}//${base.host}/ws/client?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(deviceToken)}`;
	setStatus('Connecting…', 'status-warn');
	const sock = new WebSocket(url);
	ws = sock;
	ws.addEventListener('open', () => {
		welcomeSeen = false;
		// A new link, a new stream: the desktop only accepts frames newer than the last it saw.
		startSendStream();
		reconnectDelayMs = RECONNECT_MIN_MS;
		consecutiveReconnectFailures = 0;
		// "Connected" waits for `welcome` (see `refreshStatus`), which also says whether VS Code is there.
		setStatus('Connecting…', 'status-warn');
		missedPongs = 0;
		heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
		// Bootstrap gate: `handleControlFrame`'s `case 'welcome':` is what actually sends
		// `ready`/`listSkills`/`listMcp` — nothing else here does. The relay only answers a
		// `hello` with `welcome` (room.ts), so without this the socket sits "Connected" with an
		// empty app: no sessions, no providers, a composer with nothing to send to.
		sendControl({ c: 'hello', role: 'client' });
	});
	ws.addEventListener('message', event => {
		let envelope;
		try {
			envelope = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!envelope || envelope.v !== 1 || typeof envelope.seq !== 'number') { return; }
		if (envelope.t === 'm') {
			const payload = envelope.p;
			recvChain = recvChain.then(() => handleInbound(payload)).catch(() => { /* dropped */ });
		} else if (envelope.t === 'c') {
			handleControlFrame(envelope.p);
		}
	});
	ws.addEventListener('close', event => {
		// A socket that was replaced or abandoned (revoke, unpair) must not schedule a reconnect.
		if (ws !== sock) { return; }
		// A revoked device must stay locked out, not retry forever with the same dead token —
		// see `handleRevoked`'s own doc. `room.ts`'s `revokeDevice` closes a *live* socket with
		// this exact code; `/ws/client` rejecting a stale token on a fresh connect attempt (the
		// app was closed when it got revoked) can't be told apart from an ordinary network drop
		// this way — the browser's WebSocket API doesn't expose the 403 an upgrade never
		// completed for — so that case still retries and relies on the server continuing to
		// reject it, same as before this fix.
		if (event.code === DEVICE_REVOKED_CLOSE_CODE) {
			handleRevoked();
			return;
		}
		consecutiveReconnectFailures++;
		// Still retries either way (a real outage does eventually clear on its own) — this only
		// changes what the status line says while it keeps trying, since silently spinning
		// "Reconnecting…" forever for a revoked-while-disconnected device (see
		// REVOKE_HINT_AFTER_FAILURES's doc) reads as "still working on it" rather than the
		// permanent "no" it likely is.
		setStatus(
			consecutiveReconnectFailures >= REVOKE_HINT_AFTER_FAILURES
				? 'Still trying to reconnect — if this device was revoked, re-pair with a fresh code instead of waiting.'
				: 'Reconnecting…',
			'status-warn',
		);
		stopHeartbeat();
		const delay = reconnectDelayMs;
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
		window.setTimeout(connect, delay + Math.random() * delay * 0.5);
	});
	ws.addEventListener('error', () => {
		if (ws) { ws.close(); }
	});
}

// ---- Boot -------------------------------------------------------------------------------------

/** Reads `/p/<roomId>#<key>` — the shape the pairing QR encodes (the key is the 26-character pairing secret). */
function parseLocation() {
	const match = /^\/p\/([^/]+)/.exec(location.pathname);
	const fromUrl = match ? decodeURIComponent(match[1]) : new URLSearchParams(location.search).get('room') || '';
	let secret = '';
	try { secret = location.hash ? decodeURIComponent(location.hash.slice(1)) : ''; } catch { secret = location.hash.slice(1); }
	return {
		// A launch with no room of its own (see `loadLastRoom`'s doc — chiefly the installed
		// icon's fixed `start_url`) falls back to whichever room this browser paired to last,
		// so it can still find that pairing's saved device token in `boot()` below.
		room: fromUrl || loadLastRoom(),
		secret,
	};
}

/** Shows the app, starts the service worker and dials the relay. */
function startApp() {
	if (els.pairScreen) { els.pairScreen.hidden = true; }
	if (els.app) { els.app.hidden = false; }
	setStatus(e2eKeys ? 'Connecting…' : SECURING_TEXT, 'status-warn');
	registerServiceWorker();
	connect();
}

/**
 * Pairs with a secret: claims, then waits (at most {@link HANDSHAKE_TIMEOUT_MS}) for the desktop's
 * handshake. Shows errors on the pairing screen.
 * @param {string} room
 * @param {Uint8Array} ps
 * @returns {Promise<boolean>} whether the claim was accepted
 */
async function pairWith(room, ps) {
	if (els.pairError) { els.pairError.textContent = ''; }
	try {
		deviceToken = await claim(room, ps);
	} catch (err) {
		if (els.pairError) { els.pairError.textContent = err instanceof Error ? err.message : String(err); }
		return false;
	}
	if (!native) { try { history.replaceState(null, '', `/p/${encodeURIComponent(room)}`); } catch { /* cosmetic */ } }
	armHandshakeTimer();
	startApp();
	return true;
}

async function boot() {
	const { room, secret } = parseLocation();
	roomId = room;
	await loadE2e(roomId);
	const stored = roomId ? loadDevice(roomId) : undefined;
	let ps;
	let linkError = '';
	if (secret) {
		try {
			ps = b32decode(secret);
			if (ps.length !== 16) { throw new Error('length'); }
		} catch {
			ps = undefined;
			linkError = 'This pairing link is not valid. Paste the full link, or type the key shown under the QR code.';
		}
	}
	if (native && stored && typeof stored.origin === 'string') { nativeOrigin = stored.origin; }
	const usable = !!(stored && stored.token && (e2eKeys || (pendingHs && pendingHs.deviceId === stored.deviceId)));
	// A fresh link scanned over an unfinished pairing starts over; over a finished one it is ignored.
	if (usable && (!ps || e2eKeys)) {
		deviceToken = stored.token;
		// A returning session's service worker may not have current auth (e.g. a token refresh
		// since the last visit, or a service-worker eviction that dropped its own IndexedDB
		// cache) — re-post every boot, not just the first pairing. Not awaited — see `claim()`:
		// `navigator.serviceWorker.ready` can hang indefinitely.
		void syncAuthToServiceWorker(roomId, deviceToken);
		if (secret && !native) { try { history.replaceState(null, '', `/p/${encodeURIComponent(roomId)}`); } catch { /* cosmetic */ } }
		if (!e2eKeys) { armHandshakeTimer(); }
		startApp();
		return;
	}
	if (stored && stored.token && !ps) {
		// Paired before end-to-end encryption (a token but no keys): it cannot work any more.
		await resetPairing('This phone was paired before end-to-end encryption. Pair it again from the desktop.');
		return;
	}
	if (roomId && ps) {
		if (stored && stored.token) { await resetPairing(''); }
		await pairWith(roomId, ps);
		if (!deviceToken) {
			if (els.pairScreen) { els.pairScreen.hidden = false; }
			if (els.app) { els.app.hidden = true; }
		}
		return;
	}
	if (els.pairScreen) { els.pairScreen.hidden = false; }
	if (els.app) { els.app.hidden = true; }
	if (linkError && els.pairError) { els.pairError.textContent = linkError; }
}

// A backgrounded phone (screen lock, app-switch) can silently zombie the WebSocket: mobile
// browsers throttle/suspend JS timers while hidden, so the heartbeat pings that would
// normally surface a dead connection stop firing too, and the socket's own `close` event —
// the only thing that currently triggers a resync (see `connect()`'s `case 'welcome':`
// catch-up) — may never fire even once the OS has long since torn down the underlying
// connection. A `done`/`error` frame that arrived during that blackout is lost for good: no
// offline queue (see `RemoteSink`'s own doc), and `readyState` keeps reporting OPEN. The
// session it belonged to is then stuck showing streaming forever — Stop button stuck, every
// further send routed into `steer` against a run that already ended and gets silently
// rejected — until the tab is reloaded or a new chat is opened. Re-requesting `sync` the
// moment the tab is foregrounded again is a cheap, harmless no-op when nothing was missed,
// and self-heals exactly this desync when something was: `case 'sync':`
// (chatViewProvider.ts) answers with the store's authoritative per-session `streaming`.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') { persistRecvState(); }
	if (document.visibilityState === 'visible' && ws && ws.readyState === WebSocket.OPEN) {
		sendApp({ type: 'sync', ...(activeSessionId ? { sessionId: activeSessionId } : {}) });
	}
});

window.addEventListener('pagehide', persistRecvState);

buildModeSeg();
withSelectButton(els.modeSelect);
withSelectButton(els.providerSelect);
withSelectButton(els.modelSelect);
if (els.sendBtn) { els.sendBtn.addEventListener('click', sendMessage); }
if (els.stopBtn) { els.stopBtn.addEventListener('click', stopRun); }
if (els.newSessionBtn) { els.newSessionBtn.addEventListener('click', createSession); }
if (els.historyBtn) { els.historyBtn.addEventListener('click', openHistoryPanel); }
if (els.historyCloseBtn) { els.historyCloseBtn.addEventListener('click', closeHistoryPanel); }
if (els.composer) {
	els.composer.addEventListener('input', () => { updateSlashMenu(); autosizeComposer(); });
	// Enter sends only where there's a real keyboard and pointer (a tablet with a keyboard, a
	// desktop browser); on a touch keyboard Enter stays a newline, as in every mobile chat app.
	// Shift+Enter is a newline everywhere.
	els.composer.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
			e.preventDefault();
			sendMessage();
		}
	});
}
if (els.enhanceBtn) { els.enhanceBtn.addEventListener('click', enhancePrompt); }
if (els.modeSelect) { els.modeSelect.addEventListener('change', () => { setMode(els.modeSelect.value); syncModeSeg(); }); }
if (els.providerSelect) { els.providerSelect.addEventListener('change', () => setProvider(els.providerSelect.value)); }
if (els.modelSelect) { els.modelSelect.addEventListener('change', () => setModel(els.modelSelect.value)); }
if (els.attachImageBtn && els.attachImageInput) {
	els.attachImageBtn.addEventListener('click', () => els.attachImageInput.click());
	els.attachImageInput.addEventListener('change', () => {
		const file = els.attachImageInput.files && els.attachImageInput.files[0];
		els.attachImageInput.value = '';
		if (file) { void uploadImage(file); }
	});
}
if (els.attachActiveBtn) { els.attachActiveBtn.addEventListener('click', () => sendApp({ type: 'attachActive' })); }
/**
 * Pairs from what was pasted, typed, scanned or handed over by the native shell (a deep link).
 * @param {string} input a pairing link or key
 * @returns {Promise<boolean>} whether the claim was accepted
 */
async function pairFromInput(input) {
	let parsed;
	try {
		parsed = parsePairingInput(input);
	} catch (err) {
		if (els.pairError) { els.pairError.textContent = err instanceof Error ? err.message : String(err); }
		return false;
	}
	if (parsed.room) { roomId = parsed.room; }
	if (parsed.origin) { nativeOrigin = parsed.origin; }
	if (!roomId || (native && !nativeOrigin)) {
		if (els.pairError) {
			els.pairError.textContent = native
				? 'Paste the whole pairing link from the desktop (or scan its QR code) so the app knows which desktop to pair with.'
				: 'Open the pairing link from the desktop (or scan its QR code) so this page knows which desktop to pair with.';
		}
		return false;
	}
	return pairWith(roomId, parsed.ps);
}

if (els.pairForm) {
	els.pairForm.addEventListener('submit', async event => {
		event.preventDefault();
		if (!els.pairCode) { return; }
		if (await pairFromInput(els.pairCode.value)) { els.pairCode.value = ''; }
	});
}
if (native) {
	// "Add to Home Screen" advice is for browsers; this is already an installed app.
	const note = document.querySelector('.pair-note');
	if (note) { note.hidden = true; }
	// Scanning is the main way in here and pasting a link the fallback (see `.pair-native` in styles.css).
	if (els.pairScreenRoot) { els.pairScreenRoot.classList.add('pair-native'); }
	if (els.pairCode) { els.pairCode.placeholder = 'Or paste the pairing link'; }
	const intro = document.getElementById('pairIntro');
	if (intro) { intro.textContent = 'Scan the QR code shown on your computer to pair this phone.'; }
	// The Android Back button: close what is open first, and only leave the app from a plain screen.
	window.addEventListener('stormcoder:back', event => {
		let handled = false;
		if (historyPanelOpen()) { closeHistoryPanel(); handled = true; }
		else if (els.slashMenu && !els.slashMenu.hidden) { els.slashMenu.hidden = true; handled = true; }
		const detail = /** @type {CustomEvent} */ (event).detail;
		if (detail && typeof detail === 'object') { detail.handled = handled; }
	});
	if (typeof native.scanQr === 'function' && els.scanBtn) {
		const scanBtn = els.scanBtn;
		scanBtn.hidden = false;
		scanBtn.addEventListener('click', async () => {
			try {
				const text = await native.scanQr();
				if (typeof text === 'string' && text) { await pairFromInput(text); }
			} catch (err) {
				if (els.pairError) { els.pairError.textContent = err instanceof Error ? err.message : 'Could not scan.'; }
			}
		});
	}
}
if (els.unpairBtn) {
	els.unpairBtn.addEventListener('click', () => {
		void resetPairing('This phone is unpaired. Scan a new QR code or paste a fresh pairing link to pair again.');
	});
}

// clearSession has no UI trigger yet (kept minimal per this phase's scope); closeSession is
// now wired from each tab's own close button in renderTabs() above.
void clearSession;

boot();
