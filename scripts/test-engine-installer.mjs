/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/engine/installer.ts: downloading and unpacking the Claude Agent SDK from an npm
// registry. A stand-in registry serves real gzip'd tarballs; nothing leaves the machine. The point of
// most tests is what a FAILED install leaves behind: it must be exactly what was there before.
//   node scripts/build-tests.mjs && node scripts/test-engine-installer.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }) } }; }
	return originalLoad(request, parent, isMain);
};

const installer = await import(new URL('../out/engine/installer.js', import.meta.url));
const { installClaudeSdk, extractTarStream, entryTarget, pickVersion, pickPlatformPackage, SDK_PACKAGE_NAME } = installer;

// --- a small tar writer, so the test needs no tar program -----------------------------------------

function octal(value, width) { return value.toString(8).padStart(width - 1, '0') + '\0'; }

function header({ name, size = 0, mode = 0o644, type = '0', prefix = '' }) {
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, 'utf8');
	block.write(octal(mode, 8), 100, 'latin1');
	block.write(octal(0, 8), 108, 'latin1');
	block.write(octal(0, 8), 116, 'latin1');
	block.write(octal(size, 12), 124, 'latin1');
	block.write(octal(0, 12), 136, 'latin1');
	block.write('        ', 148, 'latin1');
	block.write(type, 156, 'latin1');
	block.write('ustar\0', 257, 'latin1');
	block.write('00', 263, 'latin1');
	if (prefix) { block.write(prefix, 345, 155, 'utf8'); }
	let sum = 0;
	for (const byte of block) { sum += byte; }
	block.write(octal(sum, 7) + ' ', 148, 'latin1');
	return block;
}

function entry(spec, content = Buffer.alloc(0)) {
	const data = Buffer.from(content);
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header({ ...spec, size: data.length }), data, padding]);
}

function tar(entries) { return Buffer.concat([...entries, Buffer.alloc(1024)]); }

/** A tarball (gzip) of an npm-style package: everything under `package/`. */
function tarball(files, extra = []) {
	const list = [entry({ name: 'package/', type: '5', mode: 0o755 })];
	for (const [name, { content, mode }] of Object.entries(files)) {
		list.push(entry({ name: `package/${name}`, mode: mode ?? 0o644 }, content));
	}
	return zlib.gzipSync(tar([...list, ...extra]));
}

async function* inPieces(buffer, size) {
	for (let i = 0; i < buffer.length; i += size) { yield buffer.subarray(i, i + size); }
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
	} catch (err) {
		console.error(`FAIL ${name}`);
		throw err;
	}
}

// --- pure helpers ---------------------------------------------------------------------------------

await test('pickVersion: newest stable release in the series, never a prerelease or another series', () => {
	assert.equal(pickVersion(['0.3.5', '0.3.17', '0.3.9', '0.30.1', '0.4.0', '0.3.18-beta.1', '0.2.99', '1.3.5'], '0.3'), '0.3.17');
	assert.equal(pickVersion(['0.4.0'], '0.3'), undefined);
	assert.equal(pickVersion([], '0.3'), undefined);
});

await test('pickPlatformPackage: the exact build for the machine, musl only on Linux', () => {
	const optional = Object.fromEntries(['linux-x64', 'linux-arm64', 'linux-x64-musl', 'darwin-arm64', 'win32-x64'].map(p => [`${SDK_PACKAGE_NAME}-${p}`, '0.3.5']));
	assert.equal(pickPlatformPackage(optional, 'linux', 'x64', false), `${SDK_PACKAGE_NAME}-linux-x64`);
	assert.equal(pickPlatformPackage(optional, 'linux', 'x64', true), `${SDK_PACKAGE_NAME}-linux-x64-musl`);
	assert.equal(pickPlatformPackage(optional, 'darwin', 'arm64', true), `${SDK_PACKAGE_NAME}-darwin-arm64`, 'musl is a Linux notion');
	assert.equal(pickPlatformPackage(optional, 'freebsd', 'x64', false), undefined);
	assert.equal(pickPlatformPackage(optional, 'linux', 'arm64', true), undefined, 'no guessing a different build');
});

