/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as vscode from 'vscode';

/** When a hook runs. */
export type HookEvent = 'PreToolUse' | 'PostToolUse';

/** One user-configured hook (`openvsChat.hooks`). */
export interface HookSpec {
	readonly event: HookEvent;
	/** Regular expression matched against the tool name; absent matches every tool. */
	readonly matcher?: string;
	/** Shell command. Receives the event as JSON on stdin. */
	readonly command: string;
	/** Kill the hook after this long. Default 10 seconds. */
	readonly timeoutMs?: number;
}

/** What a hook run decided. */
export interface HookOutcome {
	/** Set when a hook exited with code 2: the text to hand the model, and (for PreToolUse) a veto. */
	readonly feedback?: string;
	/** Hooks that failed to run or exited with another non-zero code, for a note to the user. */
	readonly warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FEEDBACK_CHARS = 4_000;

/** Reads `openvsChat.hooks`, dropping anything malformed instead of failing the run. */
export function loadHooks(): HookSpec[] {
	const raw = vscode.workspace.getConfiguration('openvsChat').get<unknown>('hooks');
	if (!Array.isArray(raw)) {
		return [];
	}
	const hooks: HookSpec[] = [];
	for (const entry of raw) {
		const h = entry as Partial<HookSpec> | null;
		if (h && (h.event === 'PreToolUse' || h.event === 'PostToolUse') && typeof h.command === 'string' && h.command.trim()) {
			hooks.push({
				event: h.event,
				matcher: typeof h.matcher === 'string' ? h.matcher : undefined,
				command: h.command,
				timeoutMs: typeof h.timeoutMs === 'number' && h.timeoutMs > 0 ? h.timeoutMs : undefined,
			});
		}
	}
	return hooks;
}

/** The hooks of `event` that apply to `toolName`. An invalid matcher matches nothing. */
export function matchingHooks(hooks: readonly HookSpec[], event: HookEvent, toolName: string): HookSpec[] {
	return hooks.filter(h => {
		if (h.event !== event) {
			return false;
		}
		if (!h.matcher) {
			return true;
		}
		try {
			return new RegExp(`^(?:${h.matcher})$`).test(toolName);
		} catch {
			return false;
		}
	});
}

/**
 * Runs every matching hook in order. Exit code 0 is silent; exit code 2 is feedback for the
 * model (and a veto for PreToolUse); any other outcome is a warning and never blocks the tool,
 * so a broken hook cannot wedge a run.
 */
export async function runHooks(
	hooks: readonly HookSpec[],
	event: HookEvent,
	payload: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal,
): Promise<HookOutcome> {
	const feedback: string[] = [];
	const warnings: string[] = [];
	// Hooks are commands; they follow the same trust rule as run_command.
	if (!vscode.workspace.isTrusted) {
		return { warnings };
	}
	for (const hook of matchingHooks(hooks, event, String(payload.tool ?? ''))) {
		if (signal?.aborted) {
			break;
		}
		const done = await runOne(hook, { event, ...payload }, cwd, signal);
		if (done.code === 2) {
			feedback.push(done.output.trim() || `The ${event} hook \`${hook.command}\` objected without saying why.`);
		} else if (done.code !== 0) {
			warnings.push(`${event} hook \`${hook.command}\` ${done.failure ?? `exited with code ${done.code}`}${done.output.trim() ? `: ${done.output.trim().slice(0, 200)}` : ''}`);
		}
	}
	return {
		feedback: feedback.length ? feedback.join('\n').slice(0, MAX_FEEDBACK_CHARS) : undefined,
		warnings,
	};
}

function runOne(hook: HookSpec, input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<{ code: number | null; output: string; failure?: string }> {
	return new Promise(resolve => {
		let output = '';
		let settled = false;
		const finish = (result: { code: number | null; output: string; failure?: string }) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				resolve(result);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(hook.command, { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (err) {
			resolve({ code: null, output: '', failure: `could not start (${err instanceof Error ? err.message : String(err)})` });
			return;
		}
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({ code: null, output, failure: 'timed out' });
		}, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const onAbort = () => { child.kill('SIGKILL'); finish({ code: null, output, failure: 'was cancelled' }); };
		signal?.addEventListener('abort', onAbort, { once: true });
		const add = (chunk: Buffer) => { if (output.length < 20_000) { output += chunk.toString(); } };
		child.stdout?.on('data', add);
		child.stderr?.on('data', add);
		child.on('error', err => finish({ code: null, output, failure: `could not run (${err.message})` }));
		child.on('close', code => finish({ code, output }));
		// A hook that never reads stdin must not turn the write into an unhandled EPIPE.
		child.stdin?.on('error', () => { /* ignored */ });
		child.stdin?.end(JSON.stringify(input));
	});
}
