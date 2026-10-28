/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where an update stands, as the shell shows it:
 * - `idle`: nothing to report; `checking`: asking GitHub; `uptodate`: asked, nothing newer.
 * - `downloading`: a newer release was found and is being fetched in the background.
 * - `ready`: downloaded; installing restarts the app. It also installs when the app next quits.
 * - `available`: a newer release exists but this install cannot update itself (a .deb, a build
 *   without a signature the OS will accept), so the person is sent to the release page.
 * - `error`: the last check failed. Only a manual check is reported to the person.
 */
export type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'downloading' | 'ready' | 'available' | 'error';

export interface UpdateState {
	status: UpdateStatus;
	/** The running version. */
	current: string;
	/** The newer version, once known. */
	version?: string;
	/** Download progress, 0 to 100. */
	percent?: number;
	/** Where the release notes live on GitHub. */
	releaseUrl?: string;
	error?: string;
	/** Whether the check in progress or just finished was asked for by the person (so the shell tells them the result). */
	manual: boolean;
	/** Bumps on every change, so a repeated "up to date" answer still reaches the shell. */
	seq: number;
	checkedAt?: number;
}

/** The slice of `electron-updater`'s `autoUpdater` this service uses, so tests can stand one in. */
export interface UpdaterBackend {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	on(event: 'update-available' | 'update-not-available' | 'update-downloaded' | 'download-progress' | 'error', listener: (...args: any[]) => void): unknown;
	checkForUpdates(): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterOptions {
	/** Creates the backend on first use (loading `electron-updater` is deferred until it is needed). */
	backend(): Promise<UpdaterBackend>;
	/** The running version. */
	version: string;
	/** Only an installed build can update itself; a dev run still reports "can't check" honestly. */
	canSelfUpdate: boolean;
	/** `owner/name` of the GitHub repository whose releases are the source of updates. */
	repo: string;
	/** Runs before the app quits to install, so the engine shuts down cleanly first. */
	beforeInstall?(): Promise<void>;
	/** Fetches the latest release when the install cannot update itself; defaults to the GitHub API. */
	latestRelease?(repo: string): Promise<{ version: string; url: string } | undefined>;
	log?(level: 'info' | 'warn' | 'error', message: string): void;
	/** Background checks: first after `initialDelayMs`, then every `intervalMs`. Zero turns them off. */
	initialDelayMs?: number;
	intervalMs?: number;
}

/** Compares dotted versions ("1.10.0" > "1.9.2"); a pre-release suffix sorts below its release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, pre] = v.trim().replace(/^v/i, '').split(/-(.+)/);
		return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ?? '' };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) { return d < 0 ? -1 : 1; }
	}
	if (x.pre === y.pre) { return 0; }
	if (!x.pre) { return 1; }
	if (!y.pre) { return -1; }
	return x.pre < y.pre ? -1 : 1;
}

async function githubLatest(repo: string): Promise<{ version: string; url: string } | undefined> {
	const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stormcoder' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) { throw new Error(`GitHub answered ${res.status} when asked for the latest release.`); }
	const json: any = await res.json();
	if (typeof json?.tag_name !== 'string') { return undefined; }
	return { version: json.tag_name.replace(/^v/i, ''), url: typeof json.html_url === 'string' ? json.html_url : `https://github.com/${repo}/releases` };
}

/**
 * Keeps the app current from its GitHub releases. A newer release downloads in the background
 * without asking; the shell is told when it is ready and the person chooses when to restart, or it
 * installs on the next quit. They can also check by hand at any time.
 */
export class UpdateService {
	private current: UpdateState;
	private readonly listeners = new Set<(state: UpdateState) => void>();
	private backend: Promise<UpdaterBackend> | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inflight: Promise<void> | undefined;

	constructor(private readonly opts: UpdaterOptions) {
		this.current = { status: 'idle', current: opts.version, manual: false, seq: 0 };
	}

	state(): UpdateState { return this.current; }

