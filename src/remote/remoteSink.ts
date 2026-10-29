/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HostE2E } from './e2e';
import { MessageSink } from '../session/bus';
import { CoalescedMessage, TokenCoalescer } from './coalescer';
import { Envelope } from './protocol';
import { shouldPush } from './push';
import { RemoteSocket } from './socket';

/**
 * Phase 5 of "remote control": the {@link MessageSink} a remote (relay-connected) client is
 * registered on the bus as. Every outbound message is redacted (see {@link redactForRemote}),
 * then fed through a per-sink {@link TokenCoalescer} before being wrapped in a `t: 'm'`
 * envelope and sent down the wire — `token` deltas get batched, everything else flushes the
 * batch first and goes out immediately (the coalescer's own ordering barrier).
 *
 * Incoming traffic is deliberately not this class's job: `RemoteSocket.onMessage` is wired up
 * by `remoteService.ts`, which is what checks `isRemoteAllowed` and dispatches into the host —
 * this class only owns the outbound half.
 */

/** Bytes beyond which a redacted field is truncated with a marker. */
const REMOTE_TRUNCATE_BYTES = 8 * 1024;
const TRUNCATION_SUFFIX = '\n… [truncated for remote]';

/** What a remote device sees in place of an editor action's prompt — see `TranscriptEntry.fromEditor`. */
const EDITOR_TURN_PLACEHOLDER = 'Editor action on the desktop (the selected code stays on the desktop).';

/** Push notification bodies stay short — see `composePush`'s `error` case. */
const PUSH_BODY_TRUNCATE_CHARS = 120;

/** Message types {@link RemoteSink.post} ever considers pushing for — matches the event types `push.ts`'s `shouldPush` treats as potentially eligible. */
type PushableEventType = 'approvalRequest' | 'askRequest' | 'error' | 'done';

function isPushableEventType(type: string): type is PushableEventType {
	return type === 'approvalRequest' || type === 'askRequest' || type === 'error' || type === 'done';
}

/**
 * Shapes of credentials that must not cross the relay inside tool output, command lines or
 * error text. Deliberately a short list of well-known token formats plus `key=value` pairs
 * whose key names a secret; it cannot recognise an arbitrary secret, so it complements (never
 * replaces) the trust model's rule that a remote device is a trusted one.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
	[/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted key]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
	[/\b((?:api[_-]?key|secret|token|passw(?:or)?d|authorization|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, '$1[redacted]'],
	// Environment-style names that merely contain one of those words: AWS_SECRET_ACCESS_KEY=…, DB_PASSWORD=…
	[/\b([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*["']?)[^\s"',;&]{4,}/g, '$1[redacted]'],
	// Credentials inside a URL: postgres://user:password@host
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:)[^@\s\/]+@/gi, '$1[redacted]@'],
	// A password given on the command line to the database clients that take it as -pPASSWORD.
	[/(\b(?:mysql|mysqldump|mariadb)\b[^\n;&|]*?\s-p)\S+/g, '$1[redacted]'],
];

/** Masks the credential shapes in {@link SECRET_PATTERNS} inside `text`. */
export function scrubSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** The deepest nesting {@link scrubValue} walks; past it a value is replaced rather than copied. */
const SCRUB_MAX_DEPTH = 8;

/** The most one string may carry to a remote device, whatever the message (a stray multi-megabyte delta must not reach a phone). */
const REMOTE_MAX_STRING_BYTES = 256 * 1024;

/**
 * Masks credential shapes in every string of `value`, at any depth, without shortening the
 * text (beyond a very large ceiling). The per-field scrubbing above covers the fields known to
 * carry tool output; this is the net under everything else, so a message type nobody thought
 * of (an MCP status line, a transcript replayed after a reconnect, a todo) is covered too.
 */
function scrubDeep(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		const scrubbed = scrubSecrets(value);
		return Buffer.byteLength(scrubbed, 'utf8') > REMOTE_MAX_STRING_BYTES ? truncateUtf8(scrubbed, REMOTE_MAX_STRING_BYTES) + TRUNCATION_SUFFIX : scrubbed;
	}
	if (typeof value !== 'object' || value === null || depth >= 16) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => scrubDeep(entry, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		out[key] = scrubDeep(entry, depth + 1);
	}
	return out;
}

/** How much of each end of an over-long approval is shown; the middle is what gets hidden. */
const APPROVAL_HEAD_BYTES = 5 * 1024;
const APPROVAL_TAIL_BYTES = 2 * 1024;

/**
 * Shortens an approval's text without hiding its end. A command or file that is longer than a
 * phone should render used to be cut after the first 8KB, which let a long run of padding push
 * the part that matters out of view while the card still offered "Allow". Both ends are kept,
 * the hidden size is stated, and the caller marks the card so it can say to decide on the desktop.
 */
