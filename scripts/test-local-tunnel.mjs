/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// src/remote/local/tunnel.ts against a fake `cloudflared` — a child process that prints what the
// real one prints — so the arguments, the address parsing and the failure reporting are checked
// without opening a real public tunnel. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-local-tunnel.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const { Tunnel, findCloudflared, releaseAsset, installCloudflared, checkTunnelDns } = await import(new URL('../out/remote/local/tunnel.js', import.meta.url));

/** A spawner that runs a tiny node script printing `lines` to stderr, recording the args it was given. */
function fakeCloudflared(lines, { exitAfterMs } = {}) {
	const calls = [];
	const spawner = (command, args, env) => {
		calls.push({ command, args, env });
		const script = `
			for (const line of ${JSON.stringify(lines)}) { process.stderr.write(line + '\\n'); }
			${exitAfterMs === undefined ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(1), ${exitAfterMs});`}
		`;
		return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
	};
	return { spawner, calls };
}

// A quick tunnel: the random trycloudflare address is read off cloudflared's log, and an empty
// config file is passed so a ~/.cloudflared/config.yml can't block it.
{
	const fake = fakeCloudflared([
		'2026-09-23T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
		'2026-09-23T10:00:01Z INF |  https://brave-otter-lamp-quiet.trycloudflare.com                           |',
		'2026-09-23T10:00:02Z INF Registered tunnel connection connIndex=0 location=bom01 protocol=quic',
	]);
	const { tunnel, url } = Tunnel.start({ binary: 'cloudflared', localUrl: 'http://127.0.0.1:5000', configFile: 'empty.yml', spawner: fake.spawner }, () => { });
	assert.equal(await url, 'https://brave-otter-lamp-quiet.trycloudflare.com');
	assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', '--config', 'empty.yml', '--url', 'http://127.0.0.1:5000']);
	tunnel.stop();
}

// A named tunnel: run by token, ready once a connection registers, addressed by its hostname.
{
	const fake = fakeCloudflared(['2026-09-23T10:00:02Z INF Registered tunnel connection connIndex=0 location=bom01']);
	const { tunnel, url } = Tunnel.start({ binary: 'cloudflared', localUrl: 'http://127.0.0.1:8787', token: 'TOKEN', hostname: 'https://remote.example.com/', spawner: fake.spawner }, () => { });
	assert.equal(await url, 'https://remote.example.com');
	assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', 'run'], 'the token is not on the command line');
	assert.deepEqual(fake.calls[0].env, { TUNNEL_TOKEN: 'TOKEN' }, 'it is passed through the environment');
	tunnel.stop();
}

// cloudflared failing says why, in its own words, and an unasked-for exit is reported.
{
	const fake = fakeCloudflared(['2026-09-23T10:00:03Z ERR failed to request quick Tunnel: dial tcp: i/o timeout'], { exitAfterMs: 50 });
	let exited;
	const { url } = Tunnel.start({ binary: 'cloudflared', localUrl: 'http://127.0.0.1:1', spawner: fake.spawner }, code => { exited = code; });
	await assert.rejects(url, /exited \(code 1\).*failed to request quick Tunnel/);
	await new Promise(r => setTimeout(r, 50));
	assert.equal(exited, 1, 'the exit is reported so local hosting can restart the tunnel');
}

// A tunnel that never reports an address times out rather than hanging pairing forever.
{
	const fake = fakeCloudflared(['2026-09-23T10:00:04Z INF Starting tunnel']);
	const { url } = Tunnel.start({ binary: 'cloudflared', localUrl: 'http://127.0.0.1:1', spawner: fake.spawner, readyTimeoutMs: 300 }, () => { });
	await assert.rejects(url, /didn't come up within/);
}

// Finding the binary: the configured path, then our own install, then PATH.
{
	const present = new Set([path.join('store', 'cloudflared.exe'), 'C:/custom/cloudflared.exe']);
	assert.equal(findCloudflared('C:/custom/cloudflared.exe', 'store', 'win32', p => present.has(p)), 'C:/custom/cloudflared.exe');
	assert.equal(findCloudflared('', 'store', 'win32', p => present.has(p)), path.join('store', 'cloudflared.exe'));
	assert.equal(findCloudflared('', 'store', 'win32', () => false), undefined);
}

// Release assets exist for every platform Stormcoder ships on.
assert.equal(releaseAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe');
assert.equal(releaseAsset('win32', 'arm64'), 'cloudflared-windows-amd64.exe');
assert.equal(releaseAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
assert.equal(releaseAsset('linux', 'arm64'), 'cloudflared-linux-arm64');

// Downloads are checked against the SHA-256 the release publishes, and fail closed otherwise.
{
	const { createHash } = await import('node:crypto');
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const binary = Buffer.alloc(2 * 1024 * 1024, 7);
	const sha = createHash('sha256').update(binary).digest('hex');
	const url = 'https://github.com/cloudflare/cloudflared/releases/download/2099.1.0/cloudflared-windows-amd64.exe';
	const stub = (digest, body = binary) => async target => String(target).includes('api.github.com')
		? new Response(JSON.stringify({ assets: [{ name: 'cloudflared-windows-amd64.exe', browser_download_url: url, digest }] }))
		: new Response(body);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stormcoder-cf-'));
	const installed = await installCloudflared(dir, stub(`sha256:${sha}`), 'win32', 'x64');
	assert.ok(fs.existsSync(installed), 'a download matching the published checksum is installed');
	fs.rmSync(installed);

	await assert.rejects(installCloudflared(dir, stub(`sha256:${'0'.repeat(64)}`), 'win32', 'x64'), /does not match the checksum/);
	await assert.rejects(installCloudflared(dir, stub(undefined), 'win32', 'x64'), /publishes no SHA-256/);
	await assert.rejects(installCloudflared(dir, stub(`sha256:${sha}`, Buffer.alloc(2 * 1024 * 1024, 8)), 'win32', 'x64'), /does not match the checksum/);
	assert.ok(!fs.existsSync(installed), 'nothing is left behind by a refused download');
	fs.rmSync(dir, { recursive: true, force: true });

	// An error page instead of release metadata is refused too.
	await assert.rejects(
		installCloudflared('unused', async () => new Response('<html>rate limited</html>'), 'win32', 'x64'),
		/Couldn't read the cloudflared release/);
}

// DNS: the address is held until it's published, and an ISP resolver that refuses
// trycloudflare.com (seen on Reliance Jio) is detected rather than left to fail on the phone.
{
	let publicTries = 0;
	const lateButFine = await checkTunnelDns('https://a-b.trycloudflare.com', async () => ++publicTries >= 2, async () => true, 10_000);
	assert.deepEqual([lateButFine, publicTries], [{ published: true, blockedLocally: false }, 2]);
	const blocked = await checkTunnelDns('https://a-b.trycloudflare.com', async () => true, async () => false, 10_000);
	assert.deepEqual(blocked, { published: true, blockedLocally: true });
	const never = await checkTunnelDns('https://a-b.trycloudflare.com', async () => false, async () => false, 50);
	assert.equal(never.published, false, 'gives up after the wait instead of blocking pairing forever');
}

console.log('test-local-tunnel: all assertions passed');
