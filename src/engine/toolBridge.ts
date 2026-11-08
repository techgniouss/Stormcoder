/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileWrite } from '../agent/checkpoint';
import { Guardrails, autoApproves, autoApprovesWrites, checkCommand, checkPath } from '../agent/guardrails';
import { ApprovalRequest, ToolApprover, isPrivateHost, normalizeToolCall } from '../agent/tools';
import { ToolCall } from '../providers/types';
import { ANTHROPIC_ONLY_TOOLS, UpstreamKind } from './capabilities';

/**
 * The enforcement point between the Claude Code harness and the machine.
 *
 * The harness runs its own tools, so Stormcoder cannot wrap them the way it wraps its own. Instead
 * every call passes through here first (from a `PreToolUse` hook) and is mapped to the equivalent
 * Stormcoder tool, so the same hard guardrails, protected paths, workspace confinement, trust rule
 * and approval policy (with the remote approval floor already applied to `guardrails`) decide it.
 *
 * Anything the bridge does not recognise is denied: an allow-list, not a deny-list, because the
 * harness gains tools with every release.
 */

/** The bridge's answer for one tool call. */
export type ToolVerdict =
	| { readonly behavior: 'allow' }
	| { readonly behavior: 'deny'; readonly message: string };

/** What the bridge needs to know about the run it is guarding. */
export interface BridgeContext {
	/** The run's resolved guardrails (approval policy and remote floor already applied). */
	readonly guardrails: Guardrails;
	/** Asks the user. Its `recordWrite` feeds Undo. */
	readonly approver: ToolApprover;
	/** The workspace folder (a file-system path), if one is open. */
	readonly root: string | undefined;
	/** Whether the folder is trusted: untrusted folders are read-only. */
	readonly trusted: boolean;
	/** Ask and Plan runs may read but never write or run commands. */
	readonly readOnly: boolean;
	/** Which kind of model serves the run; hosted-tool support depends on it. */
	readonly upstream: UpstreamKind;
}

/** Tools that touch nothing outside the harness's own bookkeeping. */
const HARNESS_ONLY_TOOLS = new Set([
	'TodoWrite', 'Agent', 'Task', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch', 'Skill',
	'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
]);

/** Read tools that take a path. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/** Tools that change files. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A string argument, or ''. */
function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The path a file tool names, whichever of the harness's argument names it used. */
function pathOf(input: Record<string, unknown>): string {
	return str(input.file_path) || str(input.notebook_path) || str(input.path);
}

/**
 * Turns a path the harness supplied (absolute, or relative to the workspace) into a
 * workspace-relative one, or an error when it points outside the folder.
 */
export function relativeToRoot(root: string, raw: string): { readonly ok: true; readonly rel: string } | { readonly ok: false; readonly error: string } {
	const resolved = path.resolve(root, raw);
	const rel = path.relative(root, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return { ok: false, error: `Path "${raw}" is outside the workspace folder and was blocked.` };
	}
	return { ok: true, rel: (rel || '.').split(path.sep).join('/') };
}

/** The first word of a command, for approval identities ("always allow `npm` here"). */
function commandSignature(command: string): string {
	return `run_command:${command.trim().split(/\s+/)[0] ?? ''}`;
}

function deny(message: string): ToolVerdict {
	return { behavior: 'deny', message };
}

/** The user's refusal, with their reason when they gave one. */
function refused(action: string, feedback?: string): ToolVerdict {
	return deny(`The user declined this ${action}.${feedback ? ` They said: ${feedback}` : ''}`);
}

/** Asks and returns a verdict. */
async function ask(approver: ToolApprover, request: ApprovalRequest, action: string): Promise<ToolVerdict> {
	const { approved, feedback } = await approver.confirm(request);
	return approved ? { behavior: 'allow' } : refused(action, feedback);
}

/**
 * Decides one tool call.
 *
 * `toolName` and `input` are exactly what the harness is about to run. Never throws: an internal
 * failure is a denial, so a bug here can only block work, never skip a check.
 */
export async function decideToolUse(toolName: string, input: Record<string, unknown>, ctx: BridgeContext): Promise<ToolVerdict> {
	try {
		return await decide(toolName, input, ctx);
	} catch (err) {
		return deny(`Stormcoder could not check "${toolName}" (${err instanceof Error ? err.message : String(err)}), so it was blocked.`);
	}
}

