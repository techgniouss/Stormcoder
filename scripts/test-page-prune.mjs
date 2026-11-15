// Stored pages (src/pages/prune.ts): one that no chat shows any more is removed, and nothing
// else in the folder ever is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_MIN_AGE_MS, pageIdsIn, prunePages } from '../out/pages/prune.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-prune-'));
const now = Date.now();
const put = (name, ageMs) => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, '<p>x</p>');
	const at = new Date(now - ageMs);
	fs.utimesSync(file, at, at);
	return file;
};
const DAY = 24 * 60 * 60 * 1000;
assert.equal(PAGE_MIN_AGE_MS, DAY);

// Which pages transcripts show.
const shown = pageIdsIn([
	[{ role: 'user', content: 'hi' }, { role: 'assistant', kind: 'info', page: { id: 'aaaaaaaaaaaaaaaa', title: 'A' } }],
	undefined,
	[{ page: { id: 'bbbbbbbbbbbbbbbb' } }, { page: {} }, { page: { id: 7 } }, {}],
]);
assert.deepEqual([...shown].sort(), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);

put('aaaaaaaaaaaaaaaa.html', 30 * DAY);   // shown by an open chat: kept however old
put('bbbbbbbbbbbbbbbb.html', 30 * DAY);   // shown by a saved conversation: kept
put('cccccccccccccccc.html', 2 * DAY);    // shown by nothing, old: removed
put('dddddddddddddddd.html', 60 * 1000);  // shown by nothing, but just written: kept for now
put('notes.html', 30 * DAY);              // not a page of ours
put('ABCDEFABCDEFABCD.html', 30 * DAY);   // not our naming (ids are lowercase)
put('eeeeeeeeeeeeeeee.html.bak', 30 * DAY);
fs.mkdirSync(path.join(dir, 'ffffffffffffffff.html'));  // a folder with a page's name
fs.mkdirSync(path.join(dir, 'sub'));
put(path.join('sub', '1111111111111111.html'), 30 * DAY);  // not directly in the folder

assert.equal(prunePages(dir, shown, now), 1);
assert.deepEqual(fs.readdirSync(dir).sort(), ['ABCDEFABCDEFABCD.html', 'aaaaaaaaaaaaaaaa.html', 'bbbbbbbbbbbbbbbb.html', 'dddddddddddddddd.html', 'eeeeeeeeeeeeeeee.html.bak', 'ffffffffffffffff.html', 'notes.html', 'sub'].sort());
assert.equal(fs.existsSync(path.join(dir, 'sub', '1111111111111111.html')), true);
assert.equal(prunePages(dir, shown, now), 0, 'a second pass removes nothing more');
// Once it is a day old, the unshown page goes too.
assert.equal(prunePages(dir, shown, now + DAY), 1);
assert.equal(fs.existsSync(path.join(dir, 'dddddddddddddddd.html')), false);
// A folder that does not exist is not an error.
assert.equal(prunePages(path.join(dir, 'absent'), shown, now), 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-page-prune: all assertions passed');
