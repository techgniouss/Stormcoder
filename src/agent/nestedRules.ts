/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveWorkspacePath } from './guardrails';

/** Files whose presence in a subdirectory scopes extra instructions to that directory. */
const NESTED_RULE_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** Characters of nested rules delivered per directory. */
const MAX_NESTED_CHARS = 4_000;

/**
 * Per-directory instructions, delivered when the agent first touches a file beneath them.
 *
 * The workspace-root rules are in the system prompt already. A monorepo's `packages/api/AGENTS.md`
 * is not, and cannot be: it would put every package's rules in every request. Delivering it
 * alongside the first result from that directory puts it in the conversation exactly when it
 * becomes relevant, once per run.
 */
export class NestedRules {
	/** Directories already probed this run (found or not), so each is read at most once. */
	private readonly probed = new Set<string>();

	/**
	 * The rules text to append to a tool result for `rawPath`, or '' when there is none or it
	 * was already delivered. Never throws: a missing file or folder just contributes nothing.
	 */
	async forPath(rawPath: string): Promise<string> {
		const target = resolveWorkspacePath(rawPath);
		if (!target) {
			return '';
		}
		const segments = target.relative.split('/').filter(s => s && s !== '.');
		// The file itself is not a directory; the root's own rules are already in the prompt.
		const dirs: string[] = [];
		for (let n = 1; n < segments.length; n++) {
			dirs.push(segments.slice(0, n).join('/'));
		}
		const parts: string[] = [];
		for (const dir of dirs) {
			const key = `${target.root.toString()}::${dir}`;
			if (this.probed.has(key)) {
				continue;
			}
			this.probed.add(key);
			for (const name of NESTED_RULE_FILES) {
				try {
					const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(target.root, dir, name));
					const text = new TextDecoder().decode(bytes).trim();
					if (text) {
						const shown = text.length > MAX_NESTED_CHARS ? `${text.slice(0, MAX_NESTED_CHARS)}\n…[truncated]` : text;
						parts.push(`[Instructions for ${dir}/ (from ${dir}/${name}) — follow them for files in this directory]\n${shown}`);
						break;
					}
				} catch {
					// Not present.
				}
			}
		}
		return parts.length ? `\n\n${parts.join('\n\n')}` : '';
	}
}