async function decide(toolName: string, input: Record<string, unknown>, ctx: BridgeContext): Promise<ToolVerdict> {
	const g = ctx.guardrails;
	if (toolName === 'ExitPlanMode' && ctx.readOnly) {
		// In a read-only chat the plan is the reply itself; "exiting" plan mode would invite writes.
		return deny('Write your plan as your final reply instead. The user starts the work in Agent mode.');
	}
	if (HARNESS_ONLY_TOOLS.has(toolName)) {
		return { behavior: 'allow' };
	}

	if (toolName === 'WebSearch') {
		return ANTHROPIC_ONLY_TOOLS.includes(toolName) && ctx.upstream !== 'anthropic'
			? deny('Web search only works with Claude models on the Anthropic API. Use WebFetch on a known page, or pick a Claude model.')
			: { behavior: 'allow' };
	}

	if (toolName === 'WebFetch') {
		let url: URL;
		try {
			url = new URL(str(input.url));
		} catch {
			return deny('WebFetch needs a valid URL.');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return deny(`WebFetch only fetches http and https addresses, not ${url.protocol}`);
		}
		const privateHost = isPrivateHost(url.hostname);
		if (!privateHost && autoApproves(g)) {
			return { behavior: 'allow' };
		}
		return ask(ctx.approver, {
			kind: 'command',
			signature: privateHost ? `fetch_url_private:${url.host}` : `fetch_url:${url.host}`,
			title: privateHost ? 'Fetch a local or private-network URL?' : 'Fetch a URL?',
			detail: privateHost
				? `${url.host} is a loopback, link-local or private-network address (it may expose local services or cloud metadata).`
				: `The agent wants to read ${url.host} over the network.`,
			preview: url.toString(),
			previewLanguage: 'text',
		}, 'fetch');
	}

	if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName) && toolName !== 'Bash') {
		return deny(`The tool "${toolName}" is not available in Stormcoder's Claude Code engine.`);
	}

	const root = ctx.root;
	if (!root) {
		return deny('No workspace folder is open; file and command tools are unavailable.');
	}
	const rootUri = vscode.Uri.file(root);

	if (READ_TOOLS.has(toolName)) {
		const raw = pathOf(input);
		if (!raw) {
			return { behavior: 'allow' }; // Glob and Grep default to the working directory, which is the workspace.
		}
		const rel = relativeToRoot(root, raw);
		if (!rel.ok) {
			return deny(rel.error);
		}
		const check = checkPath(rootUri, rel.rel, false, g);
		return check.ok ? { behavior: 'allow' } : deny(check.reason ?? 'Path blocked.');
	}

	// Everything left changes something.
	if (!ctx.trusted) {
		return deny(`This workspace is not trusted, so the agent can't ${toolName === 'Bash' ? 'run commands' : 'write files'}. Trust the folder, then retry.`);
	}
	if (ctx.readOnly) {
		return deny(`This chat is read-only (Ask or Plan), so ${toolName === 'Bash' ? 'commands' : 'file changes'} are not allowed. Switch to Agent mode to make changes.`);
	}

	if (toolName === 'Bash') {
		const command = str(input.command);
		if (!command.trim()) {
			return deny('An empty command was supplied.');
		}
		if (input.run_in_background === true) {
			return deny('Background commands are not available in this engine yet. Run the command in the foreground.');
		}
		const guard = checkCommand(command, g);
		if (!guard.ok) {
			return deny(guard.reason ?? 'Command blocked.');
		}
		if (autoApproves(g)) {
			return { behavior: 'allow' };
		}
		return ask(ctx.approver, {
			kind: 'command',
			signature: `${commandSignature(command)}@${root}`,
			title: 'Run a command?',
			detail: `In ${root} (timeout ${Math.round(g.commandTimeoutMs / 1000)}s).`,
			preview: command,
			previewLanguage: 'shell',
		}, 'command');
	}

	// Write, Edit, MultiEdit, NotebookEdit.
	const raw = pathOf(input);
	if (!raw) {
		return deny('An empty path was supplied.');
	}
	const rel = relativeToRoot(root, raw);
	if (!rel.ok) {
		return deny(rel.error);
	}
	const check = checkPath(rootUri, rel.rel, true, g);
	if (!check.ok) {
		return deny(check.reason ?? 'Path blocked.');
	}
	if (autoApprovesWrites(g)) {
		return { behavior: 'allow' };
	}
	const existing = await readText(path.resolve(root, rel.rel));
	return ask(ctx.approver, {
		kind: 'write',
		signature: `write_file:${rel.rel}`,
		title: existing === undefined ? `Create ${rel.rel}?` : `Change ${rel.rel}?`,
		detail: describeWrite(toolName, input),
		preview: previewWrite(toolName, input),
		previewLanguage: toolName === 'Write' ? '' : 'diff',
	}, 'change');
}

