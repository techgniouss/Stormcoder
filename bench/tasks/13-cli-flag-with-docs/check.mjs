import { sh, read, walk } from '../../lib/check-lib.mjs';
export default async function check(dir) {
	const notes = [];
	const out = sh(dir, 'node cli.js --json 2 3');
	const json = out.ok && out.out.trim() === '{"sum":5}';
	if (!json) { notes.push('--json output wrong: ' + out.out.trim().slice(0, 80)); }
	const plain = sh(dir, 'node cli.js 2 3');
	if (!(plain.ok && /sum: 5/.test(plain.out))) { notes.push('plain output broke'); }
	if (!/--json/.test(read(dir, 'README.md'))) { notes.push('README does not mention --json'); }
	const tests = walk(dir).filter(f => /\.test\.js$/.test(f) && /--json/.test(read(dir, f)));
	if (!tests.length) { notes.push('no test covers --json'); }
	const t = sh(dir, 'node --test');
	if (!t.ok) { notes.push('tests failing'); }
	return { pass: !notes.length, notes };
}
