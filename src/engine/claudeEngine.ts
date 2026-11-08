/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { RunResult, StopReason } from '../agent/agentRunner';
import type { Guardrails } from '../agent/guardrails';
import type { ToolApprover } from '../agent/tools';
import type { TodoItem, TodoStatus } from '../persona/todos';
import { allowlistedEnv } from '../providers/childEnv';
import { ChatImage, ToolCall, isAbortError } from '../providers/types';
import { ANTHROPIC_ONLY_TOOLS, UpstreamKind, compactionEnv, upstreamKind } from './capabilities';
import type { AnthropicGateway, GatewayUsage } from './gateway';
import { SessionRoute, engineModelEnv } from './modelMap';
import { TESTED_SDK_SERIES } from './sdkVersion';
import { FileTracker, decideToolUse, postHooks, toStormcoderCall } from './toolBridge';

/**
 * Drives the Claude Code harness (the Claude Agent SDK) for one chat turn, and translates what it
 * does into the callbacks Stormcoder's chat UI already understands.
 *
 * The SDK is reached through {@link SdkModule}, a structural subset of its API, so Stormcoder neither
 * bundles nor compiles against it (its licence is not ours to redistribute) and tests can inject a
 * scripted fake in place of the real process.
 */

// --- the SDK, as far as we use it ---------------------------------------------------------------

/** One message of the SDK's stream. Only the fields read here are named; the rest is ignored. */
export interface SdkMessage {
	readonly type: string;
	readonly subtype?: string;
	readonly [key: string]: unknown;
}

/** The running query. */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
	interrupt(): Promise<unknown>;
	close(): void;
}

/** The slice of the SDK module used here. */
export interface SdkModule {
	query(params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }): SdkQuery;
}

/** Where to look for the SDK on disk. */
export interface SdkLocation {
	/** `stormcoder.engine.claudeCode.sdkPath`: the package folder, or a folder holding `node_modules`. */
	readonly sdkPath?: string;
	/** The app's user-data folder; an installer puts the SDK under `engines/claude`. */
	readonly userDataDir?: string;
	/** The app's own folder, used when the owner chooses to bundle the SDK. */
	readonly appRoot?: string;
}

export { TESTED_SDK_SERIES };

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Folders that may hold the SDK package, most specific first. */
export function sdkCandidates(location: SdkLocation): string[] {
	const out: string[] = [];
	const configured = location.sdkPath?.trim();
	if (configured) {
		out.push(configured, path.join(configured, 'node_modules', SDK_PACKAGE), path.join(configured, SDK_PACKAGE));
	}
	if (location.userDataDir) {
		out.push(path.join(location.userDataDir, 'engines', 'claude', 'node_modules', SDK_PACKAGE));
	}
	if (location.appRoot) {
		out.push(path.join(location.appRoot, 'node_modules', SDK_PACKAGE));
	}
	return out;
}

/** An SDK found on disk. */
export interface FoundSdk {
	readonly dir: string;
	readonly entry: string;
	readonly version: string;
	/** `untested` when the version is outside {@link TESTED_SDK_SERIES}: it may work, but nobody checked. */
	readonly compat: 'ok' | 'untested';
}

/** Finds the SDK package in the candidate folders. */
export function findSdk(location: SdkLocation, readText: (file: string) => string | undefined = file => {
	try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}): FoundSdk | undefined {
	for (const dir of sdkCandidates(location)) {
		const text = readText(path.join(dir, 'package.json'));
		if (!text) {
			continue;
		}
		try {
			const pkg = JSON.parse(text) as { name?: string; version?: string; main?: string; exports?: Record<string, { default?: string } | string> };
			if (pkg.name !== SDK_PACKAGE) {
				continue;
			}
			const root = pkg.exports?.['.'];
			const relative = (typeof root === 'string' ? root : root?.default) ?? pkg.main ?? 'sdk.mjs';
			const version = pkg.version ?? '0.0.0';
			return { dir, entry: path.join(dir, relative), version, compat: version.startsWith(`${TESTED_SDK_SERIES}.`) ? 'ok' : 'untested' };
		} catch {
			continue;
		}
	}
	return undefined;
}

