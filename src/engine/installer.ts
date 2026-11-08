/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream';
import * as zlib from 'zlib';
import { TESTED_SDK_SERIES } from './sdkVersion';

/**
 * Installs the Claude Agent SDK into the app's own data folder, from the npm registry, without npm.
 *
 * The SDK is not bundled with Stormcoder (its licence is not ours to redistribute), so a user who
 * selects the Claude Code engine needs it on disk. This puts it there at the user's request, and keeps
 * it out of the app's installer. It is two packages: the SDK itself and the platform build of the
 * native `claude` binary it runs.
 *
 * Safe by construction: every download is checked against the integrity hash the registry publishes
 * for it, extraction refuses anything that would land outside its folder, and the new install is
 * built beside the old one and swapped in only once complete, so a failure at any point leaves a
 * working install exactly as it was.
 */

/** The SDK's package name. */
export const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** The largest package accepted (compressed). The native binary is the big one. */
const MAX_DOWNLOAD_BYTES = 700 * 1024 * 1024;

/** The most a package may expand to. */
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

const TAR_BLOCK = 512;

/** Options for {@link installClaudeSdk}. */
export interface InstallOptions {
	/** The folder to install into; the SDK ends up under `<dir>/node_modules`. */
	readonly dir: string;
	/** Registry base URL. https only, except a loopback address (tests). */
	readonly registry?: string;
	/** `major.minor` of the version to install. Defaults to the series this integration was tested with. */
	readonly series?: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	/** Whether the Linux libc is musl; detected when absent. */
	readonly musl?: boolean;
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
}

/** What was installed. */
export interface InstallResult {
	readonly version: string;
	readonly platformPackage: string;
	readonly dir: string;
}

/** The newest stable version in `series` (`0.3` matches `0.3.17`, not `0.30.1` or `0.3.1-beta`). */
export function pickVersion(versions: readonly string[], series: string): string | undefined {
	const matches = versions
		.filter(v => /^\d+\.\d+\.\d+$/.test(v) && v.startsWith(`${series}.`))
		.map(v => ({ v, patch: Number(v.slice(series.length + 1)) }))
		.sort((a, b) => b.patch - a.patch);
	return matches[0]?.v;
}

