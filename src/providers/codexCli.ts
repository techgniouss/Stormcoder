/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildPrompt } from './claudeCodeCli';
import { allowlistedEnv } from './childEnv';
import { ChatProvider, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult } from './types';

/** Binary name resolved from PATH when `stormcoder.codex-cli.cliPath` is unset. */
const DEFAULT_BINARY = 'codex';

/** The model name that means "whatever the Codex CLI would use". */
export const CODEX_DEFAULT_MODEL = 'default';

/** Grace period after SIGTERM before an aborted child is force-killed. */
const KILL_GRACE_MS = 3000;

/** How much of the CLI's output an error message may quote. */
const TAIL_CHARS = 500;

/** The CLI's wording when its sign-in is missing or lapsed. */
const AUTH_FAILURE = /not logged in|log ?in|sign ?in|unauthori[sz]ed|401|authenticat|api key|credential/i;

/** Model names the CLI takes; nothing a shell would interpret. */
const SAFE_MODEL = /^[\w.:@\/-]+$/;

/** Said to the model so it uses the sandbox it is in instead of trying to change things. */
const READ_ONLY_NOTE = 'You are running in a read-only sandbox, in the project folder. Read any files you need to answer; '
	+ 'you cannot and must not modify anything. Reply with your answer only.';

/**
 * A reviewer that runs the user's own, already-installed Codex CLI (`codex exec`) in a **read-only
 * sandbox**, so a second opinion from a different model family can read the real repository, not
 * just the diff it is handed, without any ability to change it.
 *
 * What this deliberately is not: an engine. It has no tools of Stormcoder's, never writes, and is
 * never offered `supportsTools`, so it can only ever serve a text phase such as Auto's review. Pin it
 * explicitly (`stormcoder.auto.reviewModel` = `codex-cli:default`); it is never chosen automatically.
 *
 * Safety is by construction, not by prompt:
 *  - `--sandbox read-only` is hard-coded and not configurable;
 *  - the process gets an allow-listed environment, so no Stormcoder provider key reaches it;
 *  - in a folder the user has not trusted it runs in an empty temporary folder instead of the project,
 *    because repository text in an untrusted folder is attacker-controlled input to an agent;
 *  - `codex exec` is non-interactive, so it can never stop to ask for approval.
 *
 * Authentication is whatever `codex login` already stored; Stormcoder never reads or stores it. The
 * binary is a local subprocess, the same narrow exception to the fetch-only provider rule that
 * {@link ClaudeCodeCliProvider} makes.
 */