/** The message shown when the SDK is not installed. */
export function sdkMissingMessage(location: SdkLocation): string {
	const where = location.userDataDir ? path.join(location.userDataDir, 'engines', 'claude') : 'a folder of your choice';
	return `The Claude Code engine needs the Claude Agent SDK, which is not installed. Install it with:\n`
		+ `  npm install --prefix "${where}" ${SDK_PACKAGE}\n`
		+ `or set "stormcoder.engine.claudeCode.sdkPath" to the folder that holds it. Until then, set "stormcoder.engine" back to "builtin".`;
}

/** Loads the SDK module. `importer` is injectable so tests need no real package. */
export async function loadClaudeSdk(
	location: SdkLocation,
	importer: (url: string) => Promise<unknown> = url => import(url),
	find: (location: SdkLocation) => FoundSdk | undefined = findSdk,
): Promise<{ sdk: SdkModule; found: FoundSdk }> {
	const found = find(location);
	if (!found) {
		throw new Error(sdkMissingMessage(location));
	}
	const mod = await importer(pathToFileURL(found.entry).href) as Partial<SdkModule>;
	if (typeof mod.query !== 'function') {
		throw new Error(`${found.entry} does not export query(); it is not a supported Claude Agent SDK.`);
	}
	return { sdk: mod as SdkModule, found };
}

// --- one turn ------------------------------------------------------------------------------------

/** Everything one engine turn needs. */
export interface EngineTurn {
	/** The Stormcoder chat id. */
	readonly sessionId: string;
	/** The user's message. */
	readonly prompt: string;
	readonly images?: readonly ChatImage[];
	/** The workspace folder. */
	readonly cwd: string;
	readonly route: SessionRoute;
	/** `ask` and `plan` are read-only; only `agent` may change things. */
	readonly mode: 'ask' | 'plan' | 'agent';
	/** The run's resolved guardrails (remote approval floor already applied). */
	readonly guardrails: Guardrails;
	readonly approver: ToolApprover;
	readonly trusted: boolean;
	readonly signal: AbortSignal;
	/** The engine's own session id from an earlier turn of this chat. */
	readonly resumeId?: string;
	/** A one-time summary for a chat that was started under the other engine. */
	readonly transcriptSeed?: string;
	/** Stormcoder's memory block, appended to the harness prompt. Off by default: it costs tokens every turn. */
	readonly appendPrompt?: string;
	readonly maxTurns?: number;
	/** Wall-clock ceiling for the turn in ms; 0 or absent for none. The built-in agent has the same limit. */
	readonly maxRunMs?: number;
	/** The main model's context window, so the harness compacts at the right size. */
	readonly contextWindow: number;
	readonly loadProjectSettings: boolean;
	readonly auth: 'gateway' | 'own-login';
	readonly cliPath?: string;
	/** A short chat title; given to the harness so it does not spend a model call inventing one. */
	readonly title?: string;
}

/** What the chat UI is told as the harness works. Mirrors `AgentCallbacks`. */
export interface EngineCallbacks {
	onStepStart(): void;
	onToken(delta: string): void;
	onStepEnd(content: string): void;
	onToolStart(call: ToolCall, parentCallId?: string): void;
	onToolEnd(call: ToolCall, result: string, isError: boolean, parentCallId?: string): void;
	onNote(text: string): void;
	onTodos?(items: TodoItem[]): void;
	/** Real token usage for one request, from the gateway. */
	onUsage?(usage: GatewayUsage): void;
}

/** A finished turn. */
export interface EngineResult extends RunResult {
	readonly sessionId?: string;
	/** The harness's own running cost estimate for this chat, USD. */
	readonly costUsd?: number;
}

/**
 * Switches off the harness's own background features that make extra model calls or reach
 * Anthropic for reasons other than the user's request. Each one would otherwise be spend, or
 * traffic, the user never asked for.
 */
const QUIET_ENV: Record<string, string> = {
	DISABLE_TELEMETRY: '1',
	DISABLE_AUTOUPDATER: '1',
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
};

/**
 * The environment for the harness process: an allow-list of the parent's, then the gateway and
 * model variables. The SDK replaces its child's environment entirely with this, so nothing else
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) can leak through to the harness or the commands it runs.
 */
