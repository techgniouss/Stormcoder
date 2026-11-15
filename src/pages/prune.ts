/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/** A stored page is kept at least this long, whatever refers to it. */
export const PAGE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** The ids of every page a transcript shows: its entries' `page.id` values. */
export function pageIdsIn(transcripts: Iterable<readonly { readonly page?: { readonly id?: unknown } }[] | undefined>): Set<string> {
	const ids = new Set<string>();
	for (const messages of transcripts) {
		for (const entry of messages ?? []) {
			const id = entry?.page?.id;
			if (typeof id === 'string') {
				ids.add(id);
			}
		}
	}
	return ids;
}

/**
 * Deletes stored pages that no open chat and no saved conversation shows any more. Only
 * files this app wrote are touched (`<16 hex>.html`, directly in `dir`), and only once they
 * are older than `minAgeMs`, so a page shown moments ago is never removed before the chat
 * that shows it has been saved. Returns how many were removed. Never throws: a page that
 * cannot be removed is left for the next start.
 */
export function prunePages(dir: string, referenced: ReadonlySet<string>, now: number = Date.now(), minAgeMs: number = PAGE_MIN_AGE_MS): number {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const match = /^([0-9a-f]{16})\.html$/.exec(name);
		if (!match || referenced.has(match[1])) {
			continue;
		}
		const file = path.join(dir, name);
		try {
			const stat = fs.lstatSync(file);
			if (stat.isFile() && now - stat.mtimeMs >= minAgeMs) {
				fs.unlinkSync(file);
				removed++;
			}
		} catch {
			// Left in place; tried again on the next start.
		}
	}
	return removed;
}