await test('a file system that fails mid-extraction is an error, not an uncaught exception', async () => {
	// A folder where a file is meant to go makes the write stream fail asynchronously, as a full disk does.
	const dest = tmp('fail-');
	fs.mkdirSync(path.join(dest, 'lib', 'x.js'), { recursive: true });
	const data = tar([entry({ name: 'package/lib/x.js' }, 'content that cannot be written'), entry({ name: 'package/after.txt' }, 'never reached')]);
	await assert.rejects(extractTarStream(inPieces(data, 300), dest), /Could not write .*x\.js/);
	assert.ok(!fs.existsSync(path.join(dest, 'after.txt')), 'extraction stopped at the failure');
	fs.rmSync(dest, { recursive: true, force: true });
});

await test('entryTarget: names that merely start with two dots stay inside', () => {
	const dest = path.join(os.tmpdir(), 'dest2');
	assert.equal(entryTarget(dest, 'package/..cache/x', 1), path.join(dest, '..cache', 'x'));
	assert.throws(() => entryTarget(dest, 'package/..', 1), /outside its folder/, 'a bare .. is still a way out');
});

await test('entryTarget: strips the wrapper, skips the folder itself, and refuses every way out', () => {
	const dest = path.join(os.tmpdir(), 'dest');
	assert.equal(entryTarget(dest, 'package/lib/a.js', 1), path.join(dest, 'lib', 'a.js'));
	assert.equal(entryTarget(dest, 'package/', 1), undefined);
	assert.equal(entryTarget(dest, 'package/./x', 1), path.join(dest, 'x'));
	for (const bad of ['package/../../evil', '../evil', '/etc/passwd', 'C:/Windows/x', 'package/a/../../../b', 'package\\..\\..\\x', '\\absolute']) {
		assert.throws(() => entryTarget(dest, bad, 1), /outside its folder/, bad);
	}
	assert.throws(() => entryTarget(dest, 'package/a\0b', 1), /invalid file name/);
});

// --- the tar extractor ----------------------------------------------------------------------------

const sample = {
	'package.json': { content: JSON.stringify({ name: 'x', version: '1.0.0' }) },
	'lib/deep/a.js': { content: 'console.log(1);\n'.repeat(100) },
	'bin/claude': { content: Buffer.alloc(3000, 7), mode: 0o755 },
	'empty.txt': { content: '' },
	'exact-block.bin': { content: Buffer.alloc(512, 1) },
};

function snapshot(dir) {
	const out = {};
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); } else { out[path.relative(dir, p).split(path.sep).join('/')] = { bytes: fs.readFileSync(p).toString('base64'), exec: !!(fs.statSync(p).mode & 0o100) }; }
		}
	}(dir));
	return out;
}

await test('extraction is identical however the stream is cut into chunks', async () => {
	const data = zlib.gunzipSync(tarball(sample));
	let reference;
	for (const size of [1, 7, 100, 511, 512, 513, 1024, 100_000]) {
		const dest = tmp('tar-');
		const result = await extractTarStream(inPieces(data, size), dest);
		assert.equal(result.files, 5, `chunk size ${size}`);
		const got = snapshot(dest);
		reference ??= got;
		assert.deepEqual(got, reference, `chunk size ${size}`);
		fs.rmSync(dest, { recursive: true, force: true });
	}
	assert.deepEqual(Object.keys(reference).sort(), ['bin/claude', 'empty.txt', 'exact-block.bin', 'lib/deep/a.js', 'package.json']);
	assert.equal(reference['bin/claude'].exec, process.platform === 'win32' ? reference['bin/claude'].exec : true, 'the executable bit survives');
	assert.equal(reference['package.json'].exec, false);
	assert.equal(Buffer.from(reference['lib/deep/a.js'].bytes, 'base64').length, 1600);
});