export function buildEngineEnv(
	parent: NodeJS.ProcessEnv,
	turn: Pick<EngineTurn, 'route' | 'auth' | 'contextWindow'>,
	gateway: { baseUrl: string; token: string } | undefined,
): Record<string, string> {
	const env = allowlistedEnv(parent);
	Object.assign(env, QUIET_ENV);
	if (turn.auth === 'gateway' && gateway) {
		Object.assign(env, {
			ANTHROPIC_BASE_URL: gateway.baseUrl,
			ANTHROPIC_AUTH_TOKEN: gateway.token,
			...engineModelEnv(turn.route),
			...compactionEnv(turn.route.main, turn.contextWindow),
		});
	}
	return env;
}

/** The harness tools offered to a run. Fewer tools mean a shorter prompt on every request. */
export function engineTools(upstream: UpstreamKind): string[] {
	// Only names from the SDK's published built-in list: a name it does not know could fail the whole start.
	const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'TodoWrite', 'Agent', 'ExitPlanMode', 'Skill'];
	return upstream === 'anthropic' ? [...tools, ...ANTHROPIC_ONLY_TOOLS] : tools;
}

/** The structural hook types we hand the SDK. */
interface PreToolInput { readonly tool_name: string; readonly tool_input?: unknown; readonly tool_use_id?: string; readonly agent_id?: string }
interface PostToolInput { readonly tool_name?: string; readonly tool_input?: unknown; readonly tool_response?: unknown; readonly tool_use_id?: string; readonly error?: unknown }

/**
 * The harness's own OS sandbox for its shell, from `stormcoder.agent.sandbox`: the same promise the
 * built-in loop makes (writes confined to the workspace; with `workspace-offline`, no network),
 * enforced by the harness because Stormcoder does not run its commands. Fails closed: if the sandbox
 * cannot start the harness stops, rather than running commands unprotected. Nothing when the setting
 * is off.
 */
export function sandboxSettings(g: Pick<Guardrails, 'sandbox' | 'sandboxWritablePaths'>): Record<string, unknown> | undefined {
	if (!g.sandbox || g.sandbox === 'off') {
		return undefined;
	}
	return {
		enabled: true,
		failIfUnavailable: true,
		allowUnsandboxedCommands: false,
		autoAllowBashIfSandboxed: false,
		...(g.sandbox === 'workspace-offline' ? { network: { allowedDomains: [], strictAllowlist: true } } : {}),
		...(g.sandboxWritablePaths?.length ? { filesystem: { allowWrite: [...g.sandboxWritablePaths] } } : {}),
	};
}

/**
 * The options for one `query()` call.
 *
 * Every setting that has a risky or costly default is stated explicitly: `settingSources` (omitted
 * loads user, project and local settings), `permissionMode` (omitted may pick a classifier that makes
 * its own model calls), and the background features (prompt suggestions, auto-memory, progress
 * summaries, title generation).
 */
