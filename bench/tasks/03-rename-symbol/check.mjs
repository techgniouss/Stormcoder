import { sh, walk, read } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const notes = [];
	const left = walk(dir).filter(f => f.endsWith('.js') && /getUserName/.test(read(dir, f)));
	if (left.length) { notes.push('old name remains in: ' + left.join(', ')); }
	const used = walk(dir).filter(f => f.endsWith('.js') && /getDisplayName/.test(read(dir, f)));
	if (used.length < 6) { notes.push('new name found in only ' + used.length + ' files'); }
	const t = sh(dir, 'node --test');
	if (!t.ok) { notes.push('tests failing'); }
	return { pass: !left.length && used.length >= 6 && t.ok, notes };
}
