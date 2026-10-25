/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

/**
 * The server half of RFC 6455, just enough for the local relay (`relayServer.ts`): the upgrade
 * handshake, text frames in both directions, fragmentation, ping/pong and close. Hand-written
 * rather than a `ws` dependency because this extension deliberately carries almost none (see
 * `sql.js`'s note in CLAUDE.md), and the relay protocol needs nothing beyond this: every frame
 * it exchanges is a small JSON text message.
 *
 * `vscode`-free, so `scripts/test-local-relay.mjs` drives it with Node's own `WebSocket` client
 * over a real socket — a client written by someone else is the honest check on framing.
 */

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest message accepted from a peer. Chunked image uploads send 64KB base64 slices; this leaves room without letting one peer buffer unbounded memory. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** How often the server pings, and the most bytes it lets queue unsent for one peer before dropping it. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** The longest close reason that fits in a 125-byte control frame beside its 2-byte code. */
const MAX_CLOSE_REASON_BYTES = 123;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Callbacks a {@link WsConnection} reports to. */
export interface WsHandlers {
	onMessage(text: string): void;
	onClose(code: number, reason: string): void;
}

/** Tunables for a {@link WsConnection}; the defaults suit production, tests shorten them. */
export interface WsOptions {
	readonly pingIntervalMs?: number;
	readonly maxBufferedBytes?: number;
}

/** Cuts `bytes` to at most `max` bytes without splitting a UTF-8 sequence. */
export function truncateUtf8(bytes: Buffer, max: number): Buffer {
	if (bytes.length <= max) {
		return bytes;
	}
	let end = max;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
		end--;
	}
	return bytes.subarray(0, end);
}