export function buildQueryOptions(
	turn: EngineTurn,
	deps: { env: Record<string, string>; abort: AbortController; tracker: FileTracker; stderr: (data: string) => void; note?: (text: string) => void },
): Record<string, unknown> {
	const upstream = upstreamKind(turn.route.main);
	const readOnly = turn.mode !== 'agent' || !turn.trusted;
	const ctx = {
		guardrails: turn.guardrails, approver: turn.approver, root: turn.cwd,
		trusted: turn.trusted, readOnly, upstream,
		signal: deps.abort.signal, note: deps.note, state: { subagents: 0 },
	};
	const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
	const preToolUse = async (input: PreToolInput, toolUseId?: string): Promise<Record<string, unknown>> => {
		const toolInput = asObject(input.tool_input);
		const verdict = await decideToolUse(input.tool_name, toolInput, ctx, { fromSubagent: !!input.agent_id });
		if (verdict.behavior === 'deny') {
			return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.message } };
		}
		await deps.tracker.before(toolUseId ?? input.tool_use_id ?? '', input.tool_name, toolInput);
		return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}) } };
	};
	const afterToolUse = (event: 'PostToolUse' | 'PostToolUseFailure') => async (input: PostToolInput, toolUseId?: string): Promise<Record<string, unknown>> => {
		await deps.tracker.after(toolUseId ?? input.tool_use_id ?? '');
		const feedback = await postHooks(input.tool_name ?? '', asObject(input.tool_input), event === 'PostToolUse' ? input.tool_response : input.error, event === 'PostToolUseFailure', ctx);
		return feedback ? { hookSpecificOutput: { hookEventName: event, additionalContext: feedback } } : {};
	};
	const postToolUse = afterToolUse('PostToolUse');
	const failedToolUse = afterToolUse('PostToolUseFailure');

	const options: Record<string, unknown> = {
		cwd: turn.cwd,
		env: deps.env,
		abortController: deps.abort,
		// Stated, never defaulted: see the function comment.
		permissionMode: turn.mode === 'plan' ? 'plan' : 'default',
		settingSources: turn.trusted && turn.loadProjectSettings ? ['project'] : [],
		strictMcpConfig: true,
		tools: engineTools(upstream),
		disallowedTools: upstream === 'anthropic' ? [] : [...ANTHROPIC_ONLY_TOOLS],
		includePartialMessages: true,
		promptSuggestions: false,
		agentProgressSummaries: false,
		systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: true, ...(turn.appendPrompt ? { append: turn.appendPrompt } : {}) },
		settings: {
			...(sandboxSettings(turn.guardrails) ? { sandbox: sandboxSettings(turn.guardrails) } : {}),
			autoMemoryEnabled: false,
			autoDreamEnabled: false,
			promptSuggestionEnabled: false,
			// The harness signs commits "Co-Authored-By: Claude" and says it was generated by Claude
			// Code; that is untrue when another model wrote the change.
			...(upstream === 'anthropic' ? {} : { includeCoAuthoredBy: false, attribution: false }),
		},
		hooks: {
			// Fail closed: a hook that crashes must block the tool, not wave it through.
			PreToolUse: [{ hooks: [preToolUse], timeout: 3600, onFailure: 'block' }],
			PostToolUse: [{ hooks: [postToolUse] }],
			PostToolUseFailure: [{ hooks: [failedToolUse] }],
		},
		stderr: deps.stderr,
	};
	// Extended thinking is a Claude feature; a translated model has none.
	if (upstream !== 'anthropic') {
		options.thinking = { type: 'disabled' };
	}
	if (turn.resumeId) {
		options.resume = turn.resumeId;
	} else if (turn.title) {
		options.title = turn.title;
	}
	if (turn.maxTurns && turn.maxTurns > 0) {
		options.maxTurns = turn.maxTurns;
	}
	if (turn.cliPath) {
		options.pathToClaudeCodeExecutable = turn.cliPath;
	}
	return options;
}

/** The prompt: a string, or a one-message stream when the user attached images. */
export function buildPrompt(turn: Pick<EngineTurn, 'prompt' | 'images' | 'transcriptSeed'>): string | AsyncIterable<unknown> {
	const text = turn.transcriptSeed
		? `Summary of our earlier conversation (it happened before this session started):\n${turn.transcriptSeed}\n\nMy request now:\n${turn.prompt}`
		: turn.prompt;
	if (!turn.images?.length) {
		return text;
	}
	const message = {
		type: 'user',
		parent_tool_use_id: null,
		message: {
			role: 'user',
			content: [
				...turn.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
				{ type: 'text', text },
			],
		},
	};
	return (async function* () { yield message; })();
}