await test('long names: pax and GNU headers both work, and ustar prefixes join', async () => {
	const long = 'package/' + 'very-long-directory-name/'.repeat(8) + 'file.txt';
	const pax = Buffer.from(`${String(`${' path='.length + long.length + 3}`).length} `, 'latin1');
	const record = (key, value) => { const body = ` ${key}=${value}\n`; let len = body.length + 1; while (String(len).length + body.length !== len) { len = String(len).length + body.length; } return `${len}${body}`; };
	const paxData = Buffer.from(record('path', long));
	const gnu = Buffer.concat([Buffer.from(long), Buffer.from([0])]);
	for (const [label, entries] of [
		['pax', [entry({ name: 'package/PaxHeader', type: 'x' }, paxData), entry({ name: 'ignored-short-name' }, 'long-pax')]],
		['gnu', [entry({ name: '././@LongLink', type: 'L' }, gnu), entry({ name: 'ignored-short-name' }, 'long-gnu')]],
		['ustar prefix', [entry({ name: 'file.txt', prefix: 'package/' + 'very-long-directory-name/'.repeat(8).slice(0, -1) }, 'long-prefix')]],
	]) {
		const dest = tmp('long-');
		await extractTarStream(inPieces(tar(entries), 100), dest);
		const found = snapshot(dest);
		assert.equal(Object.keys(found).length, 1, label);
		assert.ok(Object.keys(found)[0].endsWith('file.txt'), `${label}: ${Object.keys(found)[0]}`);
		fs.rmSync(dest, { recursive: true, force: true });
	}
	void pax;
});

await test('links and special entries are skipped, never created', async () => {
	const dest = tmp('links-');
	await extractTarStream(inPieces(tar([
		entry({ name: 'package/ok.txt' }, 'fine'),
		entry({ name: 'package/link', type: '2' }),
		entry({ name: 'package/hard', type: '1' }),
		entry({ name: 'package/dev', type: '3' }),
		entry({ name: 'package/also-ok.txt' }, 'fine too'),
	]), 300), dest);
	assert.deepEqual(Object.keys(snapshot(dest)).sort(), ['also-ok.txt', 'ok.txt']);
	assert.ok(!fs.existsSync(path.join(dest, 'link')));
	fs.rmSync(dest, { recursive: true, force: true });
});

await test('a traversal entry aborts the extraction and writes nothing outside', async () => {
	const parent = tmp('trav-');
	const dest = path.join(parent, 'dest');
	fs.mkdirSync(dest);
	await assert.rejects(extractTarStream(inPieces(tar([
		entry({ name: 'package/fine.txt' }, 'ok'),
		entry({ name: 'package/../../escaped.txt' }, 'bad'),
	]), 512), dest), /outside its folder/);
	assert.ok(!fs.existsSync(path.join(parent, 'escaped.txt')));
	assert.ok(!fs.existsSync(path.join(dest, '..', '..', 'escaped.txt')));
	fs.rmSync(parent, { recursive: true, force: true });
});

await test('corrupt and truncated archives are rejected', async () => {
	const good = zlib.gunzipSync(tarball(sample));
	const flipped = Buffer.from(good);
	flipped[10] ^= 0xff; // inside the first header's name: the checksum no longer matches
	await assert.rejects(extractTarStream(inPieces(flipped, 4096), tmp('bad-')), /corrupt/);
	await assert.rejects(extractTarStream(inPieces(good.subarray(0, 1300), 4096), tmp('cut-')), /incomplete/);
	await assert.rejects(extractTarStream(inPieces(good.subarray(0, 700), 64), tmp('cut2-')), /incomplete/);
});

await test('an archive that expands past the limit is refused', async () => {
	const dest = tmp('big-');
	await assert.rejects(extractTarStream(inPieces(tar([entry({ name: 'package/a' }, Buffer.alloc(5000))]), 1000), dest, { maxBytes: 4000 }), /more than the allowed size/);
	fs.rmSync(dest, { recursive: true, force: true });
});

// --- the install, against a stand-in registry ----------------------------------------------------

const platformName = `${SDK_PACKAGE_NAME}-${process.platform}-${process.arch}`;
const sdkFiles = version => ({
	'package.json': { content: JSON.stringify({ name: SDK_PACKAGE_NAME, version, type: 'module', exports: { '.': { default: './sdk.mjs' } } }) },
	'sdk.mjs': { content: `export const query = () => 'sdk ${version}';\n` },
});
const binaryFiles = { 'package.json': { content: JSON.stringify({ name: platformName, version: '0.3.17' }) }, claude: { content: Buffer.alloc(4096, 9), mode: 0o755 } };

