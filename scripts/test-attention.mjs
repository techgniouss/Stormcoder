// Desktop notifications: which chat messages ask for the user's attention at each level, the
// fixed text a notification shows, and the throttle that stops a burst of approvals from
// becoming a burst of notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-attn-'));
await esbuild.build({ entryPoints: [path.join(root, 'host/attention.ts')], outfile: path.join(tmp, 'attention.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const { attentionFor, attentionText, attentionLevel, AttentionThrottle } = createRequire(import.meta.url)(path.join(tmp, 'attention.cjs'));

// Level `attention`: approvals and questions, not a finished run.
assert.equal(attentionFor({ type: 'approvalRequest', sessionId: 's' }, 'attention'), 'approval');
assert.equal(attentionFor({ type: 'askRequest', sessionId: 's' }, 'attention'), 'question');
assert.equal(attentionFor({ type: 'done', sessionId: 's' }, 'attention'), undefined);

// Level `all` adds a finished run; `off` is silent for everything.
assert.equal(attentionFor({ type: 'done', sessionId: 's' }, 'all'), 'done');
assert.equal(attentionFor({ type: 'approvalRequest' }, 'all'), 'approval');
for (const type of ['approvalRequest', 'askRequest', 'done']) {
	assert.equal(attentionFor({ type }, 'off'), undefined);
}

// Everything else, and anything that is not a message, asks for nothing.
for (const m of [{ type: 'token' }, { type: 'toolStart' }, {}, null, undefined, 'done', 7, [], { type: 5 }]) {
	assert.equal(attentionFor(m, 'all'), undefined);
}

// The setting: unknown or missing values fall back to `attention`.
assert.equal(attentionLevel('off'), 'off');
assert.equal(attentionLevel('all'), 'all');
assert.equal(attentionLevel('attention'), 'attention');
for (const v of [undefined, null, '', 'loud', 3, true, {}]) {
	assert.equal(attentionLevel(v), 'attention');
}

// The text is fixed per kind: a notification lands on the lock screen and in the OS history,
// so nothing from the message (a command, a path, a question) may reach it.
const texts = ['approval', 'question', 'done'].map(attentionText);
assert.equal(new Set(texts).size, 3);
for (const t of texts) {
	assert.ok(typeof t === 'string' && t.length > 0 && t.length < 80);
}
assert.equal(attentionText.length, 1, 'takes the kind alone, never the message');

// Throttle: one notification per kind per window; kinds do not block each other.
let now = 1_000;
const throttle = new AttentionThrottle(5_000, () => now);
assert.equal(throttle.allow('approval'), true);
assert.equal(throttle.allow('approval'), false);
assert.equal(throttle.allow('question'), true);
now += 4_999;
assert.equal(throttle.allow('approval'), false);
now += 1;
assert.equal(throttle.allow('approval'), true);
assert.equal(throttle.allow('approval'), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-attention: all assertions passed');
