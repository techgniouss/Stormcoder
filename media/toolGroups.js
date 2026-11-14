// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The words on a folded run of tool cards ("Ran 2 commands, edited 3 files and 4 more").
 * Pure, no DOM: main.js owns the folding, this owns what a group is called, so the wording
 * can be tested without a browser.
 */
(function (root) {
	'use strict';

	/** A run of finished cards folds into one group from this many cards up. */
	const MIN_GROUP = 3;

	/** Most telling first: what changed the project outranks what only looked at it. */
	const ORDER = /** @type {const} */ (['command', 'edit', 'read', 'search', 'other']);

	/** @type {Record<string, [string, string, string]>} verb, singular noun, plural noun */
	const WORDS = {
		command: ['ran', 'command', 'commands'],
		edit: ['edited', 'file', 'files'],
		read: ['read', 'file', 'files'],
		search: ['ran', 'search', 'searches'],
		other: ['made', 'other call', 'other calls'],
	};

	/**
	 * What kind of work a tool call is. MCP tools and anything unrecognised are `other`.
	 * @param {string} name
	 * @returns {'command' | 'edit' | 'read' | 'search' | 'other'}
	 */
	function category(name) {
		switch (name) {
			case 'run_command': return 'command';
			case 'write_file': case 'edit_file': return 'edit';
			case 'read_file': case 'list_dir': return 'read';
			case 'search_files': case 'glob_files': case 'fetch_url': return 'search';
			default: return 'other';
		}
	}

	/**
	 * One line for a folded run of calls: at most two kinds by name, the rest as a count.
	 * @param {readonly string[]} names tool names, one per card
	 * @returns {string}
	 */
	function summarize(names) {
		/** @type {Record<string, number>} */
		const counts = {};
		for (const name of names) {
			const kind = category(String(name));
			counts[kind] = (counts[kind] || 0) + 1;
		}
		const present = ORDER.filter(kind => counts[kind]);
		if (!present.length) {
			return 'No calls';
		}
		const named = present.slice(0, 2).map(kind => {
			const [verb, one, many] = WORDS[kind];
			return `${verb} ${counts[kind]} ${counts[kind] === 1 ? one : many}`;
		});
		const rest = present.slice(2).reduce((n, kind) => n + counts[kind], 0);
		let text = named.join(', ');
		if (rest) {
			text += ` and ${rest} more`;
		}
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	root.StormToolGroups = { MIN_GROUP, category, summarize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
