/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { configureHost, HostEnvironment, readJsonFile, UiEvent, ViewId, writeJsonFile } from './env';
import { createContext, deliverToView, deliverUri, ExtensionContext, registeredCommands, reloadSettings, resetHost, runCommand, settingDefaults } from './vscode';
import COMMAND_LIST from './command-list.json';

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
	pickFolder(): Promise<string | undefined>;
	pickFiles(opts: { title?: string; folders: boolean; files: boolean; many: boolean; defaultPath?: string }): Promise<string[] | undefined>;
	confirmTrust(folder: string): Promise<'trust' | 'readonly' | 'cancel'>;
	showFatal(title: string, detail: string): void;
	onExternalActivity?(): void;
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

	constructor(private readonly opts: ControllerOptions, private readonly engine: EngineModule, private readonly prepareHtml: (html: string) => string) {
		this.stateFile = path.join(opts.userDataDir, 'app-state.json');
		this.state = { recent: [], trusted: [], ...readJsonFile<Partial<AppState>>(this.stateFile, {}) };
		if (this.state.folder && !fs.existsSync(this.state.folder)) {
			this.state.folder = undefined;
		}
		configureHost(this.environment());
	}

	// ------------------------------------------------------------------ plumbing

	private toRenderer(channel: string, payload: unknown): void {
		if (this.rendererReady) {
			this.opts.send(channel, payload);
		} else {
			this.outbox.push({ channel, payload });
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
		for (const resolve of this.pending.values()) {
			resolve(undefined);
		}
		this.pending.clear();
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
		this.chain = this.chain.then(() => {
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
			resetHost();
			this.viewHtml.clear();
			this.context = createContext();
			try {
				this.engine.activate(this.context);
			} catch (err) {
				console.error('activation failed', err);
				this.opts.showFatal('Mjolnir could not start', err instanceof Error ? (err.stack ?? err.message) : String(err));
			}
			this.toRenderer('app:state', this.publicState());
		});
		return this.chain;
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
			this.opts.showFatal('Mjolnir', `${target} is not a folder.`);
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

	/** The built-in editor may only touch the app's data and the open project's config folders. */
	private isEditable(file: string): boolean {
		const resolved = path.resolve(file);
		const roots = [this.opts.userDataDir, ...(this.state.folder ? [path.join(this.state.folder, '.openvs'), path.join(this.state.folder, '.vscode')] : [])];
		return roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
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
				if (id === 'app.settingsDefaults') { return settingDefaults(); }
				return runCommand(id, ...rest);
			}
			case 'readFile': {
				const file = String(args[0]);
				if (!this.isEditable(file)) { throw new Error('That file cannot be edited here.'); }
				return fs.promises.readFile(file, 'utf8').catch(() => '');
			}
			case 'writeFile': {
				const file = String(args[0]);
				if (!this.isEditable(file)) { throw new Error('That file cannot be edited here.'); }
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(file, String(args[1]), 'utf8');
				if (path.resolve(file) === path.join(this.opts.userDataDir, 'settings.json')) {
					reloadSettings();
				}
				return undefined;
			}
			case 'openDialog': return this.opts.pickFiles(args[0] as Parameters<ControllerOptions['pickFiles']>[0]);
			default: throw new Error(`Unknown call: ${name}`);
		}
	}
}
