// Unit test for the pure helpers in src/auto/orchestrator.ts: plan step extraction and
// which recorded changes reach the reviewer.
import assert from 'node:assert/strict';
import Module from 'node:module';

const vscodeStub = {
	workspace: { getConfiguration: () => ({ get: () => undefined, async update() { } }) },
	ConfigurationTarget: { Global: 1 },
};
const load = Module._load;
Module._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : load(request, parent, isMain);

const { extractSteps, recordChangeStart, recordChangeEnd } = await import(new URL('../out/auto/orchestrator.js', import.meta.url));

// Only top-level numbered items; indented sub-items and a Risks list are not steps.
assert.deepStrictEqual(extractSteps([
	'Plan:',
	'1. Add the parser',
	'   1. nested detail',
	'2) Wire it up',
	'',
	'Risks:',
	'1. It might break',
].join('\n')), ['Add the parser', 'Wire it up']);
assert.equal(extractSteps(Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n')).length, 12);

// A refused write never reaches the reviewer; a successful one does.
{
	const sink = { narration: [], changes: [], pending: new Map() };
	const bad = { id: 'a', name: 'write_file', args: { path: 'x.ts', content: 'nope' } };
	const good = { id: 'b', name: 'write_file', args: { path: 'y.ts', content: 'yes' } };
	recordChangeStart(sink, bad);
	recordChangeStart(sink, good);
	recordChangeEnd(sink, bad, 'refused', true);
	recordChangeEnd(sink, good, 'ok', false);
	assert.equal(sink.changes.length, 1);
	assert.ok(sink.changes[0].includes('y.ts'));
}

console.log('test-auto-steps: all assertions passed');
