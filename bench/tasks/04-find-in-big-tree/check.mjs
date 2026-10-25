import { walk, read, sha } from '../../lib/check-lib.mjs';
import path from 'node:path';
export default async function check(dir, ctx) {
	const notes = [];
	const ok = /DEFAULT_REQUEST_TIMEOUT_MS = 60000/.test(read(dir, 'src/modules/m173.js'));
	if (!ok) { notes.push('the timeout was not changed to 60000'); }
	let collateral = [];
	if (ctx.original) {
		collateral = walk(dir).filter(f => f !== 'src/modules/m173.js' && !f.startsWith('test') && read(dir, f) !== read(ctx.original, f));
		if (collateral.length) { notes.push('other files changed: ' + collateral.slice(0, 5).join(', ')); }
	}
	return { pass: ok && !collateral.length, notes };
}
