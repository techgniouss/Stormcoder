import { read } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const notes = [];
	const raw = read(dir, 'package.json');
	let j; try { j = JSON.parse(raw); } catch { return { pass: false, notes: ['package.json is not valid JSON'] }; }
	const ok = j.scripts?.lint === 'eslint src' && j.version === '1.4.0' && j.scripts.build === 'tsc -p .' && j.scripts.test === 'node --test' && j.dependencies?.['left-pad'] === '^1.3.0' && j.name === 'svc';
	if (!ok) { notes.push('fields wrong or lost'); }
	const indent = /^\{\n  "name"/.test(raw) && raw.endsWith('\n');
	if (!indent) { notes.push('formatting changed (2-space indent / trailing newline)'); }
	return { pass: ok && indent, notes };
}