function headAndTail(text: string): { text: string; hidden: number } {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length <= REMOTE_TRUNCATE_BYTES) {
		return { text, hidden: 0 };
	}
	const hidden = bytes.length - APPROVAL_HEAD_BYTES - APPROVAL_TAIL_BYTES;
	return {
		text: `${bytes.subarray(0, APPROVAL_HEAD_BYTES).toString('utf8')}\n… [${hidden} bytes hidden: too long to review on a phone, check it on the desktop] …\n${bytes.subarray(bytes.length - APPROVAL_TAIL_BYTES).toString('utf8')}`,
		hidden,
	};
}

/** Scrubs and truncates every string inside `value`, recursively through arrays and plain objects. */
function scrubValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		const scrubbed = scrubSecrets(value);
		return truncateUtf8(scrubbed, REMOTE_TRUNCATE_BYTES) + (Buffer.byteLength(scrubbed, 'utf8') > REMOTE_TRUNCATE_BYTES ? TRUNCATION_SUFFIX : '');
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}
	if (depth >= SCRUB_MAX_DEPTH) {
		return '[nested too deep]';
	}
	if (Array.isArray(value)) {
		return value.map(entry => scrubValue(entry, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		out[key] = scrubValue(entry, depth + 1);
	}
	return out;
}

/** Truncates `text` to at most `maxChars` characters, marking the cut with an ellipsis. Chars, not bytes — push notification bodies are short by nature, so the byte-precision `truncateUtf8` below uses for large tool output would be overkill here. */
function truncateForPush(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Builds `{title, body, tag}` for a `push` control frame. The text is generic on purpose: a push
 * passes through the relay and the browser vendor's push service, neither of which is inside the
 * end-to-end encryption (`docs/REMOTE-E2E.md`), so it says that something needs attention, never
 * what (no command, path, question or error text). `tag` is the prompt's `id` for
 * `approvalRequest`/`askRequest` (so a later notification can replace it) and the message
 * `type` otherwise.
 *
 * Written as `if`/`else` rather than a `switch` on purpose — same reason as `push.ts`'s
 * `shouldPush`: a `switch` here would put these event names into
 * `scripts/test-remote-policy.mjs`'s `case '<word>':` scan by accident.
 */
function composePush(message: Record<string, unknown> & { type: string }, eventType: PushableEventType): { title: string; body: string; tag: string } {
	const tag = typeof message.id === 'string' ? message.id : message.type;
	if (eventType === 'approvalRequest') {
		return { title: 'Approval needed', body: 'Open Stormcoder to review a request.', tag };
	}
	if (eventType === 'askRequest') {
		return { title: 'Question', body: 'The agent has a question for you.', tag };
	}
	if (eventType === 'error') {
		return { title: 'Error', body: 'A run stopped with an error.', tag: message.type };
	}
	// eventType === 'done', the only remaining member of PushableEventType.
	return { title: 'Run finished', body: 'A long-running task finished.', tag: message.type };
}

/** Truncates `text` to at most `maxBytes` UTF-8 bytes, without splitting the fields it's applied to any more carefully than a byte boundary — good enough for a first pass. */
function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
		return text;
	}
	return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
}

/** `url`'s host only, or a fixed placeholder if it doesn't parse — never the original string, since a `custom` base URL can carry a token in its path or query. */
function hostnameOnly(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '[redacted]';
	}
}

/** Redacts `baseUrl`/`authUrl`/`baseUrlOverride` to hostname-only and drops the account list inside a `config` message's per-provider list. */
function redactProviders(providers: unknown): unknown {
	if (!Array.isArray(providers)) {
		return providers;
	}
	return providers.map(entry => {
		if (typeof entry !== 'object' || entry === null) {
			return entry;
		}
		const redacted: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
		if (typeof redacted.baseUrl === 'string') {
			redacted.baseUrl = hostnameOnly(redacted.baseUrl);
		}
		if (typeof redacted.authUrl === 'string') {
			redacted.authUrl = hostnameOnly(redacted.authUrl);
		}
		// The address as typed into Settings (a self-hosted server's full URL, possibly with a path or
		// credentials) is desktop-only, like `baseUrl`.
		if (typeof redacted.baseUrlOverride === 'string') {
			redacted.baseUrlOverride = hostnameOnly(redacted.baseUrlOverride);
		}
		// Who is signed in (e-mail addresses, GitHub logins, cooldown times) is account administration,
		// which stays on the desktop; a phone only needs to know a provider has credentials.
		delete redacted.accounts;
		return redacted;
	});
}

