import { read } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const raw = read(dir, 'analysis.ipynb');
	let j; try { j = JSON.parse(raw); } catch { return { pass: false, notes: ['notebook is not valid JSON'] }; }
	const notes = [];
	if (j.cells.length !== 3) { notes.push('cell count changed'); }
	const src = [].concat(j.cells[1]?.source ?? []).join('');
	const ok = /sum\(values\) \/ len\(values\)/.test(src) && !/\+\s*1/.test(src);
	if (!ok) { notes.push('mean still wrong: ' + src); }
	const intact = j.cells[0]?.cell_type === 'markdown' && [].concat(j.cells[2]?.source ?? []).join('') === 'print(mean)' && j.nbformat === 4;
	if (!intact) { notes.push('other cells or metadata damaged'); }
	return { pass: ok && intact && j.cells.length === 3, notes };
}
