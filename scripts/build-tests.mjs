// Transpiles src/ to out/ file by file (no bundling), the layout the unit tests import from.
// Type checking is a separate step (`npm run typecheck`); the `vscode` import is left as a
// bare require so each test can stub it.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { walk(p); } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) { files.push(p); }
	}
}(path.join(root, 'src')));
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
await esbuild.build({ entryPoints: files, outdir: path.join(root, 'out'), outbase: path.join(root, 'src'), format: 'cjs', platform: 'node', target: 'node20', logLevel: 'warning' });
console.log(`transpiled ${files.length} files to out/`);
