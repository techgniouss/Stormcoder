/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MenuItemConstructorOptions, net, protocol, safeStorage, screen, session, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Controller } from '../host/controller';
import { HostEnvironment, readJsonFile, writeJsonFile } from '../host/env';
import { prepareViewHtml } from './viewHtml';
import { buildMenu } from './menu';
import * as extension from '../src/extension';

let updaterWired = false;
/** What the next `update-not-available` / error should do; the listeners themselves are registered once. */
let updateInteractive = false;

/** Looks for a newer release on GitHub; only meaningful in an installed build. */
async function checkForUpdates(interactive: boolean): Promise<void> {
	if (!app.isPackaged) {
		if (interactive) {
			void dialog.showMessageBox({ message: 'Updates are only checked in an installed build.' });
		}
		return;
	}
	updateInteractive = interactive;
	try {
		const { autoUpdater } = await import('electron-updater');
		if (!updaterWired) {
			// Registered once: every manual check used to add another set, so one result showed N dialogs.
			updaterWired = true;
			autoUpdater.autoDownload = true;
			autoUpdater.on('update-not-available', () => {
				if (updateInteractive) {
					void dialog.showMessageBox({ message: `You are on the latest version (${app.getVersion()}).` });
				}
			});
			autoUpdater.on('update-downloaded', info => {
				void dialog.showMessageBox({ type: 'info', message: `Stormcoder ${info.version} is ready.`, detail: 'It installs when you quit, or restart now.', buttons: ['Restart Now', 'Later'], defaultId: 0 })
					.then(r => { if (r.response === 0) { autoUpdater.quitAndInstall(); } });
			});
			// Without a handler an updater 'error' event is thrown as an uncaught exception.
			autoUpdater.on('error', err => {
				logMain('error', 'updater error', err instanceof Error ? err : String(err));
			});
		}
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error('update check failed', err);
		if (updateInteractive) {
			dialog.showErrorBox('Update check failed', err instanceof Error ? err.message : String(err));
		}
	}
}

const SCHEME = 'stormcoder';
const ASSET_SCHEME = 'stormcoder-asset';
const APP_NAME = 'Stormcoder';

