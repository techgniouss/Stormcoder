import { walk, read } from '../../lib/check-lib.mjs';
export default async function check(dir, ctx) {
	const notes = [];
	const changed = ctx.original ? walk(dir).filter(f => read(dir, f) !== read(ctx.original, f)) : [];
	if (changed.length) { notes.push('files changed: ' + changed.join(', ')); }
	const a = ctx.answer ?? '';
	const attempts = /\b(3|three)\b/i.test(a);
	const rethrow = /(re-?throw|throws?|raises?)[^.]*(last|final)|last (error|exception)|(last|final)[^.]*(error|exception)/i.test(a);
	if (!attempts) { notes.push('answer does not mention the 3 attempts'); }
	if (!rethrow) { notes.push('answer does not say the last error is rethrown'); }
	return { pass: !changed.length && attempts && rethrow, notes };
}
