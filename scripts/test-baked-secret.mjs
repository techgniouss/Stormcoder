// Antigravity's client secret: the environment wins, a value baked in at build time is the fallback,
// and with neither the error says how to fix it. The bundler's `define` is reproduced here exactly
// as scripts/build.mjs does it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-baked-'));
const stub = { workspace: { getConfiguration: () => ({ get: () => undefined }) }, env: {}, window: {}, Uri: { parse: s => s } };
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...rest); };
const { createRequire } = await import('node:module');
const load = async (name, define) => {
	const outfile = path.join(tmp, `${name}.cjs`);
	await esbuild.build({ entryPoints: [path.join(root, 'src/oauth.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], define, logLevel: 'error' });
	return createRequire(import.meta.url)(outfile);
};
const baked = (value) => ({ __ANTIGRAVITY_CLIENT_SECRET__: JSON.stringify(value) });
delete process.env.ANTIGRAVITY_CLIENT_SECRET;
try {
	// A build made with the secret works with nothing set at run time.
	const withSecret = await load('with', baked('baked-value'));
	assert.equal(withSecret.antigravityClientSecret(), 'baked-value');
	// A secret in the environment (or the user's .env) overrides it.
	process.env.ANTIGRAVITY_CLIENT_SECRET = 'from-env';
	assert.equal(withSecret.antigravityClientSecret(), 'from-env');
	delete process.env.ANTIGRAVITY_CLIENT_SECRET;
	// A build made without it (the variable was empty) fails with advice, and so does an unbundled one.
	const without = await load('without', baked(''));
	assert.throws(() => without.antigravityClientSecret(), /does not include it[\s\S]*\.env/);
	const plain = await load('plain', {});
	assert.throws(() => plain.antigravityClientSecret(), /ANTIGRAVITY_CLIENT_SECRET/);
	console.log('All baked-secret assertions passed.');
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
