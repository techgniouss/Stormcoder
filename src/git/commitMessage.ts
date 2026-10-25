/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { withProviderResilience } from '../providers/resilience';
import { isAbortError, streamChatWithContinuation } from '../providers/types';

/**
 * How much of the staged diff to hand the model. A large diff costs proportionally more and
 * risks tripping a small per-request token allowance (see `agentRunner.adoptRequestCeiling`
 * in the wider extension) for a task that only needs a summary, not the full text — mirrors
 * the 12k-char cap `rules.ts` applies to steering instructions.
 */
const DIFF_CHAR_CAP = 12_000;

/** Reply is a commit message, not code — no need for the extension's general `maxTokens` budget. */
const MAX_REPLY_TOKENS = 400;

const TRUNCATION_NOTICE = '\n\n[diff truncated — showing the first part only]';

/**
 * Builds the prompt sent to the model. Kept pure and exported so it can be unit-tested
 * without touching `vscode` or the Git extension.
 */
export function buildCommitMessagePrompt(diff: string): string {
	const truncated = diff.length > DIFF_CHAR_CAP;
	const body = truncated ? diff.slice(0, DIFF_CHAR_CAP) + TRUNCATION_NOTICE : diff;
	return 'Write a git commit message for the following staged changes. ' +
		'Follow the Conventional Commits style: a short imperative subject line (max 50 characters, ' +
		'no trailing period), optionally followed by a blank line and a brief body explaining the ' +
		'"why" if it isn\'t obvious from the diff. Reply with the commit message only — no markdown ' +
		'fences, no preamble, no explanation.\n\n' +
		`${'```diff'}\n${body}\n${'```'}`;
}

/**
 * Strips a single wrapping ``` fence some models add despite being told not to — common on
 * the smaller/free models this extension favors. Only strips when the fence wraps the
 * *entire* reply, so a fenced snippet inside a longer explanation is left alone rather than
 * mangled.
 */
export function stripWrappingFence(text: string): string {
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim());
	return match ? match[1].trim() : text;
}

/** Runs `git` in `cwd` and resolves with stdout; rejects with git's own message on failure. */
function git(args: string[], cwd: string, input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr.trim() || err.message));
			} else {
				resolve(stdout);
			}
		});
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

/**
 * Generates a commit message from the staged changes of the open project using whichever
 * provider is configured (`stormcoder.defaultProvider`), then offers to commit with it or copy
 * it. Reads the repository through the `git` command line, so it works wherever git is
 * installed — there is no editor Git extension to depend on.
 */
export async function generateCommitMessage(
	registry: ProviderRegistry,
	token: vscode.CancellationToken,
): Promise<void> {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		vscode.window.showErrorMessage('Open a project folder first.');
		return;
	}
	let diff: string;
	try {
		diff = await git(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv'], cwd);
	} catch (err) {
		vscode.window.showErrorMessage(`Could not read the staged changes: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (!diff.trim()) {
		vscode.window.showInformationMessage('No staged changes to generate a commit message from. Stage some with `git add` first.');
		return;
	}

	const providerId = registry.getDefaultProviderId();
	const provider = registry.getProvider(providerId);
	if (!provider) {
		vscode.window.showErrorMessage('No AI provider is configured.');
		return;
	}
	if (provider.info.requiresApiKey && !(await registry.hasCredentials(providerId))) {
		const action = await vscode.window.showErrorMessage(
			`No API key configured for ${provider.info.label}. Configure a provider to generate commit messages.`,
			'Configure Provider',
		);
		if (action) {
			await vscode.commands.executeCommand('stormcoder.configureProvider', providerId);
		}
		return;
	}

	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const sub = token.onCancellationRequested(() => controller.abort());

	let result: { text: string; truncated: boolean };
	try {
		const model = registry.getModel(providerId);
		// Continuation matters here even at a small maxTokens: a model that ignores the
		// brevity instruction and writes a long body would otherwise hand back a message
		// chopped off mid-sentence with no indication anything was cut.
		result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Writing a commit message…' },
			() => withProviderResilience(registry, providerId, model, apiKey => streamChatWithContinuation(provider, {
				messages: [{ role: 'user', content: buildCommitMessagePrompt(diff) }],
				model,
				apiKey,
				baseUrl: registry.getBaseUrl(providerId),
				maxTokens: MAX_REPLY_TOKENS,
				signal: controller.signal,
				onToken: () => { /* the progress notice is the only feedback while this runs */ },
			})));
	} catch (err) {
		if (isAbortError(err)) {
			return;
		}
		vscode.window.showErrorMessage(`Failed to generate commit message: ${err instanceof Error ? err.message : String(err)}`);
		return;
	} finally {
		sub.dispose();
	}

	const message = stripWrappingFence(result.text.trim());
	if (!message) {
		vscode.window.showWarningMessage(`${provider.info.label} returned an empty commit message.`);
		return;
	}
	const note = result.truncated ? '\n\n(It hit the model\'s output limit even after continuing, so it may be incomplete.)' : '';
	const action = await vscode.window.showInformationMessage(`Commit message:\n\n${message}${note}`, 'Commit', 'Copy');
	if (action === 'Copy') {
		await vscode.env.clipboard.writeText(message);
	} else if (action === 'Commit') {
		try {
			await git(['commit', '-F', '-'], cwd, message + '\n');
			vscode.window.showInformationMessage('Committed the staged changes.');
		} catch (err) {
			vscode.window.showErrorMessage(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** The draft in flight for the Changes view, so a second request or a Cancel can stop it. */
let draftAbort: AbortController | undefined;

/** Stops the draft the Changes view is waiting for, if any. */
export function cancelDraftCommitMessage(): void {
	draftAbort?.abort();
}

/**
 * Writes a commit message for what is staged in `cwd` and returns it, for the Changes view to
 * put in its message box. Unlike {@link generateCommitMessage} it asks nothing and shows no
 * notices: every problem is thrown as an `Error` whose text is fit to display.
 */
export async function draftCommitMessage(registry: ProviderRegistry, cwd: string): Promise<string> {
	const diff = await git(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv'], cwd);
	if (!diff.trim()) {
		throw new Error('Stage some changes first.');
	}
	const providerId = registry.getDefaultProviderId();
	const provider = registry.getProvider(providerId);
	if (!provider) {
		throw new Error('No AI provider is configured.');
	}
	if (provider.info.requiresApiKey && !(await registry.hasCredentials(providerId))) {
		throw new Error(`No API key configured for ${provider.info.label}.`);
	}
	draftAbort?.abort();
	const controller = new AbortController();
	draftAbort = controller;
	try {
		const model = registry.getModel(providerId);
		const result = await withProviderResilience(registry, providerId, model, apiKey => streamChatWithContinuation(provider, {
			messages: [{ role: 'user', content: buildCommitMessagePrompt(diff) }],
			model,
			apiKey,
			baseUrl: registry.getBaseUrl(providerId),
			maxTokens: MAX_REPLY_TOKENS,
			signal: controller.signal,
			onToken: () => { /* the view shows its own spinner */ },
		}));
		const message = stripWrappingFence(result.text.trim());
		if (!message) {
			throw new Error(`${provider.info.label} returned an empty commit message.`);
		}
		return message;
	} catch (err) {
		if (isAbortError(err)) {
			throw new Error('Cancelled.');
		}
		throw err;
	} finally {
		if (draftAbort === controller) {
			draftAbort = undefined;
		}
	}
}
