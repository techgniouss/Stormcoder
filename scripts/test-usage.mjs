// The usage log (src/usage/usageLog.ts): what is read off a backend's response, what is
// written to disk (and what never is), and how it adds up for the Usage view.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	AnthropicUsageTally, UsageLog, dayOf, daysAgo, reportUsage, setUsageSink, summarize, usageFromOpenAI,
} from '../out/usage/usageLog.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-usage-'));
const file = path.join(tmp, 'deep', 'usage.jsonl');

// OpenAI-style usage: cached tokens are taken out of the prompt count, never double counted.
assert.deepEqual(usageFromOpenAI({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } }),
	{ input: 40, output: 20, cacheRead: 60, cacheWrite: 0 });
assert.deepEqual(usageFromOpenAI({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
// A backend reporting only part of it gets zeros for the rest, never NaN.
assert.deepEqual(usageFromOpenAI({ usage: { completion_tokens: 5 } }), { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(usageFromOpenAI({ usage: { prompt_tokens: 'many', completion_tokens: -4, prompt_tokens_details: null } }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
// A cached count larger than the prompt cannot push input below zero.
assert.deepEqual(usageFromOpenAI({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } } }), { input: 0, output: 0, cacheRead: 10, cacheWrite: 0 });
for (const none of [{}, { usage: null }, { choices: [] }, null, undefined, 'x', 3]) {
	assert.equal(usageFromOpenAI(none), undefined);
}

// Anthropic: the prompt side arrives on message_start, output grows on message_delta.
{
	const tally = new AnthropicUsageTally();
	assert.equal(tally.result(), undefined, 'a stream that says nothing reports nothing');
	tally.note({ type: 'content_block_delta' });
	assert.equal(tally.result(), undefined);
	tally.note({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 1 } } });
	tally.note({ type: 'message_delta', usage: { output_tokens: 25 } });
	tally.note({ type: 'message_delta', usage: { output_tokens: 90 } });
	tally.note({ type: 'message_delta', usage: { output_tokens: 3 } }); // a straggler cannot lower it
	assert.deepEqual(tally.result(), { input: 12, output: 90, cacheRead: 300, cacheWrite: 40 });
}

// The log: one line per request, holding only the day, provider, model and four counts.
let now = new Date(2026, 10, 15, 23, 30);
const log = new UsageLog(file, () => now);
log.record('openai', 'gpt-x', { input: 40, output: 20, cacheRead: 60, cacheWrite: 0 });
log.record('anthropic', 'claude-y', { input: 5, output: 5, cacheRead: 0, cacheWrite: 10 });
log.record('openai', 'gpt-x', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
log.record('openai', 'gpt-x', { input: NaN, output: undefined, cacheRead: -1, cacheWrite: 'x' });
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
assert.equal(lines.length, 2, 'a request that reported no tokens is not recorded');
assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['cacheRead', 'cacheWrite', 'day', 'input', 'model', 'output', 'provider']);
assert.equal(JSON.parse(lines[0]).day, '2026-11-15');

// Days are local calendar days; daysAgo crosses a month boundary.
assert.equal(dayOf(new Date(2026, 0, 5)), '2026-01-05');
assert.equal(daysAgo(new Date(2026, 10, 2), 6), '2026-10-27');
assert.equal(daysAgo(now, 0), '2026-11-15');

// Reading by period; damaged and foreign lines are skipped.
fs.appendFileSync(file, 'not json\n{"day":"yesterday","provider":"a","model":"b"}\n{"day":"2026-11-01","provider":"openai","model":"gpt-x","input":1000,"output":"lots"}\n\n');
assert.equal(log.read('2026-11-15').length, 2);
assert.deepEqual(log.read('2026-11-01').map(e => [e.day, e.input, e.output]), [['2026-11-15', 40, 20], ['2026-11-15', 5, 5], ['2026-11-01', 1000, 0]]);
assert.deepEqual(new UsageLog(path.join(tmp, 'absent.jsonl')).read('2000-01-01'), []);

// Totals, per-model rows (largest first) and the cache hit rate.
{
	const s = summarize(log.read('2026-11-01'));
	assert.deepEqual([s.requests, s.input, s.output, s.cacheRead, s.cacheWrite], [3, 1045, 25, 60, 10]);
	assert.equal(s.cacheHitRate, 60 / (1045 + 60 + 10));
	assert.deepEqual(s.rows.map(r => [r.provider, r.model, r.requests, r.input]), [['openai', 'gpt-x', 2, 1040], ['anthropic', 'claude-y', 1, 5]]);
	const none = summarize([]);
	assert.deepEqual([none.requests, none.cacheHitRate, none.rows], [0, undefined, []]);
}

// Pruning drops old and damaged lines and keeps the rest byte for byte.
log.prune('2026-11-10');
assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), lines);
log.prune('2026-11-10');
assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), lines, 'pruning twice is harmless');
new UsageLog(path.join(tmp, 'absent.jsonl')).prune('2026-01-01');

// The sink: providers report through it; with none installed, or nothing reported, it is a no-op.
reportUsage('openai', 'gpt-x', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
setUsageSink(log);
reportUsage('openai', 'gpt-x', undefined);
now = new Date(2026, 10, 16, 0, 5);
reportUsage('groq', 'llama', { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 });
setUsageSink(undefined);
reportUsage('groq', 'llama', { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(log.read('2026-11-16'), [{ day: '2026-11-16', provider: 'groq', model: 'llama', input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }]);

// A log that cannot be written must not throw into a chat turn.
new UsageLog(path.join(file, 'under-a-file', 'usage.jsonl')).record('a', 'b', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-usage: all assertions passed');