/** Starts a registry. `faults` change what it serves. */
async function registry(faults = {}) {
	const sdkTgz = tarball(sdkFiles('0.3.17'));
	const binTgz = tarball(binaryFiles);
	const sri = buf => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url);
		const base = `http://127.0.0.1:${server.address().port}`;
		const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
		if (req.url === '/@anthropic-ai%2Fclaude-agent-sdk') {
			return json({
				versions: {
					'0.3.5': { dist: { tarball: `${base}/old.tgz`, integrity: 'sha512-x' } },
					'0.3.17': {
						dist: { tarball: `${base}/sdk.tgz`, ...(faults.noChecksum ? {} : { integrity: faults.badChecksum ? sri(Buffer.from('other')) : sri(sdkTgz) }) },
						optionalDependencies: { [platformName]: '0.3.17' },
					},
					'0.3.18-beta.1': { dist: { tarball: `${base}/beta.tgz` } },
				},
			});
		}
		if (req.url === `/${platformName.replace('/', '%2F')}/0.3.17`) {
			return json({ dist: { tarball: `${base}/bin.tgz`, shasum: faults.shasumOnly ? crypto.createHash('sha1').update(binTgz).digest('hex') : undefined, integrity: faults.shasumOnly ? undefined : sri(binTgz) } });
		}
		if (req.url === '/sdk.tgz') {
			if (faults.cutSdk) { res.writeHead(200, { 'content-length': sdkTgz.length }); res.write(sdkTgz.subarray(0, 100)); setTimeout(() => res.destroy(), 20); return; }
			if (faults.slow) { return; } // never answers
			res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': sdkTgz.length });
			return res.end(sdkTgz);
		}
		if (req.url === '/bin.tgz') {
			res.writeHead(200, { 'content-length': binTgz.length });
			return res.end(binTgz);
		}
		res.writeHead(404); res.end();
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function leftovers(dir) { return fs.readdirSync(dir).filter(n => n.startsWith('.staging') || n.startsWith('.previous')); }

