/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One parsed `.gitignore` line. */
interface IgnoreRule {
	readonly re: RegExp;
	readonly negate: boolean;
	readonly dirOnly: boolean;
}

/**
 * The rules of one `.gitignore`, applied to paths relative to the folder holding it.
 * Covers what real files use: comments, negation, trailing-slash directory rules, anchored
 * and unanchored patterns, `*`, `?`, `**` and character classes.
 */
export class GitIgnore {
	private readonly rules: IgnoreRule[];

	constructor(text: string) {
		this.rules = [];
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.replace(/(?<!\\)\s+$/, '');
			if (!line || line.startsWith('#')) {
				continue;
			}
			const negate = line.startsWith('!');
			let pattern = negate ? line.slice(1) : line;
			const dirOnly = pattern.endsWith('/');
			pattern = pattern.replace(/\/+$/, '');
			if (!pattern) {
				continue;
			}
			const anchored = pattern.includes('/');
			pattern = pattern.replace(/^\//, '');
			this.rules.push({ re: ruleToRegExp(pattern, anchored), negate, dirOnly });
		}
	}

	/** Whether any rule matches; the last matching rule wins, as in git. `undefined` when none does. */
	ignores(relativePath: string, isDir: boolean): boolean | undefined {
		let result: boolean | undefined;
		for (const rule of this.rules) {
			if (rule.dirOnly && !isDir) {
				continue;
			}
			if (rule.re.test(relativePath)) {
				result = !rule.negate;
			}
		}
		return result;
	}
}

function ruleToRegExp(pattern: string, anchored: boolean): RegExp {
	let re = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '[') {
			const close = pattern.indexOf(']', i + 2);
			if (close < 0) {
				re += '\\[';
			} else {
				const body = pattern.slice(i + 1, close);
				re += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
				i = close;
			}
		} else if (c === '\\' && i + 1 < pattern.length) {
			re += pattern[++i].replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	// An unanchored pattern may match at any depth.
	return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}
