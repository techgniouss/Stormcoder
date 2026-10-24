import { read } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const notes = [];
	const src = read(dir, 'packages/api/src/routes/health.js');
	if (!src) { return { pass: false, notes: ['file missing'] }; }
	const named = /export default async function handleHealth\s*\(/.test(src);
	const semis = /;/.test(src);
	const returns = /ok:\s*true/.test(src);
	if (!named) { notes.push('default export is not `async function handleHealth`'); }
	if (semis) { notes.push('uses semicolons, against packages/api/AGENTS.md'); }
	if (!returns) { notes.push('does not return { ok: true }'); }
	return { pass: named && !semis && returns, notes };
}