protocol.registerSchemesAsPrivileged([
	{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const appRoot = path.join(app.getAppPath(), 'dist');
const userDataDir = app.getPath('userData');
const windowFile = path.join(userDataDir, 'window.json');

let window: BrowserWindow | undefined;
let controller: Controller;

/** Appends to `logs/main.log`, trimming it when it grows past 2 MB so it never fills a disk. */
function logMain(level: string, ...parts: unknown[]): void {
	try {
		const file = path.join(userDataDir, 'logs', 'main.log');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) {
			fs.renameSync(file, file + '.old');
		}
		const text = parts.map(p => p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
		fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
	} catch {
		// logging must never take the app down
	}
}

for (const level of ['log', 'warn', 'error'] as const) {
	const original = console[level].bind(console);
	console[level] = (...args: unknown[]) => { original(...args); if (level !== 'log') { logMain(level, ...args); } };
}
process.on('uncaughtException', err => { logMain('fatal', err); });
process.on('unhandledRejection', reason => { logMain('error', 'unhandled rejection', reason instanceof Error ? reason : String(reason)); });

/**
 * Whether `safeStorage` is backed by a real keychain. On Linux Electron reports encryption as
 * available even when it fell back to the `basic_text` backend, which uses a hard-coded
 * password and protects nothing; that case is treated as unavailable.
 */
function keychainAvailable(): boolean {
	if (!safeStorage.isEncryptionAvailable()) {
		return false;
	}
	if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
		return safeStorage.getSelectedStorageBackend() !== 'basic_text';
	}
	return true;
}

/** Stored secret blobs start with this tag and a scheme letter, so a later change of backend is detected rather than misread. */
const BLOB_TAG = 'sc1:';

/** Loads the 32-byte AES key, creating it if missing. An invalid key file is kept aside, never silently overwritten. */
function loadSecretKey(): Buffer {
	const keyFile = path.join(userDataDir, 'secret.key');
	if (fs.existsSync(keyFile)) {
		const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
		if (key.length === 32) {
			return key;
		}
		const aside = `${keyFile}.invalid-${Date.now()}`;
		fs.renameSync(keyFile, aside);
		logMain('error', `secret.key was not a 32-byte key; moved to ${aside} and generated a new one. Secrets stored under the old key can no longer be read.`);
	}
	const key = crypto.randomBytes(32);
	fs.mkdirSync(userDataDir, { recursive: true });
	fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
	return key;
}

/**
 * Secrets use the OS keychain through `safeStorage`. Where none exists (a bare Linux
 * session), AES-256-GCM under a random key in a 0600 file — which protects the secrets file
 * on its own but not against another process running as the same user; the shell says so.
 * Blobs carry a scheme prefix; unprefixed blobs from earlier versions are still read.
 */
function secretCodec(): Pick<HostEnvironment, 'encrypt' | 'decrypt'> {
	const useKeychain = keychainAvailable();
	let key: Buffer | undefined;
	const aesKey = () => key ?? (key = loadSecretKey());
	const tag = Buffer.from(BLOB_TAG + (useKeychain ? 'k' : 'a'));
	const encryptRaw = (plain: string): Buffer => {
		if (useKeychain) {
			return safeStorage.encryptString(plain);
		}
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
		const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), body]);
	};
	const decryptRaw = (data: Buffer, keychain: boolean): string => {
		if (keychain) {
			return safeStorage.decryptString(data);
		}
		const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), data.subarray(0, 12));
		decipher.setAuthTag(data.subarray(12, 28));
		return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
	};
	return {
		encrypt: plain => Buffer.concat([tag, encryptRaw(plain)]),
		decrypt: data => {
			if (data.subarray(0, BLOB_TAG.length).toString() === BLOB_TAG) {
				const scheme = data.subarray(BLOB_TAG.length, BLOB_TAG.length + 1).toString();
				if ((scheme === 'k') !== useKeychain) {
					throw new Error(`This secret was stored with the ${scheme === 'k' ? 'OS keychain' : 'file key'}, which is not what is in use now.`);
				}
				return decryptRaw(data.subarray(BLOB_TAG.length + 1), useKeychain);
			}
			// Written before blobs were tagged: the scheme is whichever one is in use now.
			return decryptRaw(data, useKeychain);
		},
	};
}

function registerAssetProtocol(): void {
	const allowedTop = new Set(['media', 'shell', 'skills', 'relay-pwa']);
	protocol.handle(ASSET_SCHEME, request => {
		const url = new URL(request.url);
		const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
		const parts = rel.split('/');
		if (parts[0] === 'view') {
			return new Response(controller.getViewHtml(parts[1]) ?? '<!doctype html><title>Starting</title>', {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
			});
		}
		if (!allowedTop.has(parts[0])) {
			return new Response('Not found', { status: 404 });
		}
		const file = path.resolve(appRoot, rel);
		if (!file.startsWith(appRoot + path.sep)) {
			return new Response('Forbidden', { status: 403 });
		}
		return net.fetch(pathToFileURL(file).toString());
	});
}

interface WindowBounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }

/** Accepts saved window geometry only if it is sane: finite numbers, a usable size, and a position that is on a connected display. */
function validBounds(raw: unknown): WindowBounds | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
	const width = num(r.width);
	const height = num(r.height);
	if (width === undefined || height === undefined || width < 720 || height < 520 || width > 20_000 || height > 20_000) {
		return undefined;
	}
	const out: WindowBounds = { width, height, maximized: r.maximized === true };
	const x = num(r.x);
	const y = num(r.y);
	if (x !== undefined && y !== undefined) {
		// At least a corner of the title area must be visible, or the window opens where nobody can reach it.
		const visible = screen.getAllDisplays().some(d => {
			const a = d.workArea;
			return x + width > a.x + 80 && x < a.x + a.width - 80 && y >= a.y - 20 && y < a.y + a.height - 80;
		});
		if (visible) {
			out.x = x;
			out.y = y;
		}
	}
	return out;
}

let renderCrashes: number[] = [];