/**
 * First-pass redaction for a message about to leave over the wire to a remote client, per the
 * "remote control" plan's "Security boundary" section: large `content`/`preview` fields (tool
 * results, `read_file` output) truncate to 8KB with a marker, and `baseUrl`/`authUrl` — on the
 * message itself, or nested per-provider inside a `config` message — reduce to hostname-only.
 * This is deliberately small: full redaction (every field, every message type) is more than
 * this task needs and is left for a later hardening pass — see the plan's Phase 7 staging.
 */
export function redactForRemote(message: Record<string, unknown> & { type: string }): Record<string, unknown> & { type: string } {
	const clone: Record<string, unknown> = { ...message };
	// An approval is shown with both ends of anything long (see headAndTail), before the
	// general truncation below could cut the end off.
	let hiddenInApproval = 0;
	if (message.type === 'approvalRequest') {
		for (const field of ['title', 'detail', 'preview'] as const) {
			const value = clone[field];
			if (typeof value === 'string') {
				const shown = headAndTail(scrubSecrets(value));
				clone[field] = shown.text;
				hiddenInApproval += shown.hidden;
			}
		}
		if (hiddenInApproval) {
			clone.reviewOnDesktop = true;
			clone.hiddenBytes = hiddenInApproval;
		}
	}
	for (const field of ['content', 'preview'] as const) {
		if (message.type === 'approvalRequest') {
			break;
		}
		const value = clone[field];
		if (typeof value === 'string') {
			clone[field] = truncateUtf8(value, REMOTE_TRUNCATE_BYTES) + (Buffer.byteLength(value, 'utf8') > REMOTE_TRUNCATE_BYTES ? TRUNCATION_SUFFIX : '');
		}
	}
	// Tool traffic and prompts carry whatever the tool read or the model quoted: scrub known
	// credential shapes and bound every string, however deeply nested in the arguments/result.
	if (message.type === 'toolStart' && 'args' in clone) {
		clone.args = scrubValue(clone.args);
	}
	if (message.type === 'toolEnd' && 'result' in clone) {
		clone.result = scrubValue(clone.result);
	}
	for (const field of ['title', 'detail', 'question', 'preview', 'content'] as const) {
		if (message.type === 'approvalRequest' && (field === 'title' || field === 'detail' || field === 'preview')) {
			continue;
		}
		if (typeof clone[field] === 'string' && (field !== 'content' || message.type === 'toolEnd')) {
			clone[field] = scrubValue(clone[field]);
		}
	}
	if (Array.isArray(clone.options)) {
		clone.options = scrubValue(clone.options);
	}
	if (message.type === 'error' && typeof clone.message === 'string') {
		clone.message = scrubValue(clone.message);
	}
	// A `userTurn` carries the turn's attached images as base64 — hundreds of KB each, which a
	// phone that only needs to show "1 image" would otherwise download over cellular on every
	// message. The count is all a remote transcript renders.
	if (Array.isArray(clone.images)) {
		clone.imageCount = clone.images.length;
		delete clone.images;
	}
	// An editor action's prompt embeds the desktop's selected code (the `inline` message that
	// carries it is already local-only); a phone sees that the action happened, not the code.
	if (message.type === 'userTurn' && clone.fromEditor === true) {
		clone.content = EDITOR_TURN_PLACEHOLDER;
	}
	// Same for a transcript's entries: `SessionStore.windowedMessages` budgets a window by the
	// bytes of `content` alone, so a catch-up whose tail held a few screenshots shipped
	// megabytes past the 48KB it was sized to — the slow first paint after every reconnect.
	if (message.type === 'transcript' && Array.isArray(clone.messages)) {
		clone.messages = clone.messages.map(entry => {
			if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as { images?: unknown }).images)) {
				return entry;
			}
			const { images, ...rest } = entry as { images: unknown[] };
			return { ...rest, imageCount: images.length };
		}).map(entry => (typeof entry === 'object' && entry !== null && (entry as { fromEditor?: unknown }).fromEditor === true)
			? { ...(entry as object), content: EDITOR_TURN_PLACEHOLDER }
			: entry);
	}
	if (typeof clone.baseUrl === 'string') {
		clone.baseUrl = hostnameOnly(clone.baseUrl);
	}
	if (typeof clone.authUrl === 'string') {
		clone.authUrl = hostnameOnly(clone.authUrl);
	}
	if (message.type === 'config' && 'providers' in clone) {
		clone.providers = redactProviders(clone.providers);
	}
	// The net under everything above: every string of every message, at any depth.
	return scrubDeep(clone) as Record<string, unknown> & { type: string };
}