await test('a clean install: the newest 0.3.x, the right platform build, executable, recorded', async () => {
	const reg = await registry();
	const dir = tmp('install-');
	const progress = [];
	const result = await installClaudeSdk({ dir, registry: reg.url, onProgress: m => progress.push(m), musl: false });
	assert.equal(result.version, '0.3.17', 'not the older 0.3.5 and not the prerelease');
	assert.equal(result.platformPackage, platformName);
	const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	assert.equal(JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version, '0.3.17');
	assert.ok(fs.existsSync(path.join(sdk, 'sdk.mjs')));
	const binary = path.join(dir, 'node_modules', ...platformName.split('/'), 'claude');
	assert.equal(fs.statSync(binary).size, 4096);
	if (process.platform !== 'win32') { assert.ok(fs.statSync(binary).mode & 0o100, 'the engine binary is executable'); }
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')).version, '0.3.17');
	assert.deepEqual(leftovers(dir), [], 'no staging or backup folders left');
	assert.ok(progress.some(m => /Downloading Claude Agent SDK 0\.3\.17/.test(m)));
	assert.ok(progress.at(-1).startsWith('Installed'));
	// What a real run does next: find and load it.
	const mod = await import(`file://${path.join(sdk, 'sdk.mjs')}`);
	assert.equal(mod.query(), 'sdk 0.3.17');
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('a checksum mismatch installs nothing and leaves a working install untouched', async () => {
	const dir = tmp('mismatch-');
	const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	fs.mkdirSync(sdk, { recursive: true });
	fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: SDK_PACKAGE_NAME, version: '0.3.1' }));
	fs.writeFileSync(path.join(sdk, 'sdk.mjs'), 'OLD');
	const reg = await registry({ badChecksum: true });
	await assert.rejects(installClaudeSdk({ dir, registry: reg.url, musl: false }), /did not match the checksum/);
	assert.equal(fs.readFileSync(path.join(sdk, 'sdk.mjs'), 'utf8'), 'OLD');
	assert.deepEqual(leftovers(dir), []);
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('a connection that drops mid-download installs nothing and leaves the old install', async () => {
	const dir = tmp('cut-');
	const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	fs.mkdirSync(sdk, { recursive: true });
	fs.writeFileSync(path.join(sdk, 'sdk.mjs'), 'OLD');
	const reg = await registry({ cutSdk: true });
	await assert.rejects(installClaudeSdk({ dir, registry: reg.url, musl: false }));
	assert.equal(fs.readFileSync(path.join(sdk, 'sdk.mjs'), 'utf8'), 'OLD');
	assert.deepEqual(leftovers(dir), []);
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('an update replaces the old install completely', async () => {
	const dir = tmp('update-');
	const sdk = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	fs.mkdirSync(sdk, { recursive: true });
	fs.writeFileSync(path.join(sdk, 'stale-file.txt'), 'from the old version');
	const reg = await registry();
	await installClaudeSdk({ dir, registry: reg.url, musl: false });
	assert.ok(!fs.existsSync(path.join(sdk, 'stale-file.txt')), 'nothing of the old version lingers');
	assert.ok(fs.existsSync(path.join(sdk, 'sdk.mjs')));
	assert.deepEqual(leftovers(dir), []);
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('a package with no published checksum is refused; a sha1 checksum alone is accepted', async () => {
	const dir = tmp('nosum-');
	const noSum = await registry({ noChecksum: true });
	await assert.rejects(installClaudeSdk({ dir, registry: noSum.url, musl: false }), /no checksum/);
	assert.deepEqual(leftovers(dir), []);
	noSum.close();
	const sha1 = await registry({ shasumOnly: true });
	assert.equal((await installClaudeSdk({ dir, registry: sha1.url, musl: false })).version, '0.3.17');
	sha1.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('a platform with no build gets a clear message and no download', async () => {
	const reg = await registry();
	const dir = tmp('plat-');
	await assert.rejects(installClaudeSdk({ dir, registry: reg.url, platform: 'freebsd', arch: 'x64' }), /no build for freebsd on x64/);
	assert.ok(!reg.requests.some(r => r.endsWith('.tgz')));
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('no release in the tested series is a clear message', async () => {
	const reg = await registry();
	const dir = tmp('series-');
	await assert.rejects(installClaudeSdk({ dir, registry: reg.url, series: '9.9', musl: false }), /No 9\.9\.x release/);
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('registry addresses must be https, except on this machine', async () => {
	const dir = tmp('sec-');
	await assert.rejects(installClaudeSdk({ dir, registry: 'http://registry.example.com' }), /over https/);
	await assert.rejects(installClaudeSdk({ dir, registry: 'ftp://registry.example.com' }), /over https/);
	await assert.rejects(installClaudeSdk({ dir, registry: 'not a url' }), /not a valid registry/);
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('an unreachable registry and an error status are explained, not raw', async () => {
	const dir = tmp('down-');
	await assert.rejects(installClaudeSdk({ dir, registry: 'http://127.0.0.1:1' }), /Could not reach the package registry/);
	const reg = await registry();
	const fake = async (url, init) => (String(url).endsWith('claude-agent-sdk') ? new Response('nope', { status: 503 }) : fetch(url, init));
	await assert.rejects(installClaudeSdk({ dir, registry: reg.url, fetchImpl: fake }), /answered 503/);
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('cancelling stops the install and leaves nothing behind', async () => {
	const reg = await registry({ slow: true });
	const dir = tmp('cancel-');
	const controller = new AbortController();
	const pending = installClaudeSdk({ dir, registry: reg.url, signal: controller.signal, musl: false });
	setTimeout(() => controller.abort(), 150);
	await assert.rejects(pending);
	assert.deepEqual(leftovers(dir), []);
	assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

await test('two installs started together share one run', async () => {
	const reg = await registry();
	const dir = tmp('twice-');
	const [a, b] = await Promise.all([installClaudeSdk({ dir, registry: reg.url, musl: false }), installClaudeSdk({ dir, registry: reg.url, musl: false })]);
	assert.equal(a, b);
	assert.equal(reg.requests.filter(r => r === '/sdk.tgz').length, 1, 'downloaded once');
	reg.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

void Readable;
console.log(`engine installer: ${passed} tests, all assertions passed`);