function createWindow(): void {
	const b = validBounds(readJsonFile<unknown>(windowFile, undefined));
	window = new BrowserWindow({
		width: b?.width ?? 1280,
		height: b?.height ?? 820,
		x: b?.x,
		y: b?.y,
		minWidth: 720,
		minHeight: 520,
		backgroundColor: '#171719',
		title: APP_NAME,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});
	if (b?.maximized) {
		window.maximize();
	}
	// Nothing the page does may navigate the window away or open another one; links go to the browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) {
			void shell.openExternal(url);
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', e => e.preventDefault());
	window.webContents.on('will-attach-webview', e => e.preventDefault());
	// Right-click in text fields and over selected text gets the usual Cut/Copy/Paste menu. Custom
	// menus (messages, code, tabs) call preventDefault in the page, which suppresses this event.
	window.webContents.on('context-menu', (_e, params) => {
		if (!params.isEditable && !params.selectionText) {
			return;
		}
		const items: MenuItemConstructorOptions[] = params.isEditable
			? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
			: [{ role: 'copy' }, { role: 'selectAll' }];
		Menu.buildFromTemplate(items).popup({ window });
	});
	window.webContents.on('render-process-gone', (_e, details) => {
		logMain('fatal', 'renderer gone', details);
		if (details.reason !== 'clean-exit') {
			// A page that crashes on load would otherwise reload in a tight loop; give up after 3 in a minute.
			const now = Date.now();
			renderCrashes = renderCrashes.filter(t => now - t < 60_000);
			renderCrashes.push(now);
			if (renderCrashes.length <= 3) {
				window?.reload();
			} else {
				dialog.showErrorBox('Stormcoder', 'The window keeps crashing, so it was not reloaded again. Restart the app; the log folder has details.');
			}
		}
	});
	window.on('close', () => {
		if (window && !window.isDestroyed() && !window.isMinimized()) {
			const maximized = window.isMaximized();
			const prior = readJsonFile<WindowBounds | undefined>(windowFile, undefined);
			writeJsonFile(windowFile, { ...(maximized ? prior : window.getBounds()), maximized });
		}
	});
	window.on('closed', () => { window = undefined; controller.rendererGone(); });
	// Only the shell page itself: iframe navigations (the chat and settings views) also fire
	// `did-start-loading`, and treating those as a reload would strand every queued message.
	window.webContents.on('did-start-navigation', details => {
		if (details.isMainFrame && !details.isSameDocument) {
			controller.rendererGone();
		}
	});
	void window.loadURL(`${ASSET_SCHEME}://app/shell/index.html`);
}

/** Links that arrived (macOS `open-url`, a second launch) before the engine finished starting. */
const pendingLinks: string[] = [];
let engineStarted = false;