// --- message mapping -----------------------------------------------------------------------------

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** Text of a tool result's content. */
function resultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return (content as Block[]).map(b => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/** The checklist a `TodoWrite` call carries. */
export function todosOf(input: unknown): TodoItem[] {
	const list = (input as { todos?: unknown } | undefined)?.todos;
	if (!Array.isArray(list)) {
		return [];
	}
	return list.flatMap((entry): TodoItem[] => {
		const item = entry as { content?: unknown; status?: unknown };
		const status = TODO_STATUSES.find(s => s === item.status);
		return typeof item.content === 'string' && status ? [{ content: item.content, status }] : [];
	});
}

/**
 * Turns the SDK's message stream into UI callbacks. One instance per turn.
 *
 * With partial messages on, a model reply arrives as `stream_event`s (text, as it is written)
 * followed by complete `assistant` messages (one per block). Text is shown from the stream events;
 * tool calls are announced from the assistant messages. A sub-agent's messages carry
 * `parent_tool_use_id`, and its tool calls nest under the call that started it.
 */
export class MessageMapper {
	private stepOpen = false;
	private stepText = '';
	private readonly calls = new Map<string, ToolCall>();
	sessionId: string | undefined;
	costUsd: number | undefined;
	result: EngineResult | undefined;

	constructor(private readonly cb: EngineCallbacks) { }

	/** Handles one message. */
	handle(message: SdkMessage): void {
		switch (message.type) {
			case 'system': return this.system(message);
			case 'stream_event': return this.streamEvent(message);
			case 'assistant': return this.assistant(message);
			case 'user': return this.user(message);
			case 'result': return this.finish(message);
			default: return undefined;
		}
	}

	/** Closes a step left open by a stream that ended early. */
	flush(): void {
		this.closeStep();
	}

	private closeStep(): void {
		if (this.stepOpen) {
			this.stepOpen = false;
			this.cb.onStepEnd(this.stepText);
			this.stepText = '';
		}
	}

	private system(message: SdkMessage): void {
		if (message.subtype === 'init' && typeof message.session_id === 'string') {
			this.sessionId = message.session_id;
		} else if (message.subtype === 'compact_boundary') {
			this.cb.onNote('Earlier context was compacted to make room.');
		} else if (message.subtype === 'api_retry') {
			const status = message.error_status ? ` (HTTP ${String(message.error_status)})` : '';
			this.cb.onNote(`The model request failed${status}; retrying (attempt ${String(message.attempt)} of ${String(message.max_retries)}).`);
		}
	}

	private streamEvent(message: SdkMessage): void {
		if (message.parent_tool_use_id) {
			return; // a sub-agent's text stays inside its tool card
		}
		const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
		if (event?.type === 'message_start') {
			this.closeStep();
			this.stepOpen = true;
			this.stepText = '';
			this.cb.onStepStart();
		} else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
			if (!this.stepOpen) {
				this.stepOpen = true;
				this.cb.onStepStart();
			}
			this.stepText += event.delta.text;
			this.cb.onToken(event.delta.text);
		} else if (event?.type === 'message_stop') {
			this.closeStep();
		}
	}

	private assistant(message: SdkMessage): void {
		const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;
		const blocks = ((message.message as { content?: Block[] } | undefined)?.content ?? []);
		if (!parent && !this.stepOpen) {
			// Partial messages were not delivered for this reply: show its text whole.
			const text = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text as string).join('');
			if (text) {
				this.cb.onStepStart();
				this.cb.onToken(text);
				this.cb.onStepEnd(text);
			}
		}
		for (const block of blocks) {
			if (block.type !== 'tool_use' || !block.id || !block.name) {
				continue;
			}
			const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
			const call = toStormcoderCall(block.id, block.name, input);
			this.calls.set(block.id, call);
			if (block.name === 'TodoWrite' && !parent) {
				this.cb.onTodos?.(todosOf(input));
			}
			this.cb.onToolStart(call, parent);
		}
	}

	private user(message: SdkMessage): void {
		const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;
		const content = (message.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) {
			return;
		}
		for (const block of content as Block[]) {
			if (block.type !== 'tool_result' || !block.tool_use_id) {
				continue;
			}
			const call = this.calls.get(block.tool_use_id) ?? { id: block.tool_use_id, name: 'tool', args: {} };
			this.cb.onToolEnd(call, resultText(block.content), block.is_error === true, parent);
		}
	}

	private finish(message: SdkMessage): void {
		this.closeStep();
		if (typeof message.session_id === 'string') {
			this.sessionId = message.session_id;
		}
		if (typeof message.total_cost_usd === 'number') {
			this.costUsd = message.total_cost_usd;
		}
		const errors = Array.isArray(message.errors) ? (message.errors as unknown[]).map(String).join('; ') : '';
		const text = typeof message.result === 'string' ? message.result : '';
		let reason: StopReason = 'done';
		let detail: string | undefined;
		if (message.subtype === 'success' && message.is_error !== true) {
			reason = 'done';
		} else if (message.subtype === 'error_max_turns' || message.subtype === 'error_max_budget_usd') {
			reason = 'limit';
			detail = message.subtype === 'error_max_turns' ? 'The engine reached its turn limit before finishing.' : 'The engine reached its spending limit before finishing.';
		} else {
			reason = 'error';
			detail = errors || text || 'The Claude Code engine stopped with an error.';
		}
		this.result = { reason, detail, sessionId: this.sessionId, costUsd: this.costUsd, ...(reason === 'error' ? { failure: new Error(detail) } : {}) };
	}
}

