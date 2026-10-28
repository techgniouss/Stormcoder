/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/git/repo';
import { configureHost, HostEnvironment, readJsonFile, UiEvent, ViewId, writeJsonFile } from './env';
import { cancelProgress, createContext, deliverToView, deliverUri, ExtensionContext, registeredCommands, reloadSettings, resetHost, runCommand, settingDefaults } from './vscode';
import COMMAND_LIST from './command-list.json';
import type { UpdateService } from './updater';

/** What the embedding process (Electron main, or the browser dev host) supplies. */
export interface ControllerOptions {
	appRoot: string;
	userDataDir: string;
	uriScheme: string;
	appVersion: string;
	platform: NodeJS.Platform;
	secureStorage: boolean;
	codec: Pick<HostEnvironment, 'encrypt' | 'decrypt'>;
	/** Delivers a message to the shell page. */
	send(channel: string, payload: unknown): void;
	openExternal(url: string): Promise<boolean>;
	readClipboard(): Promise<string>;
	writeClipboard(text: string): Promise<void>;
	/** Moves a path to the OS trash (used for `useTrash` deletes). */
	trashItem?(file: string): Promise<void>;
	pickFolder(): Promise<string | undefined>;
	pickFiles(opts: { title?: string; folders: boolean; files: boolean; many: boolean; defaultPath?: string }): Promise<string[] | undefined>;
	confirmTrust(folder: string): Promise<'trust' | 'readonly' | 'cancel'>;
	showFatal(title: string, detail: string): void;
	onExternalActivity?(): void;
	/** App-level commands the shell can ask for (`app.quit`, `app.checkUpdates`, `app.openLogs`, `app.zoom`…). */
	appCommand?(id: string, args: unknown[]): void | Promise<void>;
	/** Keeps the app current from GitHub releases; its state is pushed to the shell as `app:update`. */
	updates?: UpdateService;
}

interface AppState {
	folder?: string;
	recent: string[];
	trusted: string[];
}

interface EngineModule {
	activate(context: ExtensionContext): void;
	deactivate(): void;
}

/**
 * Owns the lifecycle of the chat engine and the conversation between the engine and the
 * shell page: which folder is open, whether it is trusted, UI requests and their answers,
 * view HTML, and the small set of calls the shell may make.
 *
 * It knows nothing about Electron, so the same class runs under a test or the browser dev host.
 */
export class Controller {
	private readonly stateFile: string;
	private readonly state: AppState;
	private readonly viewHtml = new Map<ViewId, string>();
	private readonly pending = new Map<number, (value: unknown) => void>();
	private requestId = 0;
	private context: ExtensionContext | undefined;
	private chain: Promise<void> = Promise.resolve();
	private rendererReady = false;
	private readonly outbox: Array<{ channel: string; payload: unknown }> = [];
	/** Messages held for a shell that has not connected are capped so a missing page cannot grow memory without bound. */
	private static readonly OUTBOX_LIMIT = 500;

	constructor(private readonly opts: ControllerOptions, private readonly engine: EngineModule, private readonly prepareHtml: (html: string) => string) {
		this.stateFile = path.join(opts.userDataDir, 'app-state.json');
		this.state = { recent: [], trusted: [], ...readJsonFile<Partial<AppState>>(this.stateFile, {}) };
		if (this.state.folder && !fs.existsSync(this.state.folder)) {
			this.state.folder = undefined;
		}
		configureHost(this.environment());
		opts.updates?.onChange(state => this.toRenderer('app:update', state));
	}

	// ------------------------------------------------------------------ plumbing

	private toRenderer(channel: string, payload: unknown): void {
		if (this.rendererReady) {
			this.opts.send(channel, payload);
		} else {
			this.outbox.push({ channel, payload });
			if (this.outbox.length > Controller.OUTBOX_LIMIT) {
				this.outbox.splice(0, this.outbox.length - Controller.OUTBOX_LIMIT);
			}
		}
	}

	/** The shell page finished loading and has registered its listeners. */
	rendererIsReady(): void {
		this.rendererReady = true;
		this.opts.send('app:state', this.publicState());
		// A shell that connects (or reloads) after the engine started has missed every
		// `view:reload`; re-announce the views that exist instead of replaying stale ones.
		const queued = this.outbox.splice(0).filter(item => item.channel !== 'view:reload');
		for (const view of this.viewHtml.keys()) {
			this.opts.send('view:reload', { view });
		}
		for (const item of queued) {
			this.opts.send(item.channel, item.payload);
		}
	}

