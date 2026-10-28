// The update service: background download, ready/install, manual checks, and the fallback for
// installs that cannot replace themselves. A fake backend stands in for electron-updater.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-updater-'));
await esbuild.build({ entryPoints: [path.join(root, 'host/updater.ts')], outfile: path.join(tmp, 'updater.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const { createRequire } = await import('node:module');
const { UpdateService, compareVersions } = createRequire(import.meta.url)(path.join(tmp, 'updater.cjs'));

/** A stand-in for `autoUpdater`: `script` runs inside checkForUpdates and may emit events or throw. */
function fakeBackend(script) {
	const listeners = {};
	const calls = { checks: 0, installs: [] };
	const backend = {
		autoDownload: false, autoInstallOnAppQuit: false,
		on(event, l) { (listeners[event] ??= []).push(l); },
		emit(event, ...args) { (listeners[event] ?? []).forEach(l => l(...args)); },
		async checkForUpdates() { calls.checks++; await script(backend); },
		quitAndInstall(...args) { calls.installs.push(args); },
	};
	return { backend, calls };
}
const make = (script, extra = {}) => {
	const fake = fakeBackend(script);
	const log = [];
	const service = new UpdateService({ backend: async () => fake.backend, version: '1.3.6', canSelfUpdate: true, repo: 'o/r', initialDelayMs: 0, log: (l, m) => log.push(`${l}: ${m}`), ...extra });
	const seen = [];
	service.onChange(s => seen.push(s.status));
	return { service, fake, seen, log };
};

try {
	// Versions order numerically, and a pre-release sorts below its release.
	assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
	assert.equal(compareVersions('v1.3.6', '1.3.6'), 0);
	assert.equal(compareVersions('1.3.6-beta.1', '1.3.6'), -1);
	assert.equal(compareVersions('1.3', '1.3.1'), -1);

	// A newer release downloads by itself, reports progress, and waits to be installed.
	{
		const { service, fake, seen } = make(async b => {
			b.emit('update-available', { version: '1.4.0' });
			b.emit('download-progress', { percent: 41.6 });
			b.emit('update-downloaded', { version: '1.4.0' });
		});
		await service.check(false);
		assert.deepEqual(seen, ['checking', 'downloading', 'downloading', 'ready']);
		assert.equal(fake.backend.autoDownload, true);
		assert.equal(fake.backend.autoInstallOnAppQuit, true);
		const s = service.state();
		assert.equal(s.status, 'ready');
		assert.equal(s.version, '1.4.0');
		assert.equal(s.percent, 100);
		assert.equal(s.manual, false);
		assert.equal(s.releaseUrl, 'https://github.com/o/r/releases/tag/v1.4.0');
		// Checking again while an update waits does not ask GitHub again.
		await service.check(true);
		assert.equal(fake.calls.checks, 1);
		assert.equal(service.state().status, 'ready');
		assert.equal(service.state().manual, true);
		await service.install();
		assert.deepEqual(fake.calls.installs, [[false, true]]);
	}

	// install() is a no-op unless something is ready, and runs beforeInstall first.
	{
		const order = [];
		const { service, fake } = make(async b => { b.emit('update-not-available'); }, { beforeInstall: async () => { order.push('shutdown'); } });
		await service.check(true);
		await service.install();
		assert.deepEqual(fake.calls.installs, []);
		const again = make(async b => { b.emit('update-downloaded', { version: '2.0.0' }); }, { beforeInstall: async () => { order.push('shutdown'); } });
		again.fake.backend.quitAndInstall = () => order.push('install');
		await again.service.check(false);
		await again.service.install();
		assert.deepEqual(order, ['shutdown', 'install']);
	}

	// A manual check that finds nothing says so; a background one stays quiet (manual is false).
	{
		const manual = make(async b => { b.emit('update-not-available'); });
		await manual.service.check(true);
		assert.equal(manual.service.state().status, 'uptodate');
		assert.equal(manual.service.state().manual, true);
		const background = make(async b => { b.emit('update-not-available'); });
		await background.service.check(false);
		assert.equal(background.service.state().manual, false);
	}

	// A failed check is an error once, even though the backend both emits and rejects.
	{
		const { service, log } = make(async b => { const err = new Error('net down'); b.emit('error', err); throw err; });
		await service.check(true);
		assert.equal(service.state().status, 'error');
		assert.equal(service.state().error, 'net down');
		assert.equal(log.length, 1);
		// The next check can still succeed.
	}

	// A download that fails after a version was found falls back to the release page.
	{
		const { service } = make(async b => { b.emit('update-available', { version: '1.5.0' }); b.emit('error', new Error('signature mismatch')); });
		await service.check(false);
		const s = service.state();
		assert.equal(s.status, 'available');
		assert.equal(s.version, '1.5.0');
		assert.match(s.releaseUrl, /releases/);
	}

	// An install that cannot update itself still learns about newer releases from GitHub.
	{
		const newer = make(async () => { throw new Error('must not be used'); }, { canSelfUpdate: false, latestRelease: async () => ({ version: '1.4.0', url: 'https://github.com/o/r/releases/tag/v1.4.0' }) });
		await newer.service.check(true);
		assert.equal(newer.service.state().status, 'available');
		assert.equal(newer.service.state().version, '1.4.0');
		assert.equal(newer.fake.calls.checks, 0);
		const same = make(async () => undefined, { canSelfUpdate: false, latestRelease: async () => ({ version: '1.3.6', url: 'x' }) });
		await same.service.check(true);
		assert.equal(same.service.state().status, 'uptodate');
		const broken = make(async () => undefined, { canSelfUpdate: false, latestRelease: async () => { throw new Error('GitHub answered 403'); } });
		await broken.service.check(true);
		assert.equal(broken.service.state().status, 'error');
	}

	// Overlapping checks share one run.
	{
		let release;
		const { service, fake } = make(async b => { await new Promise(r => { release = r; }); b.emit('update-not-available'); });
		const a = service.check(false);
		const b = service.check(true);
		await new Promise(r => setTimeout(r, 10));
		release();
		await Promise.all([a, b]);
		assert.equal(fake.calls.checks, 1);
	}

	// The background schedule checks once after its delay and stops when asked.
	{
		const { service, fake } = make(async b => { b.emit('update-not-available'); }, { initialDelayMs: 20, intervalMs: 0 });
		service.start();
		await new Promise(r => setTimeout(r, 120));
		assert.equal(fake.calls.checks, 1);
		service.stop();
	}
	console.log('All updater assertions passed.');
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