/** The name of the platform build among the SDK's optional dependencies, or undefined when there is none. */
export function pickPlatformPackage(
	optionalDependencies: Readonly<Record<string, string>>, platform: NodeJS.Platform, arch: string, musl: boolean,
): string | undefined {
	const wanted = `${SDK_PACKAGE_NAME}-${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
	return Object.keys(optionalDependencies).find(name => name === wanted);
}

/** Whether this machine's Linux libc is musl (Alpine). Anywhere else, or if unsure, false. */
export function detectMusl(): boolean {
	if (process.platform !== 'linux') {
		return false;
	}
	try {
		const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
		return header !== undefined && !header.glibcVersionRuntime;
	} catch {
		return false;
	}
}

/** Ends a write stream and waits until it is closed, even if it already failed. */
function closeStream(stream: fs.WriteStream): Promise<void> {
	return new Promise(resolve => {
		if (stream.destroyed || stream.closed) {
			resolve();
			return;
		}
		stream.once('close', () => resolve());
		stream.end();
	});
}

/** Waits until a stream can take more data, or has closed (after a failure it never will). */
function drainedOrClosed(stream: fs.WriteStream): Promise<void> {
	return new Promise(resolve => {
		const done = (): void => { stream.off('drain', done); stream.off('close', done); resolve(); };
		stream.once('drain', done);
		stream.once('close', done);
	});
}

/** Throws unless the registry address is https (or http on this machine, for tests). */
function assertSecureRegistry(registry: string): void {
	let url: URL;
	try {
		url = new URL(registry);
	} catch {
		throw new Error(`"${registry}" is not a valid registry address.`);
	}
	const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new Error('The package registry must be reached over https.');
	}
}

/** Where a package's files go below `node_modules`. */
function packageFolder(root: string, name: string): string {
	return path.join(root, 'node_modules', ...name.split('/'));
}

interface Dist {
	readonly tarball?: string;
	readonly integrity?: string;
	readonly shasum?: string;
}

async function getJson<T>(url: string, doFetch: typeof fetch, signal: AbortSignal | undefined, accept: string): Promise<T> {
	let response: Response;
	try {
		response = await doFetch(url, { headers: { accept }, signal });
	} catch (err) {
		throw new Error(`Could not reach the package registry (${err instanceof Error ? err.message : String(err)}). Check your connection and try again.`);
	}
	if (!response.ok) {
		throw new Error(`The package registry answered ${response.status} for ${new URL(url).pathname}.`);
	}
	return await response.json() as T;
}

/** The expected hash of a download, as the registry gives it. */
function expectedHash(dist: Dist): { algorithm: 'sha512' | 'sha1'; digest: string; encoding: 'base64' | 'hex' } {
	const sha512 = dist.integrity?.split(/\s+/).find(entry => entry.startsWith('sha512-'));
	if (sha512) {
		return { algorithm: 'sha512', digest: sha512.slice('sha512-'.length), encoding: 'base64' };
	}
	if (dist.shasum) {
		return { algorithm: 'sha1', digest: dist.shasum.toLowerCase(), encoding: 'hex' };
	}
	throw new Error('The registry published no checksum for this package, so it was not installed.');
}

/** Downloads `url` to `file`, checking its hash and size as it arrives. */
async function download(
	url: string, file: string, dist: Dist, doFetch: typeof fetch, signal: AbortSignal | undefined,
	onProgress: ((message: string) => void) | undefined, label: string,
): Promise<void> {
	const expected = expectedHash(dist);
	let response: Response;
	try {
		response = await doFetch(url, { signal });
	} catch (err) {
		throw new Error(`Could not download ${label} (${err instanceof Error ? err.message : String(err)}).`);
	}
	if (!response.ok || !response.body) {
		throw new Error(`Downloading ${label} failed: the registry answered ${response.status}.`);
	}
	const total = Number(response.headers.get('content-length') ?? 0);
	if (total > MAX_DOWNLOAD_BYTES) {
		throw new Error(`${label} is larger than ${Math.round(MAX_DOWNLOAD_BYTES / 1_048_576)} MB, so it was not downloaded.`);
	}
	const hash = crypto.createHash(expected.algorithm);
	const out = fs.createWriteStream(file);
	// A listener that is always there: a full disk fails the stream at any moment, and an 'error' event
	// with no listener would be an uncaught exception in the app.
	let writeError: Error | undefined;
	out.on('error', err => { writeError = err; });
	let received = 0;
	let reported = 0;
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			if (writeError) {
				throw writeError;
			}
			received += chunk.length;
			if (received > MAX_DOWNLOAD_BYTES) {
				throw new Error(`${label} is larger than ${Math.round(MAX_DOWNLOAD_BYTES / 1_048_576)} MB, so the download was stopped.`);
			}
			hash.update(chunk);
			if (!out.write(chunk)) {
				await drainedOrClosed(out);
			}
			if (received - reported > 8 * 1_048_576) {
				reported = received;
				onProgress?.(`Downloading ${label}… ${Math.round(received / 1_048_576)} MB${total ? ` of ${Math.round(total / 1_048_576)}` : ''}`);
			}
		}
	} finally {
		await closeStream(out);
	}
	if (writeError) {
		throw new Error(`Could not save ${label} (${(writeError as Error).message}). Check the free space in Stormcoder's data folder.`);
	}
	if (hash.digest(expected.encoding) !== expected.digest) {
		throw new Error(`${label} did not match the checksum the registry published for it, so it was not installed.`);
	}
}

// --- tar ---------------------------------------------------------------------------------------

/** Parses a tar number: octal text, or base-256 for a value too large for octal. */
function tarNumber(field: Buffer): number {
	if (field[0] & 0x80) {
		let value = field[0] & 0x7f;
		for (let i = 1; i < field.length; i++) {
			value = value * 256 + field[i];
		}
		return value;
	}
	const text = field.toString('latin1').replace(/\0.*$/, '').trim();
	return text ? parseInt(text, 8) : 0;
}