function handleDeepLink(url: string): void {
	if (url.startsWith(`${SCHEME}://`)) {
		if (!engineStarted) {
			pendingLinks.push(url);
			return;
		}
		controller.deliverDeepLink(url);
		window?.show();
		window?.focus();
	}
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', (_e, argv) => {
		const link = argv.find(a => a.startsWith(`${SCHEME}://`));
		if (link) {
			handleDeepLink(link);
		}
		if (window) {
			if (window.isMinimized()) {
				window.restore();
			}
			window.focus();
		}
	});
	app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });
	app.setName(APP_NAME);
	if (process.defaultApp && process.argv[1]) {
		app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
	} else {
		app.setAsDefaultProtocolClient(SCHEME);
	}

	void app.whenReady().then(async () => {
		// The UI needs no camera, microphone, geolocation or notification access; refuse every request.
		session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
		session.defaultSession.setPermissionCheckHandler(() => false);
		controller = new Controller({
			appRoot,
			userDataDir,
			uriScheme: SCHEME,
			appVersion: app.getVersion(),
			platform: process.platform,
			secureStorage: keychainAvailable(),
			codec: secretCodec(),
			send: (channel, payload) => { if (window && !window.isDestroyed()) { window.webContents.send(channel, payload); } },
			openExternal: async url => { await shell.openExternal(url); return true; },
			readClipboard: async () => clipboard.readText(),
			writeClipboard: async text => clipboard.writeText(text),
			trashItem: file => shell.trashItem(file),
			pickFolder: async () => {
				const r = await dialog.showOpenDialog(window as BrowserWindow, { title: 'Open Project Folder', properties: ['openDirectory', 'createDirectory'] });
				return r.canceled ? undefined : r.filePaths[0];
			},
			pickFiles: async o => {
				const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [];
				if (o.files) { properties.push('openFile'); }
				if (o.folders) { properties.push('openDirectory'); }
				if (o.many) { properties.push('multiSelections'); }
				const r = await dialog.showOpenDialog(window as BrowserWindow, { title: o.title, defaultPath: o.defaultPath, properties });
				return r.canceled ? undefined : r.filePaths;
			},
			confirmTrust: async folder => {
				const r = await dialog.showMessageBox(window as BrowserWindow, {
					type: 'question',
					title: 'Trust this folder?',
					message: `Do you trust the authors of ${path.basename(folder)}?`,
					detail: 'In a trusted folder the agent can write files and run commands, and project MCP servers can start. Open it read-only to browse and ask questions without those powers.',
					buttons: ['Trust Folder', 'Open Read-Only', 'Cancel'],
					defaultId: 0,
					cancelId: 2,
				});
				return r.response === 0 ? 'trust' : r.response === 1 ? 'readonly' : 'cancel';
			},
			showFatal: (title, detail) => dialog.showErrorBox(title, detail),
			appCommand: id => {
				switch (id) {
					case 'app.checkUpdates': return void checkForUpdates(true);
					case 'app.openLogs': return void shell.openPath(path.join(userDataDir, 'logs'));
					case 'app.openGitHub': return void shell.openExternal('https://github.com/techgniouss/Stormcoder');
					case 'app.zoomIn': return window?.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5);
					case 'app.zoomOut': return window?.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5);
					case 'app.zoomReset': return window?.webContents.setZoomLevel(0);
					case 'app.quit': return app.quit();
					default: return undefined;
				}
			},
		}, extension, prepareViewHtml);

		ipcMain.on('renderer:ready', () => controller.rendererIsReady());
		ipcMain.on('view:message', (_e, view, message) => { void controller.handleCall('sendToView', [view, message]); });
		ipcMain.on('ui:response', (_e, id, value) => { void controller.handleCall('respond', [id, value]); });
		ipcMain.handle('app:command', (_e, id: string, ...args: unknown[]) => controller.handleCall('command', [id, ...args]));
		ipcMain.handle('file:read', (_e, file: string) => controller.handleCall('readFile', [file]));
		ipcMain.handle('file:write', (_e, file: string, text: string) => controller.handleCall('writeFile', [file, text]));
		ipcMain.handle('dialog:open', (_e, opts) => controller.handleCall('openDialog', [opts]));

		registerAssetProtocol();
		const nav = (view: string) => window?.webContents.send('app:navigate', { view });
		Menu.setApplicationMenu(buildMenu({
			openFolder: () => void controller.openFolder(),
			closeFolder: () => void controller.closeFolder(),
			command: id => void controller.handleCall('command', [id]),
			navigate: nav,
			palette: () => window?.webContents.send('app:palette', {}),
			getWindow: () => window,
			recent: () => controller.recentFolders(),
			openRecent: f => void controller.openFolder(f),
			checkForUpdates: () => void checkForUpdates(true),
			openLogs: () => void shell.openPath(path.join(userDataDir, 'logs')),
			appName: APP_NAME,
		}));
		createWindow();
		await controller.start();
		engineStarted = true;
		for (const queued of pendingLinks.splice(0)) {
			handleDeepLink(queued);
		}
		setTimeout(() => void checkForUpdates(false), 15_000);
		const link = process.argv.find(a => a.startsWith(`${SCHEME}://`));
		if (link) {
			handleDeepLink(link);
		}
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
	let closing = false;
	app.on('before-quit', e => {
		if (closing) {
			return;
		}
		e.preventDefault();
		closing = true;
		void controller.shutdown().finally(() => app.quit());
	});
}