// --- the engine ----------------------------------------------------------------------------------

/** The part of the gateway an engine uses. */
export type GatewayLike = Pick<AnthropicGateway, 'baseUrl' | 'registerSession'>;

/** What an engine needs from the app. */
export interface ClaudeEngineDeps {
	/** The running gateway, or undefined when it has not been started. Read per turn, so it may start lazily. */
	readonly gateway: () => GatewayLike | undefined;
	/** Loads the SDK (injectable). */
	readonly load: () => Promise<SdkModule>;
	/** The parent environment to filter. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
}

/** Runs chat turns through the Claude Code harness. */
export class ClaudeEngine {
	constructor(private readonly deps: ClaudeEngineDeps) { }

	/** Runs one turn to completion. Throws an AbortError when `turn.signal` aborts. */
	async run(turn: EngineTurn, cb: EngineCallbacks): Promise<EngineResult> {
		const sdk = await this.deps.load();
		const gateway = turn.auth === 'gateway' ? this.deps.gateway() : undefined;
		if (turn.auth === 'gateway' && !gateway) {
			throw new Error('The engine gateway is not running.');
		}
		const gatewaySession = gateway ? gateway.registerSession({
			id: turn.sessionId, route: turn.route, onUsage: u => cb.onUsage?.(u), onNotice: text => cb.onNote(text),
		}) : undefined;
		const abort = new AbortController();
		const onAbort = (): void => { abort.abort(); };
		turn.signal.addEventListener('abort', onAbort, { once: true });
		if (turn.signal.aborted) {
			abort.abort();
		}
		let stderr = '';
		const tracker = new FileTracker(turn.cwd, turn.approver);
		const mapper = new MessageMapper(cb);
		let query: SdkQuery | undefined;
		let timedOut = false;
		const timer = turn.maxRunMs && turn.maxRunMs > 0 ? setTimeout(() => {
			timedOut = true;
			abort.abort();
			void query?.interrupt().catch(() => undefined);
		}, turn.maxRunMs) : undefined;
		const limitResult = (): EngineResult => ({
			reason: 'limit', sessionId: mapper.sessionId, costUsd: mapper.costUsd,
			detail: `The Claude Code engine was stopped after ${Math.round((turn.maxRunMs ?? 0) / 60_000)} minutes (stormcoder.agent.maxRunMinutes). Send "continue" to carry on.`,
		});
		try {
			const env = buildEngineEnv(this.deps.env ?? process.env, turn, gatewaySession && gateway ? { baseUrl: gateway.baseUrl, token: gatewaySession.token } : undefined);
			const options = buildQueryOptions(turn, { env, abort, tracker, stderr: data => { stderr = (stderr + data).slice(-2_000); }, note: text => cb.onNote(text) });
			query = sdk.query({ prompt: buildPrompt(turn), options });
			for await (const message of query) {
				mapper.handle(message);
			}
			mapper.flush();
		} catch (err) {
			mapper.flush();
			if (timedOut && !turn.signal.aborted) {
				return limitResult();
			}
			if (turn.signal.aborted || isAbortError(err)) {
				throw new DOMException('Aborted', 'AbortError');
			}
			const detail = `${err instanceof Error ? err.message : String(err)}${stderr.trim() ? `\n${stderr.trim()}` : ''}`;
			return { reason: 'error', detail, failure: err instanceof Error ? err : new Error(detail), sessionId: mapper.sessionId, costUsd: mapper.costUsd };
		} finally {
			if (timer) { clearTimeout(timer); }
			turn.signal.removeEventListener('abort', onAbort);
			gatewaySession?.dispose();
			try { query?.close(); } catch { /* already closed */ }
		}
		if (turn.signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		if (timedOut) {
			return limitResult();
		}
		return mapper.result ?? { reason: 'error', detail: 'The Claude Code engine ended without a result.', sessionId: mapper.sessionId, costUsd: mapper.costUsd };
	}
}