/** A NUL-terminated string field. */
function tarString(field: Buffer): string {
	const end = field.indexOf(0);
	return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

/** The `path` record of a pax header. */
function paxPath(data: Buffer): string | undefined {
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space < 0) {
			return undefined;
		}
		const length = parseInt(data.subarray(offset, space).toString('latin1'), 10);
		if (!Number.isFinite(length) || length <= 0) {
			return undefined;
		}
		const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
		const equals = record.indexOf('=');
		if (equals > 0 && record.slice(0, equals) === 'path') {
			return record.slice(equals + 1);
		}
		offset += length;
	}
	return undefined;
}

/**
 * The path an archive entry is written to, or undefined when it should be skipped. Throws for an
 * entry that would land outside `dest`: that is an attack, not a quirk, and nothing is installed.
 */
export function entryTarget(dest: string, name: string, strip: number): string | undefined {
	if (name.includes('\0')) {
		throw new Error('The package contains an invalid file name.');
	}
	const segments = name.split('/').filter(segment => segment && segment !== '.');
	// Both separators count: an entry named `a\..\..\x` is a traversal on Windows.
	if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
		throw new Error(`The package contains a file outside its folder ("${name}"), so it was not installed.`);
	}
	const kept = segments.slice(strip);
	if (!kept.length) {
		return undefined;
	}
	const target = path.join(dest, ...kept);
	const relative = path.relative(dest, target);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`The package contains a file outside its folder ("${name}"), so it was not installed.`);
	}
	return target;
}

/** The sink for one regular file being written. */
interface FileSink {
	readonly stream: fs.WriteStream;
	/** Set by a listener that is always attached, so a failing disk is an error here, never an uncaught one. */
	error?: Error;
	left: number;
	readonly padding: number;
	readonly target: string;
	readonly executable: boolean;
}

/**
 * Extracts a tar stream (already decompressed) into `dest`, dropping the first `strip` path
 * components of each entry (npm packages wrap everything in `package/`). Streaming and bounded:
 * memory stays near one chunk however large the archive. Regular files and directories only; links
 * and device entries are skipped. Handles pax and GNU long names. The stream may be cut into chunks
 * anywhere.
 */
