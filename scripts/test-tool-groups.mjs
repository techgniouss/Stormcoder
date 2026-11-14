// Folded tool cards (media/toolGroups.js): which kind each tool is, and the one line a folded
// run of them shows. Also pins how main.js uses it: failed and running cards are never folded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL(`../media/${f}`, import.meta.url), 'utf8');
const ctx = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('toolGroups.js'), ctx);
const G = ctx.StormToolGroups;

assert.equal(G.MIN_GROUP, 3);

assert.equal(G.category('run_command'), 'command');
assert.equal(G.category('write_file'), 'edit');
assert.equal(G.category('edit_file'), 'edit');
assert.equal(G.category('read_file'), 'read');
assert.equal(G.category('list_dir'), 'read');
assert.equal(G.category('search_files'), 'search');
assert.equal(G.category('glob_files'), 'search');
assert.equal(G.category('mcp__server__thing'), 'other');
assert.equal(G.category(''), 'other');

assert.equal(G.summarize(['read_file', 'read_file', 'read_file', 'read_file']), 'Read 4 files');
assert.equal(G.summarize(['read_file']), 'Read 1 file');
assert.equal(G.summarize(['run_command', 'read_file', 'run_command']), 'Ran 2 commands, read 1 file');
// Commands and edits outrank reads and searches, whatever order they happened in.
assert.equal(G.summarize(['read_file', 'search_files', 'edit_file', 'run_command']), 'Ran 1 command, edited 1 file and 2 more');
assert.equal(G.summarize(['search_files', 'glob_files']), 'Ran 2 searches');
assert.equal(G.summarize(['mcp__a__b', 'read_file', 'mcp__a__c']), 'Read 1 file, made 2 other calls');
assert.equal(G.summarize(['mcp__a__b']), 'Made 1 other call');
assert.equal(G.summarize([]), 'No calls');
// A name that collides with Object.prototype must not be read off it.
assert.equal(G.summarize(['constructor', 'toString', '__proto__']), 'Made 3 other calls');

// main.js: tolerates a missing toolGroups.js, and never folds a running or failed card.
const main = read('main.js');
assert.ok(main.includes("typeof StormToolGroups === 'undefined'"), 'main.js must tolerate a missing toolGroups.js');
const foldable = /function isFoldableTool\(el\) \{([\s\S]*?)\n\t\}/.exec(main);
assert.ok(foldable, 'main.js has isFoldableTool');
assert.ok(foldable[1].includes("'running'") && foldable[1].includes("'tool-error'"), 'running and failed cards are excluded');
assert.ok(foldable[1].includes('.tool.running, .tool.tool-error'), 'and so is a card with a running or failed call nested in it');

// The stylesheet styles the group, and uses no hard-coded colour for it.
const css = read('main.css');
const rule = /\.tool-group\s*\{([^}]*)\}/.exec(css);
assert.ok(rule, '.tool-group is styled');
assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(rule[1].replace(/var\([^)]*\)/g, '')), '.tool-group takes its colours from variables');

console.log('test-tool-groups: all assertions passed');
