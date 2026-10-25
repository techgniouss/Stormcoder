/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Guards for the remote-control hardening that lives in code too entangled with the editor to
// construct here (chatViewProvider.ts), checked as source invariants, plus the cloud relay's
// own suite (openvs-relay/scripts/test-room-relay.mjs, which the root runner would otherwise
// never reach). Run:
//   node scripts/test-remote-hardening.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const provider = fs.readFileSync(new URL('../src/chatViewProvider.ts', import.meta.url), 'utf8');

// A remote setQueue can only keep or reorder entries already queued: the desktop drains the
// queue under the local origin, which has no approval floor.
assert.match(provider, /case 'setQueue':[\s\S]{0,900}origin !== WEBVIEW_SINK_ID[\s\S]{0,600}remaining\.indexOf\(entry\)/);

// A remote steer is only accepted into a run a remote client started.
assert.match(provider, /origin !== WEBVIEW_SINK_ID && this\.runOriginLocal\.get\(message\.sessionId\)\?\.local !== false/);
assert.match(provider, /this\.runOriginLocal\.set\(sessionId, \{ runId, local: origin === WEBVIEW_SINK_ID \}\)/);

// Undo: the checkpoint is not spliced before the restore, and survives a throw or leftovers.
const undo = provider.slice(provider.indexOf('private async undoLastRun'), provider.indexOf('/** Builds the per-run channel'));
assert.ok(!/list\.splice\(index/.test(undo), 'undo must not remove the entry before restoring');
assert.match(undo, /try \{\s*report = await entry\.checkpoint\.restore\(\)/);
assert.match(undo, /remaining\.length === 0/);

// A failed save is logged and reported once per streak, never an unhandled rejection.
const persist = provider.slice(provider.indexOf('private persistSessionState'), provider.indexOf('private saveFailing'));
assert.match(persist, /\.then\(/);
assert.match(persist, /if \(!this\.saveFailing\)/);

// The cloud relay's suite.
const relay = spawnSync(process.execPath, [new URL('../openvs-relay/scripts/test-room-relay.mjs', import.meta.url).pathname], { encoding: 'utf8' });
if (fs.existsSync(new URL('../openvs-relay/scripts/test-room-relay.mjs', import.meta.url))) {
	assert.equal(relay.status, 0, `${relay.stdout}${relay.stderr}`);
}

console.log('test-remote-hardening: all assertions passed');
