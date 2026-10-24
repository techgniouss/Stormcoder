/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolCall } from '../providers/types';
import { asBoolean, commandTextOf, isVerificationCommand, normalizeToolCall } from './tools';

/** Most characters the digest keeps; the oldest lines are dropped first. */
const MAX_DIGEST_CHARS = 3_000;
/** Characters of a command's output (its tail, where errors land) kept per line. */
const OUTPUT_TAIL_CHARS = 200;

/**
 * Condenses one run's tool calls into a short digest of what was read, changed and run.
 *
 * Tool results are not kept in a session between turns, so without this a follow-up such as
 * "now handle the null case there" reached the model with only its own narration: it had to
 * re-read every file the previous run had already seen. The digest names the paths and the
 * commands (with the end of their output), which is what lets it go straight back to them.
 */
export class WorkLog {
	private readonly lines: string[] = [];
	private readonly changed = new Set<string>();
	private verifiedSinceWrite = false;

	/** Records one finished top-level tool call. */
	record(raw: ToolCall, result: string, isError: boolean): void {
		const call = normalizeToolCall(raw);
		const path = typeof call.args.path === 'string' ? call.args.path : '';
		const flag = isError ? ' (failed)' : '';
		let line: string | undefined;
		if (!isError) {
			if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'edit_notebook') && path) {
				this.changed.add(path);
				this.verifiedSinceWrite = false;
			} else if (call.name === 'run_command' && !asBoolean(call.args.background) && isVerificationCommand(commandTextOf(call.args))) {
				this.verifiedSinceWrite = true;
			}
		}
		switch (call.name) {
			case 'read_file':
				line = `read ${path}${call.args.offset ? ` from line ${String(call.args.offset)}` : ''}${flag}`;
				break;
			case 'list_dir':
				line = `listed ${path || '.'}${flag}`;
				break;
			case 'write_file':
				line = `wrote ${path}${flag}`;
				break;
			case 'edit_file':
				line = `edited ${path}${flag}`;
				break;
			case 'edit_notebook':
				line = `edited notebook ${path} (cell ${String(call.args.cell ?? '?')})${flag}`;
				break;
			case 'search_files':
				line = `searched for "${String(call.args.query ?? '').slice(0, 60)}"${flag}`;
				break;
			case 'glob_files':
				line = `globbed ${String(call.args.pattern ?? '').slice(0, 60)}${flag}`;
				break;
			case 'run_command': {
				const out = result.trim().slice(-OUTPUT_TAIL_CHARS).replace(/\s+/g, ' ');
				line = `ran \`${commandTextOf(call.args).slice(0, 120)}\`${flag}${out ? ` → …${out}` : ''}`;
				break;
			}
			case 'fetch_url':
				line = `fetched ${String(call.args.url ?? '').slice(0, 100)}${flag}`;
				break;
			default:
				break;
		}
		if (line) {
			this.lines.push(`- ${line}`);
		}
	}

	/** Paths this run wrote or edited successfully, in the order first changed. */
	changedFiles(): string[] {
		return [...this.changed];
	}

	/** Whether a verification command passed after the last successful write. */
	verified(): boolean {
		return this.verifiedSinceWrite;
	}

	/** The digest, newest activity kept when it has to be cut. Empty when nothing was recorded. */
	render(): string {
		let text = this.lines.join('\n');
		if (text.length > MAX_DIGEST_CHARS) {
			text = `- … earlier activity omitted\n${text.slice(text.length - MAX_DIGEST_CHARS).replace(/^[^\n]*\n/, '')}`;
		}
		return text;
	}
}
