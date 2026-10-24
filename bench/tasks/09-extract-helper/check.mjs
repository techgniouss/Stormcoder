import { sh, read, walk } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const notes = [];
	const key = read(dir, 'src/key.js');
	if (!/export (function makeKey|const makeKey)/.test(key)) { notes.push('src/key.js does not export makeKey'); }
	const users = ['cart', 'wishlist', 'compare'].filter(n => /import[^;]*makeKey[^;]*key\.js/.test(read(dir, `src/${n}.js`)));
	if (users.length !== 3) { notes.push('makeKey used by ' + users.length + '/3 files'); }
	const dup = walk(dir).filter(f => f.startsWith('src') && f !== 'src/key.js' && /\+ ':' \+ /.test(read(dir, f)));
	if (dup.length) { notes.push('inline expression remains in ' + dup.join(', ')); }
	const t = sh(dir, 'node --test');
	if (!t.ok) { notes.push('tests failing'); }
	return { pass: !notes.length, notes };
}
