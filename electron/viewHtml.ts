/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ASSET_ORIGIN } from '../host/vscode';

/**
 * Adapts the HTML the chat code generates for an editor webview to an iframe in the shell:
 * the messaging bridge goes in ahead of every other script, and the Content-Security-Policy
 * keeps its nonce rule but also admits scripts from the app's own asset origin (the bridge,
 * which has no nonce because it is static).
 *
 * Nothing else is rewritten — the chat UI's own markup and scripts run exactly as authored.
 */
export function prepareViewHtml(html: string): string {
	const bridge = `<script src="${ASSET_ORIGIN}/shell/bridge.js"></script>`;
	let out = html.replace(/script-src ('nonce-[^']+')/, `script-src $1 ${ASSET_ORIGIN}`);
	out = out.replace(/(<link [^>]*rel="stylesheet"[^>]*>)/, `$1\n\t<link href="${ASSET_ORIGIN}/shell/theme.css" rel="stylesheet" />`);
	out = out.replace(/<\/body>/, `<script src="${ASSET_ORIGIN}/shell/frame.js"></script>\n</body>`);
	return out.includes('<body') ? out.replace(/(<body[^>]*>)/, `$1\n\t${bridge}`) : bridge + out;
}