/** One line saying what a write will do. */
function describeWrite(toolName: string, input: Record<string, unknown>): string {
	if (toolName === 'Write') {
		return `${str(input.content).split('\n').length} line(s).`;
	}
	if (toolName === 'MultiEdit') {
		const edits = Array.isArray(input.edits) ? input.edits.length : 0;
		return `${edits} edit(s).`;
	}
	return 'Edit.';
}

/** The text the approval card shows for a write: the new content, or the replaced and replacement text. */
function previewWrite(toolName: string, input: Record<string, unknown>): string {
	const clip = (text: string): string => (text.length > 4_000 ? `${text.slice(0, 4_000)}\n… [truncated]` : text);
	if (toolName === 'Write') {
		return clip(str(input.content));
	}
	const edits = toolName === 'MultiEdit' && Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [input];
	return clip(edits.map(e => `- ${str(e.old_string).split('\n').join('\n- ')}\n+ ${str(e.new_string).split('\n').join('\n+ ')}`).join('\n'));
}

/** A file's text, or undefined when it does not exist or cannot be read as text. */
async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * The Stormcoder form of a harness tool call, for the transcript and for Undo bookkeeping. Names
 * and arguments are converted by the same normalizer the built-in loop uses.
 */
export function toStormcoderCall(id: string, name: string, input: Record<string, unknown>): ToolCall {
	if (name === 'MultiEdit') {
		const edits = Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [];
		return normalizeToolCall({
			id, name: 'edit_file',
			args: { path: pathOf(input), edits: edits.map(e => ({ oldText: str(e.old_string), newText: str(e.new_string), replaceAll: e.replace_all === true })) },
		});
	}
	return normalizeToolCall({ id, name, args: input });
}

/**
 * Records what each file looked like before and after the harness changed it, so Undo works the same
 * in both engines. `before` is called from `PreToolUse` (after approval), `after` from `PostToolUse`.
 * Only the file tools are tracked, exactly like the built-in loop; what a shell command changed is
 * outside what can be captured.
 */
export class FileTracker {
	private readonly pending = new Map<string, { abs: string; rel: string; before: string | undefined }>();

	constructor(private readonly root: string | undefined, private readonly approver: ToolApprover) { }

	/** Captures the file's current text for a write tool call. */
	async before(toolUseId: string, toolName: string, input: Record<string, unknown>): Promise<void> {
		if (!this.root || !WRITE_TOOLS.has(toolName)) {
			return;
		}
		const rel = relativeToRoot(this.root, pathOf(input));
		if (!rel.ok) {
			return;
		}
		const abs = path.resolve(this.root, rel.rel);
		this.pending.set(toolUseId, { abs, rel: rel.rel, before: await readText(abs) });
	}

	/** Records the write once the tool has run. A failed call that changed nothing records nothing. */
	async after(toolUseId: string): Promise<void> {
		const entry = this.pending.get(toolUseId);
		this.pending.delete(toolUseId);
		if (!entry) {
			return;
		}
		const after = await readText(entry.abs);
		if (after === undefined || after === entry.before) {
			return;
		}
		const write: FileWrite = { uri: vscode.Uri.file(entry.abs), path: entry.rel, before: entry.before, after };
		this.approver.recordWrite?.(write);
	}

	/** Forgets a call whose tool failed. */
	discard(toolUseId: string): void {
		this.pending.delete(toolUseId);
	}
}