	/** The shell page went away (window closed or reloaded); hold messages until it returns. */
	rendererGone(): void {
		this.rendererReady = false;
		this.resolvePending();
	}

	/** Answers every outstanding UI request with "dismissed" so no engine call waits on a prompt nobody can see. */
	private resolvePending(): void {
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const resolve of waiting) {
			resolve(undefined);
		}
	}

	private environment(): HostEnvironment {
		const self = this;
		return {
			appRoot: this.opts.appRoot,
			userDataDir: this.opts.userDataDir,
			get workspaceFolder() { return self.state.folder; },
			get workspaceTrusted() { return !!self.state.folder && self.state.trusted.includes(self.state.folder); },
			uriScheme: this.opts.uriScheme,
			appVersion: this.opts.appVersion,
			request: req => new Promise(resolve => {
				const id = ++this.requestId;
				this.pending.set(id, resolve);
				this.toRenderer('ui:request', { id, req });
			}),
			notify: (event: UiEvent) => this.toRenderer('ui:event', event),
			postToView: (view, message) => this.toRenderer('view:message', { view, message }),
			setViewHtml: (view, html) => {
				this.viewHtml.set(view, this.prepareHtml(html));
				this.toRenderer('view:reload', { view });
			},
			openExternal: url => /^(https?:\/\/|mailto:)/i.test(url) ? this.opts.openExternal(url) : Promise.resolve(false),
			readClipboard: this.opts.readClipboard,
			writeClipboard: this.opts.writeClipboard,
			trash: this.opts.trashItem,
			...this.opts.codec,
		};
	}

	/** The HTML currently registered for a view, served by the asset protocol. */
	getViewHtml(view: string): string | undefined {
		return this.viewHtml.get(view as ViewId);
	}

	private save(): void {
		writeJsonFile(this.stateFile, this.state);
	}

	publicState() {
		const registered = new Set(registeredCommands());
		return {
			folder: this.state.folder ?? null,
			recent: this.state.recent.filter(f => fs.existsSync(f)),
			trusted: !!this.state.folder && this.state.trusted.includes(this.state.folder),
			version: this.opts.appVersion,
			platform: this.opts.platform,
			secureStorage: this.opts.secureStorage,
			userDataDir: this.opts.userDataDir,
			commands: [...registered],
			commandList: COMMAND_LIST,
		};
	}

	// ------------------------------------------------------------------ engine lifecycle

	/** (Re)starts the engine against the current folder. Calls are serialized. */
	start(): Promise<void> {
		// A failed start must not reject the chain, or every later folder switch would be skipped too.
		this.chain = this.chain.then(() => this.startNow()).catch(err => {
			console.error('engine start failed', err);
			this.opts.showFatal('Stormcoder could not start', err instanceof Error ? (err.stack ?? err.message) : String(err));
		});
		return this.chain;
	}

	private startNow(): void {
		if (this.context) {
			try {
				this.engine.deactivate();
			} catch (err) {
				console.error('deactivate failed', err);
			}
			for (const d of this.context.subscriptions) {
				try {
					d.dispose();
				} catch (err) {
					console.error('dispose failed', err);
				}
			}
		}
		// Prompts the old engine was waiting on can never be answered meaningfully now.
		this.resolvePending();
		resetHost();
		this.viewHtml.clear();
		this.context = createContext();
		try {
			this.engine.activate(this.context);
		} catch (err) {
			console.error('activation failed', err);
			this.opts.showFatal('Stormcoder could not start', err instanceof Error ? (err.stack ?? err.message) : String(err));
		}
		this.toRenderer('app:state', this.publicState());
	}

	async shutdown(): Promise<void> {
		await this.chain;
		try {
			this.engine.deactivate();
		} catch {
			// quitting; nothing useful to do with it
		}
	}

	async openFolder(folder?: string): Promise<void> {
		const target = folder ?? await this.opts.pickFolder();
		if (!target) {
			return;
		}
		if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
			this.opts.showFatal('Stormcoder', `${target} is not a folder.`);
			return;
		}
		if (!this.state.trusted.includes(target)) {
			const answer = await this.opts.confirmTrust(target);
			if (answer === 'cancel') {
				return;
			}
			if (answer === 'trust') {
				this.state.trusted.push(target);
			}
		}
		this.state.folder = target;
		this.state.recent = [target, ...this.state.recent.filter(f => f !== target)].slice(0, 12);
		this.save();
		await this.start();
	}

	async closeFolder(): Promise<void> {
		this.state.folder = undefined;
		this.save();
		await this.start();
	}

	recentFolders(): string[] {
		return this.state.recent.filter(f => fs.existsSync(f));
	}

	deliverDeepLink(url: string): void {
		deliverUri(url);
	}

	// ------------------------------------------------------------------ calls from the shell

	/** Resolves symlinks in the longest existing prefix of `file`, so a path that does not exist yet is still judged by where it would land. */
	private realPathLoose(file: string): string {
		let head = path.resolve(file);
		const tail: string[] = [];
		for (;;) {
			try {
				return path.join(fs.realpathSync(head), ...tail.reverse());
			} catch {
				const parent = path.dirname(head);
				if (parent === head) {
					return path.resolve(file);
				}
				tail.push(path.basename(head));
				head = parent;
			}
		}
	}

	/**
	 * The built-in editor may only touch the settings file, the MCP config files and skills of a trusted
	 * project, and (read-only) the logs. Never secrets, the encryption key or app state. Each
	 * allowed path must also resolve to itself after following symlinks, so a `.vscode` that links
	 * to `~/.ssh` cannot be used to escape.
	 */
	private isEditable(file: string, forWrite: boolean): boolean {
		const resolved = path.resolve(file);
		const allowed: Array<{ base: string; rel: string; prefix?: boolean }> = [{ base: this.opts.userDataDir, rel: 'settings.json' }];
		if (!forWrite) {
			allowed.push({ base: this.opts.userDataDir, rel: 'logs', prefix: true });
		}
		const folder = this.state.folder;
		if (folder && this.state.trusted.includes(folder)) {
			allowed.push(
				{ base: folder, rel: path.join('.stormcoder', 'mcp.json') },
				{ base: folder, rel: path.join('.openvs', 'mcp.json') },
				{ base: folder, rel: path.join('.vscode', 'mcp.json') },
				{ base: folder, rel: path.join('.stormcoder', 'skills'), prefix: true },
				{ base: folder, rel: path.join('.openvs', 'skills'), prefix: true },
			);
		}
		return allowed.some(a => {
			const lexical = path.join(path.resolve(a.base), a.rel);
			const matches = resolved === lexical || (a.prefix === true && resolved.startsWith(lexical + path.sep));
			if (!matches) {
				return false;
			}
			const expected = path.join(this.realPathLoose(a.base), path.relative(path.resolve(a.base), resolved));
			return this.realPathLoose(resolved) === expected;
		});
	}

	/**
	 * The Changes view's git calls. Reading needs an open folder; anything that changes the
	 * repository needs a trusted one. Failures come back as `{ ok: false, kind, error }` so the
	 * view can show git's own words and choose what to offer next.
	 */
	private async gitCall(op: string, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string; kind: string }> {
		const folder = this.state.folder;
		const trusted = !!folder && this.state.trusted.includes(folder);
		const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
		try {
			if (!folder) {
				throw new repo.GitError('Open a project folder first.', 'failed');
			}
			const writes = new Set(['stage', 'unstage', 'stageHunk', 'discard', 'stash', 'stashApply', 'stashPop', 'stashDrop', 'commit', 'push', 'pull', 'undoCommit', 'abortMerge', 'draft']);
			if (writes.has(op) && !trusted) {
				throw new repo.GitError('Trust this folder to change its git state.', 'failed');
			}
			let value: unknown;
			switch (op) {
				case 'status': value = await repo.status(folder); break;
				case 'diff': value = await repo.diff(folder, String(args[0]), args[1] === 'staged' ? 'staged' : args[1] === 'untracked' ? 'untracked' : 'unstaged'); break;
				case 'file': value = await repo.fileText(folder, String(args[0])); break;
				case 'files': value = await repo.listFiles(folder); break;
				case 'stage': await repo.stage(folder, list(args[0])); break;
				case 'unstage': await repo.unstage(folder, list(args[0])); break;
				case 'stageHunk': await repo.stageHunk(folder, String(args[0]), args[1] === 'staged' ? 'staged' : 'unstaged', Number(args[2]), String(args[3])); break;
				case 'discard': await repo.discard(folder, list(args[0])); break;
				case 'stash': await repo.stash(folder); break;
				case 'stashShow': value = await repo.stashShow(folder, String(args[0])); break;
				case 'stashApply': await repo.stashRestore(folder, String(args[0]), false); break;
				case 'stashPop': await repo.stashRestore(folder, String(args[0]), true); break;
				case 'stashDrop': await repo.stashDrop(folder, String(args[0])); break;
				case 'prUrl': value = await repo.pullRequestUrl(folder); break;
				case 'commit': value = await repo.commit(folder, String(args[0] ?? '')); break;
				case 'push': value = await repo.push(folder, args[0] === true); break;
				case 'pull': await repo.pull(folder); break;
				case 'undoCommit': await repo.undoCommit(folder); break;
				case 'abortMerge': await repo.abortMerge(folder); break;
				case 'draft': value = await runCommand('stormcoder.git.draftMessage', folder); break;
				case 'cancelDraft': await runCommand('stormcoder.git.cancelDraft'); break;
				default: throw new repo.GitError(`Unknown git call: ${op}`, 'failed');
			}
			return { ok: true, value };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err), kind: err instanceof repo.GitError ? err.kind : 'failed' };
		}
	}

	/** Dispatches one named call from the shell page. Unknown names are rejected. */
	async handleCall(name: string, args: unknown[]): Promise<unknown> {
		switch (name) {
			case 'ready': this.rendererIsReady(); return undefined;
			case 'sendToView': deliverToView(args[0] as ViewId, args[1]); return undefined;
			case 'respond': {
				const id = args[0] as number;
				this.pending.get(id)?.(args[1]);
				this.pending.delete(id);
				return undefined;
			}
			case 'command': {
				const id = String(args[0]);
				const rest = args.slice(1);
				if (id === 'app.openFolder') { return this.openFolder(rest[0] as string | undefined); }
				if (id === 'app.closeFolder') { return this.closeFolder(); }
				if (id === 'app.state') { return this.publicState(); }
				if (id === 'app.updateState') { return this.opts.updates?.state(); }
				if (id === 'app.checkUpdates' && this.opts.updates) { return this.opts.updates.check(true); }
				if (id === 'app.installUpdate' && this.opts.updates) { return this.opts.updates.install(); }
				if (id === 'app.openRelease') {
					const url = this.opts.updates?.state().releaseUrl;
					if (url && /^https:\/\/github\.com\//.test(url)) { await this.opts.openExternal(url); }
					return undefined;
				}
				if (id === 'app.cancelProgress') { cancelProgress(Number(rest[0])); return undefined; }
				if (id === 'app.settingsDefaults') { return settingDefaults(); }
				if (id.startsWith('git.')) { return this.gitCall(id.slice(4), rest); }
				if (id.startsWith('app.')) { return this.opts.appCommand?.(id, rest); }
				return runCommand(id, ...rest);
			}
			case 'readFile': {
				const file = String(args[0]);
				if (!this.isEditable(file, false)) { throw new Error('That file cannot be edited here.'); }
				return fs.promises.readFile(file, 'utf8').catch(() => '');
			}
			case 'writeFile': {
				const file = String(args[0]);
				if (!this.isEditable(file, true)) { throw new Error('That file cannot be edited here.'); }
				const text = String(args[1]);
				const isSettings = path.resolve(file) === path.join(this.opts.userDataDir, 'settings.json');
				// Settings are validated before they replace the file: a typo must not wipe every setting on reload.
				if (isSettings || path.basename(file) === 'mcp.json') {
					let parsed: unknown;
					try {
						parsed = JSON.parse(text);
					} catch (err) {
						throw new Error(`${path.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
					}
					if (isSettings && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
						throw new Error('settings.json must contain a JSON object.');
					}
				}
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(file, text, 'utf8');
				if (isSettings) {
					reloadSettings();
				}
				return undefined;
			}
			case 'openDialog': return this.opts.pickFiles(args[0] as Parameters<ControllerOptions['pickFiles']>[0]);
			default: throw new Error(`Unknown call: ${name}`);
		}
	}
}
