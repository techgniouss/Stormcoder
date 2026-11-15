/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Visual replies: a page the agent wrote, shown inside a chat. The page is text a model
 * produced, possibly after reading something untrusted, so it is treated as hostile: it
 * runs in a frame with no origin of its own and no way to reach the network, the app or the
 * chat around it. This module is the one place those limits are written down; the Electron
 * app and the browser dev host both serve pages with exactly these headers.
 */

/** The largest page that is stored or served. */
export const MAX_PAGE_BYTES = 512 * 1024;

/**
 * The policy a page is served with.
 *
 *  - `sandbox allow-scripts`: scripts run, but the page has an opaque origin, so no cookies,
 *    no storage, no same-origin access to the app, no forms, no popups, no top navigation.
 *    Sent as a header, so it holds even if the page is opened outside the chat's own frame.
 *  - `default-src 'none'` with only inline script and style, and images and fonts from
 *    `data:`: nothing is fetched from anywhere, which is what stops a page from sending out
 *    whatever a model was talked into putting in it.
 */
export const PAGE_CSP = [
	`sandbox allow-scripts`,
	`default-src 'none'`,
	`script-src 'unsafe-inline'`,
	`style-src 'unsafe-inline'`,
	`img-src data:`,
	`font-src data:`,
	`base-uri 'none'`,
	`form-action 'none'`,
].join('; ');

/** The response headers every page is served with. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy': PAGE_CSP,
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
};

/** A page id is 16 lowercase hex characters: the only thing a page URL may name. */
export function isPageId(id: unknown): id is string {
	return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
}

/** What is served when a page id is unknown or the page is gone. */
export const MISSING_PAGE = '<!doctype html><meta charset="utf-8"><title>Page</title><p style="font:14px system-ui;color:#888;padding:16px">This page is no longer available.</p>';
