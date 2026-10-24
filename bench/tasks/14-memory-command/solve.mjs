import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The reference fix: clamp added, and the real check run so its marker matches the final file. */
export default async function solve(dir) {
	const file = path.join(dir, 'src/math.js');
	const text = fs.readFileSync(file, 'utf8').replace('module.exports = { add, sub };', 'function clamp(n, lo, hi) {\n\treturn Math.min(Math.max(n, lo), hi);\n}\n\nmodule.exports = { add, sub, clamp };');
	fs.writeFileSync(file, text);
	execFileSync(process.execPath, ['scripts/check.js'], { cwd: dir, stdio: 'ignore' });
}