/** Whether a peer may put `code` in a close frame (RFC 6455 §7.4: not 1004/1005/1006/1015, nothing outside the defined ranges). */
function isValidCloseCode(code: number): boolean {
	return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** One accepted WebSocket. */
export class WsConnection {
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private fragmentBytes = 0;
	private closed = false;
	/** Whether a ping has gone unanswered (no frame of any kind since). */
	private awaitingPong = false;
	private pinger?: NodeJS.Timeout;
	private readonly maxBufferedBytes: number;

	constructor(private readonly socket: Duplex, private readonly handlers: WsHandlers, head?: Buffer, options: WsOptions = {}) {
		this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
		socket.on('data', (chunk: Buffer) => {
			this.awaitingPong = false;
			this.onData(chunk);
		});
		socket.on('close', () => this.finish(1006, ''));
		socket.on('error', () => this.finish(1006, ''));
		// A peer that vanished without a FIN (phone out of range) never errors; a ping that
		// goes unanswered for a whole interval is how it is found and dropped.
		this.pinger = setInterval(() => {
			if (this.closed) {
				return;
			}
			if (this.awaitingPong) {
				this.finish(1006, 'ping timeout');
				this.socket.destroy();
				return;
			}
			this.awaitingPong = true;
			this.writeFrame(OP_PING, Buffer.alloc(0));
		}, options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
		this.pinger.unref?.();
		// Bytes the client sent right behind its upgrade request arrive here, not as `data`.
		if (head?.length) {
			queueMicrotask(() => this.onData(head));
		}
	}

	/** Whether frames can still be sent. */
	get isOpen(): boolean {
		return !this.closed;
	}

	/** Sends one text message. A no-op once the connection is closing. */
	send(text: string): void {
		if (!this.closed) {
			this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
		}
	}

	/** Starts a clean close: sends the close frame, then ends the socket. */
	close(code = 1000, reason = ''): void {
		if (this.closed) {
			return;
		}
		const reasonBytes = truncateUtf8(Buffer.from(reason, 'utf8'), MAX_CLOSE_REASON_BYTES);
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code, 0);
		reasonBytes.copy(payload, 2);
		this.writeFrame(OP_CLOSE, payload);
		this.socket.end();
		this.finish(code, reason);
	}

	private finish(code: number, reason: string): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearInterval(this.pinger);
		this.handlers.onClose(code, reason);
		// A peer that never answers our close must not hold the socket open forever.
		setTimeout(() => this.socket.destroy(), 1000).unref?.();
	}

	private writeFrame(opcode: number, payload: Buffer): void {
		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x80 | opcode, payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
		// A peer that stopped reading must not make this process buffer for it without bound.
		if (opcode !== OP_CLOSE && this.socket.writableLength > this.maxBufferedBytes) {
			this.close(1013, 'too much unsent data');
		}
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		while (!this.closed) {
			const frame = this.readFrame();
			if (!frame) {
				return;
			}
			this.handleFrame(frame.fin, frame.opcode, frame.payload);
		}
	}

	/** Parses one complete frame off the front of the buffer, or `undefined` until more bytes arrive. */
	private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
		const buf = this.buffer;
		if (buf.length < 2) {
			return undefined;
		}
		const fin = (buf[0] & 0x80) !== 0;
		const opcode = buf[0] & 0x0f;
		if ((buf[0] & 0x70) !== 0) {
			// RFC 6455 §5.2: RSV bits are zero unless an extension was negotiated (none is).
			this.close(1002, 'reserved bits set');
			return undefined;
		}
		const masked = (buf[1] & 0x80) !== 0;
		let length = buf[1] & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (buf.length < 4) {
				return undefined;
			}
			length = buf.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buf.length < 10) {
				return undefined;
			}
			const big = buf.readBigUInt64BE(2);
			if (big > BigInt(MAX_MESSAGE_BYTES)) {
				this.close(1009, 'message too big');
				return undefined;
			}
			length = Number(big);
			offset = 10;
		}
		if (opcode >= OP_CLOSE && (!fin || length > 125)) {
			// RFC 6455 §5.5: control frames are never fragmented and carry at most 125 bytes.
			this.close(1002, 'invalid control frame');
			return undefined;
		}
		if (!masked) {
			// RFC 6455 §5.1: a server must close on an unmasked client frame.
			this.close(1002, 'client frames must be masked');
			return undefined;
		}
		if (length > MAX_MESSAGE_BYTES) {
			this.close(1009, 'message too big');
			return undefined;
		}
		if (buf.length < offset + 4 + length) {
			return undefined;
		}
		const mask = buf.subarray(offset, offset + 4);
		const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
		for (let i = 0; i < payload.length; i++) {
			payload[i] ^= mask[i & 3];
		}
		this.buffer = buf.subarray(offset + 4 + length);
		return { fin, opcode, payload };
	}

	private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode === OP_CLOSE) {
			if (payload.length === 1) {
				this.close(1002, 'invalid close frame');
				return;
			}
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
			if (!isValidCloseCode(code)) {
				// Never echo a code that must not appear on the wire (0, 1005, 1006, ...).
				this.close(1002, 'invalid close code');
				return;
			}
			this.close(code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '');
			return;
		}
		if (opcode === OP_PING) {
			this.writeFrame(OP_PONG, payload);
			return;
		}
		if (opcode === OP_PONG) {
			return;
		}
		if (opcode === OP_TEXT || opcode === OP_BINARY) {
			this.fragments = [payload];
			this.fragmentOpcode = opcode;
			this.fragmentBytes = payload.length;
		} else if (opcode === OP_CONTINUATION && this.fragments.length) {
			this.fragments.push(payload);
			this.fragmentBytes += payload.length;
			if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
				this.close(1009, 'message too big');
				return;
			}
		} else {
			this.close(1002, 'unexpected frame');
			return;
		}
		if (!fin) {
			return;
		}
		const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
		const wasText = this.fragmentOpcode === OP_TEXT;
		this.fragments = [];
		this.fragmentBytes = 0;
		// The relay protocol is text-only; a binary message is ignored, not fatal.
		if (wasText) {
			this.handlers.onMessage(whole.toString('utf8'));
		}
	}
}

/**
 * Completes the upgrade handshake on `socket` and returns the open connection, or answers with
 * `400` and returns `undefined` for a request that isn't a valid WebSocket upgrade.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: WsHandlers, options?: WsOptions): WsConnection | undefined {
	const key = req.headers['sec-websocket-key'];
	if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !key) {
		rejectUpgrade(socket, 400, 'expected websocket');
		return undefined;
	}
	const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n'
		+ 'Upgrade: websocket\r\n'
		+ 'Connection: Upgrade\r\n'
		+ `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
	if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') {
		socket.setNoDelay(true);
	}
	return new WsConnection(socket, handlers, head, options);
}

/** Refuses an upgrade with a plain HTTP status, the way the cloud relay's `Response` does. */
export function rejectUpgrade(socket: Duplex, status: number, text: string): void {
	const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required' }[status] ?? 'Error';
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
	socket.destroy();
}
