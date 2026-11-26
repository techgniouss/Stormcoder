/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProviderRegistry } from '../providers/registry';
import { ChatMessage, ModelEntry } from '../providers/types';
import { checkTarget } from './capabilities';
import { ClaudeEngine, EngineCallbacks, EngineResult, EngineTurn, SdkLocation, TESTED_SDK_SERIES, findSdk, loadClaudeSdk } from './claudeEngine';
import { AnthropicGateway } from './gateway';
import { installClaudeSdk } from './installer';
import { EngineTarget, SessionRoute } from './modelMap';

/** Who runs the agent loop. */
export type EngineId = 'builtin' | 'claude-code';

/**
 * Reads `stormcoder.engine`. Anything unrecognised is the built-in engine: a typo in settings must
 * never route work to an agent the user did not choose.
 */
export function readEngineSetting(): EngineId {
	return vscode.workspace.getConfiguration('stormcoder').get<string>('engine') === 'claude-code' ? 'claude-code' : 'builtin';
}

let engineAtStart: EngineId | undefined;

/**
 * The engine selected when the app started. Read once per process and then fixed: the extension is
 * re-activated whenever the folder changes, and a setting edited meanwhile must not switch the
 * engine under a running app. A restart picks the new value up.
 */
export function engineSelectedAtStart(): EngineId {
	engineAtStart ??= readEngineSetting();
	return engineAtStart;
}

/** After this many start failures in a row the engine is left alone for {@link START_FAILURE_BLOCK_MS}. */
const START_FAILURES_BEFORE_BLOCK = 2;
const START_FAILURE_BLOCK_MS = 5 * 60_000;

/** The longest the engine may take to become ready before the built-in agent serves the message instead. */
const PREFLIGHT_TIMEOUT_MS = 20_000;

/** How the engine reaches its model: through Stormcoder's gateway (default) or the user's own Claude Code login. */
function readAuth(): 'gateway' | 'own-login' {
	return vscode.workspace.getConfiguration('stormcoder').get<string>('engine.claudeCode.auth') === 'own-login' ? 'own-login' : 'gateway';
}

/** A route for the engine, or why there is none. */
export interface RouteResolution {
	readonly route?: SessionRoute;
	readonly problems: string[];
	readonly warnings: string[];
	/** The main model's context window. */
	readonly contextWindow: number;
}

/** Parses a `provider:model` setting. */
export function parseTarget(raw: string | undefined): EngineTarget | undefined {
	const value = (raw ?? '').trim();
	const split = value.indexOf(':');
	if (split <= 0 || split === value.length - 1) {
		return undefined;
	}
	return { providerId: value.slice(0, split).trim(), model: value.slice(split + 1).trim() };
}

/**
 * The most recent messages of an earlier conversation as plain text, for a chat that began under
 * the other engine and so has no engine session to resume. Built by excerpting, not by asking a
 * model to summarise: seeding must never cost a model call.
 */
