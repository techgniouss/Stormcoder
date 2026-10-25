import { read } from '../../lib/check-lib.mjs';
export default async function check(dir, ctx) {
	const now = read(dir, 'src/big.js').split('\n');
	const was = read(ctx.original, 'src/big.js').split('\n');
	const diff = now.map((l, i) => l !== was[i] ? i : -1).filter(i => i >= 0);
	const notes = [];
	if (now.length !== was.length) { notes.push(`line count ${was.length} -> ${now.length}`); }
	const line = now.findIndex(l => l.includes('function f0450'));
	const fixed = line >= 0 && /beta/.test(now.slice(line, line + 3).join('\n'));
	if (!fixed) { notes.push('f0450 does not return beta'); }
	if (diff.length > 1) { notes.push(`${diff.length} lines differ from the original`); }
	return { pass: fixed && diff.length <= 1 && now.length === was.length, notes };
}