export async function extractTarStream(
	chunks: AsyncIterable<Uint8Array>, dest: string, options: { strip?: number; maxBytes?: number } = {},
): Promise<{ files: number; bytes: number }> {
	const strip = options.strip ?? 1;
	const maxBytes = options.maxBytes ?? MAX_EXTRACTED_BYTES;
	let pending: Buffer = Buffer.alloc(0);
	let sink: FileSink | undefined;
	let discard = 0;
	let meta: { kind: 'pax' | 'long'; left: number; padding: number; parts: Buffer[] } | undefined;
	let nextName: string | undefined;
	let files = 0;
	let bytes = 0;
	let finished = false;

	const finishSink = async (): Promise<void> => {
		if (!sink) { return; }
		const done = sink;
		sink = undefined;
		await closeStream(done.stream);
		if (done.error) {
			throw new Error(`Could not write ${done.target} (${done.error.message}). Check the free space in Stormcoder's data folder.`);
		}
		fs.chmodSync(done.target, done.executable ? 0o755 : 0o644);
		files++;
	};

	try {
		for await (const chunk of chunks) {
			pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
			for (;;) {
				if (finished) {
					pending = Buffer.alloc(0);
					break;
				}
				if (discard > 0) {
					const n = Math.min(discard, pending.length);
					pending = pending.subarray(n);
					discard -= n;
					if (discard > 0) { break; }
					continue;
				}
				if (sink) {
					const n = Math.min(sink.left, pending.length);
					if (n > 0) {
						const piece = pending.subarray(0, n);
						if (sink.error) {
							throw sink.error;
						}
						if (!sink.stream.write(piece)) {
							await drainedOrClosed(sink.stream);
							if (sink.error) {
								throw sink.error;
							}
						}
						pending = pending.subarray(n);
						sink.left -= n;
					}
					if (sink.left > 0) { break; }
					discard = sink.padding;
					await finishSink();
					continue;
				}
				if (meta) {
					const n = Math.min(meta.left, pending.length);
					if (n > 0) {
						meta.parts.push(Buffer.from(pending.subarray(0, n)));
						pending = pending.subarray(n);
						meta.left -= n;
					}
					if (meta.left > 0) { break; }
					const data = Buffer.concat(meta.parts);
					nextName = meta.kind === 'pax' ? paxPath(data) ?? nextName : tarString(data);
					discard = meta.padding;
					meta = undefined;
					continue;
				}
				if (pending.length < TAR_BLOCK) { break; }

				const header = pending.subarray(0, TAR_BLOCK);
				pending = pending.subarray(TAR_BLOCK);
				if (header.every(byte => byte === 0)) {
					finished = true; // the end-of-archive marker
					continue;
				}
				let checksum = 0;
				for (let i = 0; i < TAR_BLOCK; i++) {
					checksum += i >= 148 && i < 156 ? 0x20 : header[i];
				}
				if (checksum !== tarNumber(header.subarray(148, 156))) {
					throw new Error('The downloaded package is corrupt (bad archive header), so it was not installed.');
				}
				const size = tarNumber(header.subarray(124, 136));
				const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
				const type = String.fromCharCode(header[156] || 0x30);
				const mode = tarNumber(header.subarray(100, 108));
				const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? tarString(header.subarray(345, 500)) : '';
				const own = tarString(header.subarray(0, 100));
				const name = nextName ?? (prefix ? `${prefix}/${own}` : own);

				if (type === 'x') {
					meta = { kind: 'pax', left: size, padding, parts: [] };
					continue;
				}
				if (type === 'L') {
					meta = { kind: 'long', left: size, padding, parts: [] };
					continue;
				}
				nextName = undefined;
				if (type === '5') {
					const dir = entryTarget(dest, name, strip);
					if (dir) { fs.mkdirSync(dir, { recursive: true }); }
					continue;
				}
				if (type !== '0') {
					discard = size + padding; // links, devices, global headers: not extracted
					continue;
				}
				bytes += size;
				if (bytes > maxBytes) {
					throw new Error('The downloaded package expands to more than the allowed size, so it was not installed.');
				}
				const target = entryTarget(dest, name, strip);
				if (!target) {
					discard = size + padding;
					continue;
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				if (size === 0) {
					fs.writeFileSync(target, '');
					fs.chmodSync(target, mode & 0o111 ? 0o755 : 0o644);
					files++;
					discard = padding;
					continue;
				}
				const created: FileSink = { stream: fs.createWriteStream(target), left: size, padding, target, executable: (mode & 0o111) !== 0 };
				created.stream.on('error', err => { created.error = err; });
				sink = created;
			}
		}
		// Bytes left over that never made a whole header block mean the archive was cut short.
		if (sink || meta || discard > 0 || (!finished && pending.length > 0)) {
			throw new Error('The downloaded package is incomplete (the archive ends early), so it was not installed.');
		}
	} catch (err) {
		// A file left half written is closed, not leaked, before the failure is reported.
		(sink as FileSink | undefined)?.stream.destroy();
		throw err;
	}
	return { files, bytes };
}

/** Extracts a `.tgz` file. */
export async function extractTarGz(file: string, dest: string, options: { strip?: number; maxBytes?: number } = {}): Promise<{ files: number; bytes: number }> {
	const gunzip = zlib.createGunzip();
	const source = fs.createReadStream(file);
	// `pipeline` forwards a read or decompression error to `gunzip`, so the loop below throws it.
	pipeline(source, gunzip, () => undefined);
	return extractTarStream(gunzip, dest, options);
}

// --- the install -------------------------------------------------------------------------------

/** Serializes installs: two at once would race on the same folders. */
let running: Promise<InstallResult> | undefined;

/** Installs (or updates) the SDK. Concurrent calls share one run. */
export function installClaudeSdk(options: InstallOptions): Promise<InstallResult> {
	running ??= doInstall(options).finally(() => { running = undefined; });
	return running;
}

async function doInstall(options: InstallOptions): Promise<InstallResult> {
	const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
	assertSecureRegistry(registry);
	const doFetch = options.fetchImpl ?? fetch;
	const report = (message: string): void => options.onProgress?.(message);
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const series = options.series ?? TESTED_SDK_SERIES;
	const scoped = (name: string): string => name.replace('/', '%2F');

	report('Looking up the Claude Agent SDK…');
	const packument = await getJson<{ versions?: Record<string, { dist?: Dist; optionalDependencies?: Record<string, string>; deprecated?: string }> }>(
		`${registry}/${scoped(SDK_PACKAGE_NAME)}`, doFetch, options.signal, 'application/vnd.npm.install-v1+json',
	);
	const published = Object.entries(packument.versions ?? {}).filter(([, meta]) => !meta.deprecated).map(([version]) => version);
	const version = pickVersion(published, series);
	if (!version) {
		throw new Error(`No ${series}.x release of the Claude Agent SDK is available from the registry, which is the series this version of Stormcoder was tested with.`);
	}
	const meta = packument.versions![version];
	const platformName = pickPlatformPackage(meta.optionalDependencies ?? {}, platform, arch, options.musl ?? detectMusl());
	if (!platformName) {
		throw new Error(`The Claude Agent SDK has no build for ${platform} on ${arch}.`);
	}
	const platformVersion = meta.optionalDependencies![platformName];
	const platformMeta = await getJson<{ dist?: Dist }>(`${registry}/${scoped(platformName)}/${platformVersion}`, doFetch, options.signal, 'application/json');
	if (!meta.dist?.tarball || !platformMeta.dist?.tarball) {
		throw new Error('The registry did not say where to download the package from.');
	}

	fs.mkdirSync(options.dir, { recursive: true });
	const stamp = crypto.randomBytes(4).toString('hex');
	const staging = path.join(options.dir, `.staging-${stamp}`);
	const backup = path.join(options.dir, `.previous-${stamp}`);
	const live = path.join(options.dir, 'node_modules');
	try {
		fs.mkdirSync(staging, { recursive: true });
		const packages: Array<{ name: string; dist: Dist; label: string }> = [
			{ name: SDK_PACKAGE_NAME, dist: meta.dist, label: `Claude Agent SDK ${version}` },
			{ name: platformName, dist: platformMeta.dist, label: `the ${platform}-${arch} engine build` },
		];
		for (const pkg of packages) {
			report(`Downloading ${pkg.label}…`);
			const file = path.join(staging, `${stamp}-${pkg.name.replace(/\W+/g, '_')}.tgz`);
			await download(pkg.dist.tarball!, file, pkg.dist, doFetch, options.signal, options.onProgress, pkg.label);
			report(`Unpacking ${pkg.label}…`);
			await extractTarGz(file, packageFolder(staging, pkg.name));
			fs.rmSync(file, { force: true });
		}
		const installed = JSON.parse(fs.readFileSync(path.join(packageFolder(staging, SDK_PACKAGE_NAME), 'package.json'), 'utf8')) as { name?: string; version?: string };
		if (installed.name !== SDK_PACKAGE_NAME || installed.version !== version) {
			throw new Error('The downloaded package is not the one the registry described, so it was not installed.');
		}
		// Build complete: swap it in, keeping the old one until the new one is in place.
		if (fs.existsSync(live)) {
			fs.renameSync(live, backup);
		}
		try {
			fs.renameSync(path.join(staging, 'node_modules'), live);
		} catch (err) {
			if (fs.existsSync(backup)) {
				fs.renameSync(backup, live);
			}
			throw err;
		}
		fs.rmSync(backup, { recursive: true, force: true });
		fs.writeFileSync(path.join(options.dir, 'install.json'), JSON.stringify({ version, platformPackage: platformName, installedAt: new Date().toISOString() }, null, 2));
		report(`Installed Claude Agent SDK ${version}.`);
		return { version, platformPackage: platformName, dir: options.dir };
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}