export function buildTranscriptSeed(history: readonly ChatMessage[], maxChars = 4_000, perMessage = 600): string {
	const lines: string[] = [];
	let used = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if ((m.role !== 'user' && m.role !== 'assistant') || !m.content.trim()) {
			continue;
		}
		const text = m.content.trim();
		const clipped = text.length > perMessage ? `${text.slice(0, perMessage)}…` : text;
		const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`;
		if (used + line.length > maxChars && lines.length) {
			break;
		}
		lines.unshift(line);
		used += line.length;
	}
	return lines.join('\n');
}

/** Everything the host needs to know about the app around it. */
export interface EngineHostOptions {
	/** Replaces the real engine (tests). */
	readonly engine?: Pick<ClaudeEngine, 'run'>;
	readonly context: vscode.ExtensionContext;
	readonly registry: ProviderRegistry;
	readonly catalog: (providerId: string) => ModelEntry[] | undefined;
	readonly log: (line: string) => void;
}

/**
 * Owns the Claude Code engine for the life of the app: reads which engine is selected (once, at
 * start), runs the local gateway on first use, and resolves a chat's model choice into the route
 * the gateway serves.
 */
export class EngineHost {
	/** The engine selected when the app started. Changing the setting takes effect after a restart. */
	readonly id: EngineId;
	private gateway?: AnthropicGateway;
	private starting?: Promise<AnthropicGateway>;
	private readonly engine: Pick<ClaudeEngine, 'run'>;
	/** Consecutive times the harness failed before producing anything. */
	private startFailures = 0;
	/** Until when the engine is treated as unavailable after repeated start failures. */
	private blockedUntil = 0;
	private lastStartFailure = '';
	/** The SDK version this process has loaded. A module is cached for the life of the process, so a newer one needs a restart. */
	private loadedVersion: string | undefined;

	constructor(private readonly options: EngineHostOptions) {
		this.id = engineSelectedAtStart();
		this.engine = options.engine ?? new ClaudeEngine({
			gateway: () => this.gateway,
			load: async () => {
				const { sdk, found } = await loadClaudeSdk(this.sdkLocation());
				this.loadedVersion = found.version;
				if (found.compat === 'untested') {
					this.options.log(`Claude Agent SDK ${found.version} is outside the tested ${TESTED_SDK_SERIES}.x series; it may still work.`);
				}
				return sdk;
			},
		});
	}

	/** The folder the in-app installer puts the SDK in. */
	installDir(): string {
		return path.join(path.dirname(this.options.context.globalStorageUri.fsPath), 'engines', 'claude');
	}

	/** What is installed, and what this process is running. */
	sdkStatus(): { installed?: string; loaded?: string } {
		return { installed: findSdk(this.sdkLocation())?.version, loaded: this.loadedVersion };
	}

	/**
	 * Downloads the SDK into {@link installDir}. `restartNeeded` is true when this process already
	 * loaded a different version, which it keeps until it restarts.
	 */
	async installSdk(onProgress: (message: string) => void, signal: AbortSignal): Promise<{ version: string; restartNeeded: boolean }> {
		const configured = vscode.workspace.getConfiguration('stormcoder').get<unknown>('engine.registry');
		const registry = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
		const result = await installClaudeSdk({ dir: this.installDir(), registry, onProgress, signal });
		return { version: result.version, restartNeeded: this.loadedVersion !== undefined && this.loadedVersion !== result.version };
	}

	/** Whether the local gateway is currently listening. */
	get gatewayRunning(): boolean {
		return !!this.gateway?.listening;
	}

	/** Whether the Claude Code engine is the one in use. */
	get enabled(): boolean {
		return this.id === 'claude-code';
	}

	/** Where the SDK may be installed. */
	sdkLocation(): SdkLocation {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		const sdkPath = cfg.get<unknown>('engine.claudeCode.sdkPath');
		return {
			// A hand-edited settings file can hold anything; only a string is a path.
			sdkPath: typeof sdkPath === 'string' ? sdkPath : '',
			userDataDir: path.dirname(this.options.context.globalStorageUri.fsPath),
			appRoot: this.options.context.extensionPath,
		};
	}

	/**
	 * Whether the engine can run a turn right now: the SDK is on disk and loads, and (unless the engine
	 * uses its own login) the gateway is up. Nothing is changed by a failure, so the caller can hand the
	 * message to the built-in agent instead.
	 */
	async preflight(timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (Date.now() < this.blockedUntil) {
			return { ok: false, reason: `the engine failed to start ${START_FAILURES_BEFORE_BLOCK} times in a row (${this.lastStartFailure}); it will be tried again in a few minutes` };
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// An SDK whose import never finishes must not hold up every message that follows.
			await Promise.race([
				(async () => {
					this.loadedVersion = (await loadClaudeSdk(this.sdkLocation())).found.version;
					if (readAuth() === 'gateway') {
						await this.ensureStarted();
					}
				})(),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Starting the engine took too long.')), timeoutMs); }),
			]);
			return { ok: true };
		} catch (err) {
			return { ok: false, reason: (err instanceof Error ? err.message : String(err)).split('\n')[0] };
		} finally {
			if (timer) { clearTimeout(timer); }
		}
	}

	/** Starts the gateway if it is not running. */
	async ensureStarted(): Promise<AnthropicGateway> {
		if (this.gateway?.listening) {
			return this.gateway;
		}
		this.starting ??= (async () => {
			const gateway = new AnthropicGateway({
				registry: this.options.registry,
				catalog: this.options.catalog,
				log: line => this.options.log(`[gateway] ${line}`),
			});
			await gateway.start();
			this.gateway = gateway;
			return gateway;
		})().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	/**
	 * The route for a chat whose picker says `main`: the fast model comes from
	 * `stormcoder.engine.fastModel`, or is the main model when that is empty. Both are checked
	 * against what the harness needs, so a model that cannot serve it is refused here with a reason
	 * and never fails halfway through a task.
	 */
	resolveRoute(main: EngineTarget): RouteResolution {
		const configuredFast = parseTarget(vscode.workspace.getConfiguration('stormcoder').get<string>('engine.fastModel'));
		const fast = configuredFast ?? main;
		const mainCheck = checkTarget(main, this.options.registry.getProvider(main.providerId), this.options.catalog(main.providerId));
		const problems = [...mainCheck.problems];
		const warnings = [...mainCheck.warnings];
		if (fast !== main) {
			const fastCheck = checkTarget(fast, this.options.registry.getProvider(fast.providerId), this.options.catalog(fast.providerId));
			problems.push(...fastCheck.problems.map(p => `Fast model: ${p}`));
		}
		return { route: problems.length ? undefined : { main, fast }, problems, warnings, contextWindow: mainCheck.contextWindow };
	}

	/** Runs one chat turn through the harness. */
	async run(turn: Omit<EngineTurn, 'auth' | 'cliPath' | 'loadProjectSettings'>, callbacks: EngineCallbacks): Promise<EngineResult> {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		const auth = readAuth();
		if (auth === 'gateway') {
			await this.ensureStarted();
		}
		const configDir = auth === 'gateway' ? path.join(path.dirname(this.installDir()), 'claude-home') : undefined;
		if (configDir) {
			await fs.promises.mkdir(configDir, { recursive: true }).catch(() => undefined);
		}
		const result = await this.engine.run({
			...turn,
			auth,
			configDir,
			cliPath: (() => { const raw = cfg.get<unknown>('engine.claudeCode.cliPath'); return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined; })(),
			loadProjectSettings: cfg.get<boolean>('engine.claudeCode.loadProjectSettings') !== false,
		}, callbacks);
		// A harness that cannot start costs a process launch each time; after repeated failures it is left alone for a while.
		if (!result.started && (result.reason === 'error' || result.reason === 'limit')) {
			this.lastStartFailure = (result.detail ?? 'unknown error').split('\n')[0].slice(0, 160);
			if (++this.startFailures >= START_FAILURES_BEFORE_BLOCK) {
				this.blockedUntil = Date.now() + START_FAILURE_BLOCK_MS;
				this.startFailures = 0;
			}
		} else if (result.started) {
			this.startFailures = 0;
		}
		return result;
	}

	/** Stops the gateway. */
	async dispose(): Promise<void> {
		await this.gateway?.stop();
		this.gateway = undefined;
	}
}