export class CodexCliProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'codex-cli',
		label: 'Codex CLI (local, read-only)',
		suggestedModels: [CODEX_DEFAULT_MODEL],
		apiKeyUrl: '',
		requiresApiKey: false,
		supportsTools: false,
		toolModelPatterns: [],
		// Unmatchable: no image is ever sent (the prompt goes in as text), so the UI must not offer one.
		visionModelPatterns: ['^\\x00$'],
	};

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		if (request.signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		const cliPath = vscode.workspace.getConfiguration('stormcoder').get<string>('codex-cli.cliPath')?.trim();
		const binary = cliPath || DEFAULT_BINARY;
		const model = request.model.trim();
		if (model && !SAFE_MODEL.test(model)) {
			throw new Error(`Codex CLI: "${model}" is not a valid model name.`);
		}
		// Hard-coded, never a setting: this provider's one promise is that it cannot change anything.
		const args = ['exec', '--experimental-json', '--sandbox', 'read-only', '--skip-git-repo-check'];
		if (model && model !== CODEX_DEFAULT_MODEL) {
			args.push('--model', model);
		}
		const folder = reviewFolder();
		const prompt = `${READ_ONLY_NOTE}\n\n${buildPrompt(request.messages)}`;
		// npm installs the CLI on Windows as `codex.cmd`, which Node will not spawn without a shell. The
		// arguments are fixed flags and the checked model, and the folder is the process's working
		// directory rather than an argument, so only the binary needs quoting.
		const viaShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(binary);
		const env = allowlistedEnv(process.env, ['CODEX_HOME', 'CODEX_API_KEY']);

		try {
			return await new Promise<StreamChatResult>((resolve, reject) => {
				let child;
				try {
					child = viaShell
						? spawn([`"${binary}"`, ...args].join(' '), { cwd: folder.path, env, windowsHide: true, shell: true })
						: spawn(binary, args, { cwd: folder.path, env, windowsHide: true });
				} catch (err) {
					reject(new Error(installHint(binary, err instanceof Error ? err.message : String(err))));
					return;
				}

				let aborted = false;
				let settled = false;
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				let stderr = '';
				let stdoutTail = '';
				let pending = '';
				const answers: string[] = [];
				let failure: string | undefined;

				const settle = (fn: () => void): void => {
					if (settled) { return; }
					settled = true;
					request.signal.removeEventListener('abort', onAbort);
					if (killTimer) { clearTimeout(killTimer); }
					fn();
				};
				const onAbort = (): void => {
					aborted = true;
					if (process.platform === 'win32' && child.pid !== undefined) {
						spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
						return;
					}
					child.kill('SIGTERM');
					killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
				};
				request.signal.addEventListener('abort', onAbort, { once: true });

				const handle = (line: string): void => {
					const trimmed = line.trim();
					if (!trimmed) { return; }
					stdoutTail = (stdoutTail + trimmed + '\n').slice(-TAIL_CHARS);
					let event: { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
					try {
						event = JSON.parse(trimmed);
					} catch {
						return; // not an event line
					}
					if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
						const text = answers.length ? `\n\n${event.item.text}` : event.item.text;
						answers.push(event.item.text);
						request.onToken(text);
					} else if (event.type === 'turn.failed') {
						failure = event.error?.message ?? 'The Codex turn failed.';
					} else if (event.type === 'error' && event.message) {
						failure = event.message;
					}
				};

				child.stdin?.on('error', () => { /* reported through 'close' */ });
				child.stdin?.end(prompt);
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (chunk: string) => {
					pending += chunk;
					let newline = pending.indexOf('\n');
					while (newline >= 0) {
						handle(pending.slice(0, newline));
						pending = pending.slice(newline + 1);
						newline = pending.indexOf('\n');
					}
				});
				child.stderr?.setEncoding('utf8');
				child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });

				child.on('error', err => {
					settle(() => {
						const code = (err as NodeJS.ErrnoException).code;
						reject(code === 'ENOENT' ? new Error(installHint(binary)) : new Error(`Codex CLI: failed to start (${err.message}).`));
					});
				});
				child.on('close', code => {
					settle(() => {
						handle(pending);
						if (aborted) {
							reject(new DOMException('Aborted', 'AbortError'));
							return;
						}
						if (code === 0 && answers.length) {
							resolve({ truncated: false });
							return;
						}
						const detail = (failure ?? (stderr.trim() || stdoutTail.trim())).slice(0, 500).replace(/[.\s]+$/, '');
						const hint = AUTH_FAILURE.test(detail) ? ' Run `codex login` in a terminal, then retry.' : '';
						if (code === 0) {
							reject(new Error(`Codex CLI returned no answer${detail ? `: ${detail}` : ''}.${hint}`));
							return;
						}
						reject(new Error(`Codex CLI exited with code ${code}${detail ? `: ${detail}` : ''}.${hint}`));
					});
				});
			});
		} finally {
			folder.dispose();
		}
	}

	// The model list is the CLI's own default; Codex model names change faster than this app.
	async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}

/** Friendly install/PATH guidance when the binary can't be found or spawned. */
function installHint(binary: string, detail?: string): string {
	return `Codex CLI ('${binary}') was not found${detail ? ` (${detail})` : ''}. Install the Codex CLI `
		+ 'and make sure \'codex\' is on your PATH, or set "stormcoder.codex-cli.cliPath" to its full path.';
}

/** Where the reviewer runs, and how to clean it up. */
interface ReviewFolder {
	readonly path: string;
	dispose(): void;
}

/**
 * The trusted workspace folder, so the reviewer can read the real code; otherwise a fresh empty
 * folder, so a repository the user has not trusted is never handed to an agent as input.
 */
function reviewFolder(): ReviewFolder {
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (workspace && vscode.workspace.isTrusted) {
		return { path: workspace, dispose: () => { } };
	}
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stormcoder-codex-'));
	return { path: empty, dispose: () => { fs.rmSync(empty, { recursive: true, force: true }); } };
}