/**
 * The {@link MessageSink} implementation wrapping one {@link RemoteSocket}. `id` is caller-
 * supplied (matching the constant-id convention `chatViewProvider.ts` uses for its own sinks)
 * rather than minted here, since there is exactly one of these per connected relay socket and
 * `remoteService.ts` already knows what to call it.
 *
 * Also owns the Web Push *trigger*: every message posted here is checked against `push.ts`'s
 * `shouldPush` and, when it qualifies, sent to the relay as a `push` control frame — this is the
 * one place that already sees every outbound message and holds the socket to send one on, per
 * the plan's "wire it into the point that already knows a message is about to reach a remote
 * sink" framing. `lastPushAtMs`/`runStartedAtMs` are tracked per session id, in-memory only (no
 * persistence, resetting on extension restart is fine — there is no offline queue in this design
 * either, see `socket.ts`'s own doc). This extension has exactly one `RemoteSink` per connected
 * relay (one room, one host connection fanned out to however many client *devices* the relay
 * itself is talking to — see `room.ts`'s `routeAppMessage`), so there is no way from here to
 * tell "a device is already looking at this" from "no device is" — pushing whenever `shouldPush`
 * says yes, regardless, is an accepted simplification for this phase (a redundant notification on
 * a device already open is a minor annoyance, not a correctness bug), not an attempt to solve
 * per-device presence.
 */
export class RemoteSink implements MessageSink {
	readonly kind = 'remote' as const;
	readonly wantsChat = true;
	private readonly coalescer: TokenCoalescer;
	private seq = 0;
	/** Session id -> the `Date.now()` of this sink's last raised push. */
	private readonly lastPushAtMs = new Map<string, number>();
	/** Session id -> the `Date.now()` its current run started at, from the run's `runStart` message — needed for `shouldPush`'s `done` threshold. */
	private readonly runStartedAtMs = new Map<string, number>();

	/** Sealing is asynchronous; frames are chained so they leave in the order they were posted. */
	private sending: Promise<void> = Promise.resolve();

	constructor(readonly id: string, private readonly socket: RemoteSocket, private readonly e2e: HostE2E) {
		this.coalescer = new TokenCoalescer(message => this.transmit(message));
		this.socket.onRtt(rttMs => this.coalescer.setRttMs(rttMs));
	}

	post(message: Record<string, unknown> & { type: string }): void {
		this.maybeRaisePush(message);
		this.coalescer.feed(redactForRemote(message) as CoalescedMessage);
	}

	/**
	 * Sends the one frame that is not sealed: the key-agreement reply to a phone that has just
	 * paired (`docs/REMOTE-E2E.md`). It carries only the desktop's public key and a proof the relay
	 * cannot forge.
	 */
	sendHandshake(payload: unknown): void {
		this.socket.send({ v: 1, t: 'm', seq: ++this.seq, p: payload });
	}

	dispose(): void {
		// Anything still buffered when the sink tears down is worth sending — a disconnect
		// arriving mid-batch should not silently drop the tail of a streamed reply.
		this.coalescer.flushAll();
		this.socket.dispose();
	}

	/**
	 * Seals the message for every paired device and sends one frame each. There is no plaintext
	 * path: a message that cannot be sealed (no device has keys yet, or sealing failed) is not
	 * sent at all, and the relay only ever carries ciphertext (`docs/REMOTE-E2E.md`).
	 */
	private transmit(message: Record<string, unknown> & { type: string }): void {
		this.sending = this.sending.then(async () => {
			for (const frame of await this.e2e.sealForAll(message)) {
				const envelope: Envelope = { v: 1, t: 'm', seq: ++this.seq, p: frame };
				this.socket.send(envelope);
			}
		}).catch(() => { /* dropped, never sent in the clear */ });
	}

	/**
	 * Tracks a run's start time (`runStart` carries no timestamp of its own; `chatViewProvider.ts`
	 * mints one host-side per message it posts via `sessionPost`, always including `sessionId` —
	 * see its doc), and — for every message type `push.ts`'s `shouldPush` might act on — raises a
	 * `push` control frame when it says yes.
	 */
	private maybeRaisePush(message: Record<string, unknown> & { type: string }): void {
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
		if (message.type === 'runStart') {
			this.runStartedAtMs.set(sessionId, Date.now());
			return;
		}
		if (!isPushableEventType(message.type)) {
			return;
		}
		const now = Date.now();
		const runDurationMs = message.type === 'done' ? this.runDurationMs(sessionId, now) : undefined;
		if (!shouldPush(message.type, this.lastPushAtMs.get(sessionId), now, runDurationMs)) {
			return;
		}
		this.lastPushAtMs.set(sessionId, now);
		const { title, body, tag } = composePush(message, message.type);
		this.socket.sendControl({ c: 'push', title, body, tag, sessionId });
	}

	/** Elapsed time since `sessionId`'s tracked run start, or `undefined` if none was ever recorded (e.g. a `done` from before this sink connected). */
	private runDurationMs(sessionId: string, now: number): number | undefined {
		const startedAt = this.runStartedAtMs.get(sessionId);
		return startedAt === undefined ? undefined : now - startedAt;
	}
}