	onChange(listener: (state: UpdateState) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Starts the background schedule. Safe to call once at app start. */
	start(): void {
		const { initialDelayMs = 15_000, intervalMs = 6 * 60 * 60_000 } = this.opts;
		if (!initialDelayMs) { return; }
		const tick = (): void => {
			void this.check(false).finally(() => {
				if (intervalMs > 0) {
					this.timer = setTimeout(tick, intervalMs);
					this.timer.unref?.();
				}
			});
		};
		this.timer = setTimeout(tick, initialDelayMs);
		this.timer.unref?.();
	}

	stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

	private set(patch: Partial<UpdateState>): void {
		this.current = { ...this.current, ...patch, seq: this.current.seq + 1 };
		for (const l of [...this.listeners]) { try { l(this.current); } catch { /* a bad listener must not stop the others */ } }
	}

	/**
	 * Looks for a newer release. Does nothing while one is downloading or waiting to be installed;
	 * a manual check in that case just reports the state again.
	 */
	check(manual: boolean): Promise<void> {
		const s = this.current.status;
		if (s === 'downloading' || s === 'ready' || s === 'available') {
			if (manual) { this.set({ manual: true }); }
			return Promise.resolve();
		}
		if (this.inflight) {
			if (manual) { this.set({ manual: true }); }
			return this.inflight;
		}
		this.inflight = this.run(manual).finally(() => { this.inflight = undefined; });
		return this.inflight;
	}

	private async run(manual: boolean): Promise<void> {
		this.set({ status: 'checking', manual, error: undefined, percent: undefined });
		try {
			if (!this.opts.canSelfUpdate) {
				// Not an installed build (or one that cannot self-update): still say whether a newer release exists.
				await this.checkWithoutUpdater();
				return;
			}
			const backend = await this.getBackend();
			await backend.checkForUpdates();
			// The outcome arrives through the backend's events; a check that raised none still ends.
			if (this.current.status === 'checking') { this.set({ status: 'uptodate', checkedAt: Date.now() }); }
		} catch (err) {
			this.fail(err);
		}
	}

	private async checkWithoutUpdater(): Promise<void> {
		const latest = await (this.opts.latestRelease ?? githubLatest)(this.opts.repo);
		if (latest && compareVersions(latest.version, this.opts.version) > 0) {
			this.set({ status: 'available', version: latest.version, releaseUrl: latest.url, checkedAt: Date.now() });
		} else {
			this.set({ status: 'uptodate', checkedAt: Date.now() });
		}
	}

	private fail(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		// electron-updater reports a failure both as an event and by rejecting the check: handle it once.
		if (this.current.error === message && (this.current.status === 'error' || this.current.status === 'available')) { return; }
		this.opts.log?.('error', `updater: ${message}`);
		// A newer version is known but could not be installed in place: offer the release page instead.
		if (this.current.version && (this.current.status === 'downloading' || this.current.status === 'checking')) {
			this.set({ status: 'available', releaseUrl: this.current.releaseUrl ?? `https://github.com/${this.opts.repo}/releases/latest`, error: message, checkedAt: Date.now() });
		} else {
			this.set({ status: 'error', error: message, checkedAt: Date.now() });
		}
	}

	private getBackend(): Promise<UpdaterBackend> {
		this.backend ??= this.opts.backend().then(b => {
			// Download without asking; install on quit if the person never clicks Restart.
			b.autoDownload = true;
			b.autoInstallOnAppQuit = true;
			b.on('update-available', (info: any) => this.set({
				status: 'downloading', version: String(info?.version ?? ''), percent: 0,
				releaseUrl: `https://github.com/${this.opts.repo}/releases/tag/v${String(info?.version ?? '').replace(/^v/i, '')}`,
			}));
			b.on('update-not-available', () => this.set({ status: 'uptodate', checkedAt: Date.now() }));
			b.on('download-progress', (p: any) => {
				const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
				if (percent !== this.current.percent) { this.set({ status: 'downloading', percent }); }
			});
			b.on('update-downloaded', (info: any) => this.set({ status: 'ready', percent: 100, version: String(info?.version ?? this.current.version ?? ''), checkedAt: Date.now() }));
			b.on('error', (err: unknown) => this.fail(err));
			return b;
		});
		return this.backend;
	}

	/** Restarts into the downloaded update. Does nothing unless one is ready. */
	async install(): Promise<void> {
		if (this.current.status !== 'ready') { return; }
		const backend = await this.getBackend();
		await this.opts.beforeInstall?.();
		backend.quitAndInstall(false, true);
	}
}
