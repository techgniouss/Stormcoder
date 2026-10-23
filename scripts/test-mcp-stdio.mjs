/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/mcp/client.ts — the stdio MCP transport. Run:
//   node extensions/openvs-chat/scripts/test-mcp-stdio.mjs
//
// Driven against a real child process speaking JSON-RPC on its stdio, because the two things
// worth pinning are about the wire: a server's own requests share the id space with ours, and
// how a command is launched depends on the platform.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { McpStdioClient, planSpawn } = await import(new URL('../out/mcp/client.js', import.meta.url));

// --- launching: Windows needs a shell for .cmd shims (npx), everything else does not --------
assert.deepEqual(planSpawn('npx', ['-y', 'server', '--root', 'C:\\My Files'], 'linux'),
	{ file: 'npx', args: ['-y', 'server', '--root', 'C:\\My Files'], shell: false }, 'POSIX passes arguments untouched');
assert.deepEqual(planSpawn('C:\\tools\\srv.exe', ['a b'], 'win32'),
	{ file: 'C:\\tools\\srv.exe', args: ['a b'], shell: false }, 'a Windows .exe is spawned directly');
assert.deepEqual(planSpawn('npx', ['-y', '@scope/server', 'C:\\My Files', 'say "hi"'], 'win32'),
	{ file: 'npx -y @scope/server "C:\\My Files" "say ""hi"""', args: [], shell: true },
	'a Windows shim goes through the shell as one quoted command line');

// --- a server that talks to us as well as answering --------------------------------------
// During the handshake it sends its own request with id 1 — the id our `initialize` is using —
// and then pings. The handshake must still complete, and both must be answered.
const server = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const replies = [];
rl.on('line', line => {
	const m = JSON.parse(line);
	if (m.method === undefined && m.id !== undefined && m.id >= 1000) { replies.push(m); return; }
	if (m.method === 'initialize') {
		send({ jsonrpc: '2.0', id: 1000, method: 'roots/list' });
		send({ jsonrpc: '2.0', id: 1001, method: 'ping' });
		send({ jsonrpc: '2.0', id: 1, method: 'roots/list' });
		send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
	} else if (m.method === 'tools/list') {
		send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo' }] } });
	} else if (m.method === 'tools/call') {
		send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(replies) }] } });
	}
});
`;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-')), 'server.cjs');
fs.writeFileSync(file, server);

const client = new McpStdioClient({ command: process.execPath, args: [file] });
try {
	await client.start();
	assert.deepEqual((await client.listTools()).map(t => t.name), ['echo'], 'a server request with our id did not hijack the handshake');
	const { text } = await client.callTool('echo', {});
	const replied = JSON.parse(text);
	const ping = replied.find(r => r.id === 1001);
	const roots = replied.find(r => r.id === 1000);
	assert.deepEqual(ping?.result, {}, 'ping is answered');
	assert.equal(roots?.error?.code, -32601, 'a request for a capability we did not declare is declined, not left hanging');
} finally {
	client.dispose();
}

// --- robustness: split multibyte, pagination, replies buffered before exit, SIGTERM ignored ---
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio2-'));
	const pidFile = path.join(dir, 'pid');
	const script = path.join(dir, 'server2.cjs');
	fs.writeFileSync(script, `
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => { /* ignored on purpose */ });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', line => {
	const m = JSON.parse(line);
	if (m.method === 'initialize') {
		send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
	} else if (m.method === 'tools/list') {
		if (!m.params.cursor) {
			// Split the reply in the middle of a 4-byte character.
			const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a', description: '\\u{1F600}smile' }], nextCursor: 'c2' } }) + '\\n');
			const cut = bytes.indexOf(Buffer.from('\\u{1F600}')) + 2;
			process.stdout.write(bytes.subarray(0, cut));
			setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
		} else {
			send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'b' }] } });
		}
	} else if (m.method === 'tools/call') {
		send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'last words' }] } });
		if (m.params.name === 'quit') { process.exit(0); }
	}
});
`);
	const c = new McpStdioClient({ command: process.execPath, args: [script] });
	await c.start();
	const tools = await c.listTools();
	assert.deepEqual(tools.map(t => t.name), ['a', 'b'], 'nextCursor pages are followed');
	assert.equal(tools[0].description, '\u{1F600}smile', 'a multibyte character split across reads survives');
	const res = await c.callTool('quit', {});
	assert.equal(res.text, 'last words', 'a reply written just before the server exits is delivered');
	c.dispose();

	// A server that ignores SIGTERM is killed anyway.
	const c2 = new McpStdioClient({ command: process.execPath, args: [script] });
	await c2.start();
	const pid = Number(fs.readFileSync(pidFile, 'utf8'));
	c2.dispose();
	await new Promise(r => setTimeout(r, 2600));
	let alive = true;
	try { process.kill(pid, 0); } catch { alive = false; }
	assert.equal(alive, false, 'dispose escalates to SIGKILL');
}

console.log('test-mcp-stdio.mjs: all assertions passed');
