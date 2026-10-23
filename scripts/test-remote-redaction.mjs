/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// `redactForRemote` (src/remote/remoteSink.ts) is the last thing every host message passes
// through before it leaves for the relay. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-redaction.mjs
import assert from 'node:assert/strict';

const { redactForRemote, RemoteSink } = await import(new URL('../out/remote/remoteSink.js', import.meta.url));

const image = { mimeType: 'image/jpeg', data: 'A'.repeat(200_000) };

// A user turn's attached images go out as a count: a phone renders "1 image attached", and the
// base64 would otherwise cross the relay (and a cellular link) on every message.
assert.deepEqual(
	redactForRemote({ type: 'userTurn', sessionId: 's', content: 'look', images: [image] }),
	{ type: 'userTurn', sessionId: 's', content: 'look', imageCount: 1 });

// The same inside a transcript: its window is budgeted by `content` bytes alone, so images
// used to ride along unbudgeted and made a reconnect's catch-up megabytes long.
assert.deepEqual(
	redactForRemote({
		type: 'transcript', sessionId: 's', from: 0, total: 2, truncated: false,
		messages: [{ role: 'user', content: 'see', images: [image, image] }, { role: 'assistant', content: 'ok' }],
	}).messages,
	[{ role: 'user', content: 'see', imageCount: 2 }, { role: 'assistant', content: 'ok' }]);

// An editor action's prompt embeds the desktop's selected code: a phone sees that it happened,
// never the code — live, and in any transcript it later receives.
assert.doesNotMatch(
	redactForRemote({ type: 'userTurn', sessionId: 's', content: 'Explain: secretFunction()', fromEditor: true }).content,
	/secretFunction/);
assert.doesNotMatch(
	JSON.stringify(redactForRemote({ type: 'transcript', messages: [{ role: 'user', content: 'Fix: secretFunction()', fromEditor: true }] }).messages),
	/secretFunction/);
assert.equal(redactForRemote({ type: 'userTurn', content: 'typed on the desktop' }).content, 'typed on the desktop');

// Existing boundary: a provider's base URL goes out host-only.
assert.equal(
	redactForRemote({ type: 'config', providers: [{ id: 'custom', baseUrl: 'https://gw.example.com/v1?token=secret' }] }).providers[0].baseUrl,
	'gw.example.com');

// Tool arguments/results, prompts and errors are scrubbed of credential shapes and bounded,
// at any nesting depth.
{
	const key = 'sk-' + 'a'.repeat(30);
	const start = redactForRemote({ type: 'toolStart', name: 'run_command', args: { command: `curl -H "Authorization: Bearer ${'t'.repeat(30)}" x`, env: { list: [`API_KEY=${key}`] } } });
	assert.doesNotMatch(JSON.stringify(start), new RegExp(key));
	assert.doesNotMatch(JSON.stringify(start), /ttttttttttttttt/);
	const end = redactForRemote({ type: 'toolEnd', name: 'read_file', result: `${key}\n` + 'x'.repeat(20_000) });
	assert.doesNotMatch(end.result, new RegExp(key));
	assert.ok(end.result.length < 9_000, 'a long result is truncated');
	assert.doesNotMatch(redactForRemote({ type: 'error', message: `failed with ${key}` }).message, new RegExp(key));
	assert.doesNotMatch(redactForRemote({ type: 'askRequest', question: `use ${key}?` }).question, new RegExp(key));
	assert.doesNotMatch(redactForRemote({ type: 'approvalRequest', title: `run ghp_${'b'.repeat(30)}` }).title, /ghp_/);
}

// Push notifications never carry a command's text and stay short.
{
	const controls = [];
	const socket = { onRtt() {}, send() {}, sendControl: f => controls.push(f), dispose() {} };
	const sink = new RemoteSink('r', socket);
	sink.post({ type: 'approvalRequest', id: 'a', sessionId: 's1', kind: 'command', title: 'rm -rf /home/me/secret-project' });
	sink.post({ type: 'error', sessionId: 's2', message: 'e'.repeat(500) });
	assert.doesNotMatch(controls[0].body, /rm -rf/);
	assert.ok(controls[1].body.length <= 120);
	assert.ok(controls.every(c => c.title.length <= 120));
}

console.log('test-remote-redaction: all assertions passed');
