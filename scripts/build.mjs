// Builds the app into dist/: the Electron main and preload bundles, plus the static UI.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

fs.mkdirSync(dist, { recursive: true });

// Static files the UI loads at runtime.
for (const dir of ['media', 'shell', 'skills', 'relay-pwa', 'openvs-relay']) {
	fs.rmSync(path.join(dist, dir), { recursive: true, force: true });
	fs.cpSync(path.join(root, dir), path.join(dist, dir), { recursive: true, filter: src => !src.includes(`${path.sep}node_modules`) });
}

const common = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	sourcemap: true,
	logLevel: 'info',
	alias: { vscode: path.join(root, 'host/vscode.ts') },
	// sql.js finds its .wasm next to itself, so it stays a real package at runtime.
	external: ['electron', 'sql.js', 'ws', 'electron-updater'],
};

const builds = [
	{ ...common, entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, outdir: dist },
	{ ...common, entryPoints: { 'dev-host': 'electron/devHost.ts' }, outdir: dist },
];

for (const b of builds) {
	if (watch) {
		const ctx = await esbuild.context(b);
		await ctx.watch();
	} else {
		await esbuild.build(b);
	}
}
