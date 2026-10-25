// Turns raw runs into the summary table, and compares two result files.

const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const fmtK = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

/** Per-task and overall summary as markdown. */
export function report(meta, runs) {
	const lines = [`## ${meta.label}`, '', `${runs.length} run(s), ${new Date(meta.date).toISOString().slice(0, 10)}, approval ${meta.approval}`, ''];
	lines.push('| task | pass | avg steps | avg tool calls | tool errors | est. input tokens | avg time |', '|---|---|---|---|---|---|---|');
	const ids = [...new Set(runs.map(r => r.task))];
	for (const id of ids) {
		const rs = runs.filter(r => r.task === id);
		lines.push(`| ${id} | ${rs.filter(r => r.pass).length}/${rs.length} | ${avg(rs.map(r => r.steps)).toFixed(1)} | ${avg(rs.map(r => r.toolCalls)).toFixed(1)} | ${rs.reduce((a, r) => a + r.toolErrors, 0)} | ${fmtK(avg(rs.map(r => r.estInputTokens)))} | ${(avg(rs.map(r => r.ms)) / 1000).toFixed(0)}s |`);
	}
	const passed = runs.filter(r => r.pass);
	lines.push('', `**Pass rate: ${passed.length}/${runs.length} (${pct(passed.length, runs.length)})**`);
	// Cost is only comparable on work both sides finished, so averages over passes are reported too.
	lines.push(`Averages over passing runs: ${avg(passed.map(r => r.steps)).toFixed(1)} steps, ${avg(passed.map(r => r.toolCalls)).toFixed(1)} tool calls, ${fmtK(avg(passed.map(r => r.estInputTokens)))} est. input tokens, ${(avg(passed.map(r => r.ms)) / 1000).toFixed(0)}s`);
	const cats = [...new Set(runs.map(r => r.category))];
	lines.push('', 'By category: ' + cats.map(c => { const rs = runs.filter(r => r.category === c); return `${c} ${rs.filter(r => r.pass).length}/${rs.length}`; }).join(', '));
	const flags = [];
	const asked = runs.filter(r => r.asked).length;
	if (asked) { flags.push(`${asked} run(s) stopped to ask the user`); }
	const timeouts = runs.filter(r => r.timedOut).length;
	if (timeouts) { flags.push(`${timeouts} run(s) timed out`); }
	const errs = runs.filter(r => r.errors.length).length;
	if (errs) { flags.push(`${errs} run(s) surfaced an error (provider/limit)`); }
	if (flags.length) { lines.push('', 'Flags: ' + flags.join('; ')); }
	return lines.join('\n');
}

/** Side-by-side comparison of two result files, per task. */
export function compare(a, b) {
	const ids = [...new Set([...a.runs, ...b.runs].map(r => r.task))];
	const sum = (data, id) => { const rs = data.runs.filter(r => r.task === id); return { n: rs.length, ok: rs.filter(r => r.pass).length, steps: avg(rs.map(r => r.steps)), tok: avg(rs.map(r => r.estInputTokens)), ms: avg(rs.map(r => r.ms)) }; };
	const lines = [`## ${a.meta.label}  vs  ${b.meta.label}`, '', '| task | A pass | B pass | A steps | B steps | A tokens | B tokens | A time | B time |', '|---|---|---|---|---|---|---|---|---|'];
	for (const id of ids) {
		const x = sum(a, id), y = sum(b, id);
		lines.push(`| ${id} | ${x.ok}/${x.n} | ${y.ok}/${y.n} | ${x.steps.toFixed(1)} | ${y.steps.toFixed(1)} | ${fmtK(x.tok)} | ${fmtK(y.tok)} | ${(x.ms / 1000).toFixed(0)}s | ${(y.ms / 1000).toFixed(0)}s |`);
	}
	const pa = a.runs.filter(r => r.pass).length, pb = b.runs.filter(r => r.pass).length;
	lines.push('', `**Overall: A ${pa}/${a.runs.length} (${pct(pa, a.runs.length)}) — B ${pb}/${b.runs.length} (${pct(pb, b.runs.length)})**`);
	return lines.join('\n');
}
