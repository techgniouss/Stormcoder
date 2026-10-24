import fs from 'node:fs';
import path from 'node:path';
export default function setup(dir) {
	const lines = [];
	for (let i = 1; i <= 900; i++) { const n = String(i).padStart(4, '0'); lines.push(`/** Helper number ${i}. */`, `export function f${n}() { return 'alpha'; }`, ''); }
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src/big.js'), lines.join('\n'));
}
