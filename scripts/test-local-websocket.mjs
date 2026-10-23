/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The local relay's WebSocket framing (src/remote/local/websocket.ts) against a fake socket:
// the RFC 6455 rules a hostile or broken peer can break (control frames, reserved bits, close
// codes), the close-reason truncation, the keepalive ping that prunes half-open peers, and the
// cap on unsent bytes. Run:
//   node scripts/build-tests.mjs && node scripts/test-local-websocket.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { WsConnection, truncateUtf8 } = await import(new URL('../out/remote/local/websocket.js', import.meta.url));

/** A socket double: records what the server wrote and reports a settable backlog. */
class FakeSocket extends EventEmitter {
	constructor() {
		super();
		this.written = [];
		this.ended = false;
		this.destroyed = false;
		this.writableLength = 0;
	}
	write(buf) { this.written.push(Buffer.from(buf)); return true; }
	end() { this.ended = true; }
	destroy() { this.destroyed = true; }
}

/** A masked client frame. */
function frame(opcode, payload = Buffer.alloc(0), { fin = true, rsv = 0 } = {}) {
	const mask = Buffer.from([1, 2, 3, 4]);
	let header;
	if (payload.length < 126) {
		header = Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | payload.length]);
	} else {
		header = Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]);
	}
	const body = Buffer.from(payload);
	for (let i = 0; i < body.length; i++) { body[i] ^= mask[i & 3]; }
	return Buffer.concat([header, mask, body]);
}

function connect(options) {
	const socket = new FakeSocket();
	const events = { messages: [], closes: [] };
	const conn = new WsConnection(socket, { onMessage: t => events.messages.push(t), onClose: (c, r) => events.closes.push([c, r]) }, undefined, options);
	return { socket, conn, events };
}

/** The close code the server sent, from its last written close frame. */
function sentCloseCode(socket) {
	const closeFrame = socket.written.find(b => (b[0] & 0x0f) === 0x8);
	return closeFrame ? closeFrame.readUInt16BE(2) : undefined;
}

// A well-formed text message still arrives.
{
	const { socket, events, conn } = connect();
	socket.emit('data', frame(0x1, Buffer.from('hi')));
	assert.deepEqual(events.messages, ['hi']);
	conn.close();
}

// Reserved bits set: protocol error.
{
	const { socket } = connect();
	socket.emit('data', frame(0x1, Buffer.from('x'), { rsv: 0x40 }));
	assert.equal(sentCloseCode(socket), 1002);
}

// Control frames: fragmented or over 125 bytes is a protocol error; a normal ping is answered.
{
	const a = connect();
	a.socket.emit('data', frame(0x9, Buffer.from('p'), { fin: false }));
	assert.equal(sentCloseCode(a.socket), 1002, 'a fragmented control frame is refused');
	const b = connect();
	b.socket.emit('data', frame(0x9, Buffer.alloc(126, 1)));
	assert.equal(sentCloseCode(b.socket), 1002, 'an oversized control frame is refused');
	const c = connect();
	c.socket.emit('data', frame(0x9, Buffer.from('ok')));
	assert.equal(c.socket.written[0][0] & 0x0f, 0xa, 'a ping is answered with a pong');
	c.conn.close();
}

// Close frames: invalid codes are not echoed back.
for (const [sent, expected] of [[1005, 1002], [1006, 1002], [0, 1002], [1000, 1000], [4001, 4001]]) {
	const { socket } = connect();
	const payload = Buffer.alloc(2);
	payload.writeUInt16BE(sent, 0);
	socket.emit('data', frame(0x8, payload));
	assert.equal(sentCloseCode(socket), expected, `close ${sent} is answered with ${expected}`);
}
{
	const { socket } = connect();
	socket.emit('data', frame(0x8));
	assert.equal(sentCloseCode(socket), 1000, 'an empty close is answered 1000');
}

// A close reason is cut on a character boundary, never mid-sequence.
{
	assert.equal(truncateUtf8(Buffer.from('é'.repeat(100)), 123).toString('utf8'), 'é'.repeat(61), '122 bytes of 2-byte characters, not 123');
	const { conn, socket } = connect();
	conn.close(1000, 'é'.repeat(100));
	const sent = socket.written.find(b => (b[0] & 0x0f) === 0x8);
	assert.ok(!sent.subarray(4).toString('utf8').includes('�'), 'no replacement character from a split sequence');
	assert.ok(sent.length <= 2 + 125);
}

// Keepalive: a peer that never answers the server's ping is dropped; one that does is kept.
{
	const { socket, events } = connect({ pingIntervalMs: 20 });
	await new Promise(r => setTimeout(r, 90));
	assert.ok(socket.written.some(b => (b[0] & 0x0f) === 0x9), 'the server pings');
	assert.equal(socket.destroyed, true, 'a silent peer is destroyed');
	assert.equal(events.closes.length, 1);
	const live = connect({ pingIntervalMs: 20 });
	const timer = setInterval(() => live.socket.emit('data', frame(0xa)), 10);
	await new Promise(r => setTimeout(r, 90));
	clearInterval(timer);
	assert.equal(live.socket.destroyed, false, 'a peer that answers stays connected');
	live.conn.close();
}

// Backpressure: a peer that stops reading is closed 1013 instead of buffered for forever.
{
	const { conn, socket } = connect({ maxBufferedBytes: 1000 });
	conn.send('a');
	assert.equal(conn.isOpen, true);
	socket.writableLength = 5000;
	conn.send('b');
	assert.equal(conn.isOpen, false);
	assert.equal(sentCloseCode(socket), 1013);
}

console.log('test-local-websocket: all assertions passed');
process.exit(0);
