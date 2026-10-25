// Reference fix: the one-line change the task asks for.
import fs from 'node:fs';
import path from 'node:path';
export default function solve(dir) {
	const file = path.join(dir, 'src/big.js');
	fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("export function f0450() { return 'alpha'; }", "export function f0450() { return 'beta'; }"));
}
