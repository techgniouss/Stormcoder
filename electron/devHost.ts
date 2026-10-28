/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
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
import { createSecretCodec } from './secrets';
import { prepareViewHtml } from './viewHtml';
import * as extension from '../src/extension';
import { UpdateService, UpdaterBackend } from '../host/updater';

const appRoot = path.resolve(process.env.MJ_APP_ROOT ?? path.join(__dirname));
const userDataDir = path.resolve(process.env.MJ_USER_DATA ?? path.join(process.cwd(), '.dev-data'));
const port = Number(process.env.MJ_PORT ?? 0);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown' };

let socket: WebSocket | undefined;
const key = crypto.randomBytes(32);

type Codec = { encrypt(plain: string): Buffer; decrypt(data: Buffer): string };
const throwaway: Codec = {
	encrypt: plain => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
	decrypt: data => { const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
};

/**
 * With `MJ_APP_KEYS=1`, and only when this bundle is run by Electron itself (`electron dist/dev-host.js`),
 * secrets are read with the app's real codec — the OS keychain, or the file key in `MJ_USER_DATA` —
 * instead of a throwaway one. That is what lets the benchmark use the keys a user already saved in
 * the app. Anywhere else (plain Node, the tests) this stays off and secrets are per-process.
 */
let appCodec: Codec | undefined;
const appCodecReady: Promise<void> = process.env.MJ_APP_KEYS === '1' && process.versions.electron
	? (async () => {
		// `electron` is external to this bundle and only resolves to the real module inside Electron.
		const { app, safeStorage } = await import('electron');
		app.setName('Stormcoder');
		await app.whenReady();
		appCodec = createSecretCodec({ userDataDir, safeStorage, log: (level, ...parts) => console.error(level, ...parts) });
	})()
	: Promise.resolve();

/**
 * With `MJ_FAKE_UPDATE=<version>` the browser dev host pretends a release is found and downloads it,
 * so the shell's update UI can be driven end to end (the tests do) without a packaged build or GitHub.
 */
const fakeUpdates = process.env.MJ_FAKE_UPDATE
	? new UpdateService({
		version: 'dev',
		canSelfUpdate: true,
		repo: 'techgniouss/Stormcoder',
		initialDelayMs: 0,
		backend: async () => {
			const listeners: Record<string, Array<(...args: any[]) => void>> = {};
			const emit = (event: string, ...args: any[]) => (listeners[event] ?? []).forEach(l => l(...args));
			return {
				autoDownload: true,
				autoInstallOnAppQuit: true,
				on: (event: string, l: (...args: any[]) => void) => { (listeners[event] ??= []).push(l); },
				checkForUpdates: async () => {
					const version = process.env.MJ_FAKE_UPDATE!;
					if (version === 'none') { emit('update-not-available'); return; }
					emit('update-available', { version });
					for (const percent of [20, 60, 100]) { await new Promise(r => setTimeout(r, 150)); emit('download-progress', { percent }); }
					emit('update-downloaded', { version });
				},
				quitAndInstall: () => console.error('fake update installed'),
			} as unknown as UpdaterBackend;
		},
	})
	: undefined;

const controller = new Controller({
	appRoot,
	userDataDir,
	uriScheme: 'stormcoder',
	appVersion: 'dev',
	platform: process.platform,
	secureStorage: false,
	codec: {
		encrypt: plain => (appCodec ?? throwaway).encrypt(plain),
		decrypt: data => (appCodec ?? throwaway).decrypt(data),
	},
	send: (channel, payload) => { if (socket?.readyState === 1) { socket.send(JSON.stringify({ channel, payload })); } },
	openExternal: async () => true,
	readClipboard: async () => '',
	writeClipboard: async () => undefined,
	pickFolder: async () => process.env.MJ_FOLDER,
	pickFiles: async () => undefined,
	confirmTrust: async () => 'trust',
	showFatal: (title, detail) => console.error(title, detail),
	updates: fakeUpdates,
}, extension, prepareViewHtml);

/** The app serves assets from a custom scheme; over HTTP the same references point at this server. */
function rewrite(text: string, origin: string): string {
	return text.split(ASSET_ORIGIN).join(origin);
}

/** Whether a Host / Origin header names this machine's loopback (blocks other websites and DNS rebinding). */
function isLoopbackHost(hostHeader: string | undefined): boolean {
	return typeof hostHeader === 'string' && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHeader);
}

function isLoopbackOrigin(origin: string | undefined): boolean {
	return origin === undefined || (/^https?:\/\//i.test(origin) && isLoopbackHost(origin.replace(/^https?:\/\//i, '')));
}

const server = http.createServer((req, res) => {
	if (!isLoopbackHost(req.headers.host)) {
		res.writeHead(403).end('Forbidden');
		return;
	}
	let rel: string;
	let url: URL;
	try {
		url = new URL(req.url ?? '/', 'http://localhost');
		rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
	} catch {
		res.writeHead(400).end('Bad request');
		return;
	}
	const origin = `http://${req.headers.host}`;
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

// A page on another website could otherwise open this socket and drive the engine (including
// file edits) as the user; browsers always send Origin, so anything not from loopback is refused.
const wss = new WebSocketServer({ server, verifyClient: (info: { origin: string; req: http.IncomingMessage }) => isLoopbackHost(info.req.headers.host) && isLoopbackOrigin(info.origin) });
wss.on('connection', ws => {
	socket = ws;
	controller.rendererGone();
	ws.on('close', () => { if (socket === ws) { socket = undefined; controller.rendererGone(); } });
	ws.on('message', async raw => {
		let m: { call: string; id?: number; args: unknown[] };
		try {
			m = JSON.parse(String(raw)) as { call: string; id?: number; args: unknown[] };
			if (typeof m?.call !== 'string' || !Array.isArray(m.args)) {
				throw new Error('malformed call');
			}
		} catch {
			return;
		}
		try {
			const value = await controller.handleCall(m.call, m.args);
			if (m.id !== undefined) { ws.send(JSON.stringify({ reply: m.id, value })); }
		} catch (err) {
			if (m.id !== undefined) { ws.send(JSON.stringify({ reply: m.id, error: err instanceof Error ? err.message : String(err) })); }
		}
	});
});

server.listen(port, '127.0.0.1', async () => {
	await appCodecReady;
	const addr = server.address();
	const actual = typeof addr === 'object' && addr ? addr.port : port;
	if (process.env.MJ_FOLDER) {
		await controller.openFolder(process.env.MJ_FOLDER);
	} else {
		await controller.start();
	}
	console.log(`STORMCODER_DEV http://127.0.0.1:${actual}/shell/index.html?port=${actual}`);
});

process.on('uncaughtException', err => { console.error('uncaught', err); });
process.on('unhandledRejection', err => { console.error('unhandled rejection', err); });
process.on('SIGTERM', () => { void controller.shutdown().finally(() => process.exit(0)); });
