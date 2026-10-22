/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs the same Controller as the app, but serves the shell over HTTP and talks to it over a
 * WebSocket instead of Electron IPC. It exists so the real engine and the real UI can be driven
 * in an ordinary browser — for development, and for the end-to-end tests. Nothing here ships.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller } from '../host/controller';
import { ASSET_ORIGIN } from '../host/vscode';
import { prepareViewHtml } from './viewHtml';
import * as extension from '../src/extension';

const appRoot = path.resolve(process.env.MJ_APP_ROOT ?? path.join(__dirname));
const userDataDir = path.resolve(process.env.MJ_USER_DATA ?? path.join(process.cwd(), '.dev-data'));
const port = Number(process.env.MJ_PORT ?? 0);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown' };

let socket: WebSocket | undefined;
const key = crypto.randomBytes(32);

const controller = new Controller({
	appRoot,
	userDataDir,
	uriScheme: 'mjolnir',
	appVersion: 'dev',
	platform: process.platform,
	secureStorage: false,
	codec: {
		encrypt: plain => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
		decrypt: data => { const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
	},
	send: (channel, payload) => { if (socket?.readyState === 1) { socket.send(JSON.stringify({ channel, payload })); } },
	openExternal: async () => true,
	readClipboard: async () => '',
	writeClipboard: async () => undefined,
	pickFolder: async () => process.env.MJ_FOLDER,
	pickFiles: async () => undefined,
	confirmTrust: async () => 'trust',
	showFatal: (title, detail) => console.error(title, detail),
}, extension, prepareViewHtml);

/** The app serves assets from a custom scheme; over HTTP the same references point at this server. */
function rewrite(text: string, origin: string): string {
	return text.split(ASSET_ORIGIN).join(origin);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const origin = `http://${req.headers.host}`;
	const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
	const parts = rel.split('/');
	if (parts[0] === 'view') {
		const html = controller.getViewHtml(parts[1]) ?? '<!doctype html><title>Starting</title>';
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(rewrite(html, origin));
		return;
	}
	const file = path.resolve(appRoot, rel === '' ? 'shell/index.html' : rel);
	if (!['media', 'shell', 'skills', 'relay-pwa'].includes(parts[0]) && rel !== '' || !file.startsWith(appRoot + path.sep)) {
		res.writeHead(404).end('Not found');
		return;
	}
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end('Not found'); return; }
		const ext = path.extname(file);
		const body = /\.(html|js|css)$/.test(ext) ? Buffer.from(rewrite(data.toString('utf8'), origin)) : data;
		res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
	});
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
	socket = ws;
	controller.rendererGone();
	ws.on('close', () => { if (socket === ws) { socket = undefined; controller.rendererGone(); } });
	ws.on('message', async raw => {
		const m = JSON.parse(String(raw)) as { call: string; id?: number; args: unknown[] };
		try {
			const value = await controller.handleCall(m.call, m.args);
			if (m.id !== undefined) { ws.send(JSON.stringify({ reply: m.id, value })); }
		} catch (err) {
			if (m.id !== undefined) { ws.send(JSON.stringify({ reply: m.id, error: err instanceof Error ? err.message : String(err) })); }
		}
	});
});

server.listen(port, '127.0.0.1', async () => {
	const addr = server.address();
	const actual = typeof addr === 'object' && addr ? addr.port : port;
	if (process.env.MJ_FOLDER) {
		await controller.openFolder(process.env.MJ_FOLDER);
	} else {
		await controller.start();
	}
	console.log(`MJOLNIR_DEV http://127.0.0.1:${actual}/shell/index.html?port=${actual}`);
});

process.on('SIGTERM', () => { void controller.shutdown().finally(() => process.exit(0)); });
