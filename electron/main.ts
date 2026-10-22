/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, safeStorage, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Controller } from '../host/controller';
import { HostEnvironment, readJsonFile, writeJsonFile } from '../host/env';
import { prepareViewHtml } from './viewHtml';
import { buildMenu } from './menu';
import * as extension from '../src/extension';

/** Looks for a newer release on GitHub; only meaningful in an installed build. */
async function checkForUpdates(interactive: boolean): Promise<void> {
	if (!app.isPackaged) {
		if (interactive) {
			void dialog.showMessageBox({ message: 'Updates are only checked in an installed build.' });
		}
		return;
	}
	try {
		const { autoUpdater } = await import('electron-updater');
		autoUpdater.autoDownload = true;
		if (interactive) {
			autoUpdater.once('update-not-available', () => void dialog.showMessageBox({ message: `You are on the latest version (${app.getVersion()}).` }));
		}
		autoUpdater.once('update-downloaded', info => {
			void dialog.showMessageBox({ type: 'info', message: `Mjolnir ${info.version} is ready.`, detail: 'It installs when you quit, or restart now.', buttons: ['Restart Now', 'Later'], defaultId: 0 })
				.then(r => { if (r.response === 0) { autoUpdater.quitAndInstall(); } });
		});
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error('update check failed', err);
		if (interactive) {
			dialog.showErrorBox('Update check failed', err instanceof Error ? err.message : String(err));
		}
	}
}

const SCHEME = 'mjolnir';
const ASSET_SCHEME = 'mjolnir-asset';
const APP_NAME = 'Mjolnir';

protocol.registerSchemesAsPrivileged([
	{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const appRoot = path.join(app.getAppPath(), 'dist');
const userDataDir = app.getPath('userData');
const windowFile = path.join(userDataDir, 'window.json');

let window: BrowserWindow | undefined;
let controller: Controller;

/**
 * Secrets use the OS keychain through `safeStorage`. Where none exists (a bare Linux
 * session), AES-256-GCM under a random key in a 0600 file — which protects the secrets file
 * on its own but not against another process running as the same user; the shell says so.
 */
function secretCodec(): Pick<HostEnvironment, 'encrypt' | 'decrypt'> {
	if (safeStorage.isEncryptionAvailable()) {
		return { encrypt: plain => safeStorage.encryptString(plain), decrypt: data => safeStorage.decryptString(data) };
	}
	const keyFile = path.join(userDataDir, 'secret.key');
	let key: Buffer;
	if (fs.existsSync(keyFile)) {
		key = Buffer.from(fs.readFileSync(keyFile, 'utf8'), 'base64');
	} else {
		key = crypto.randomBytes(32);
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
	}
	return {
		encrypt: plain => {
			const iv = crypto.randomBytes(12);
			const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
			const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), body]);
		},
		decrypt: data => {
			const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
			decipher.setAuthTag(data.subarray(12, 28));
			return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
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

function createWindow(): void {
	const b = readJsonFile<WindowBounds | undefined>(windowFile, undefined);
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

function handleDeepLink(url: string): void {
	if (url.startsWith(`${SCHEME}://`)) {
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
		controller = new Controller({
			appRoot,
			userDataDir,
			uriScheme: SCHEME,
			appVersion: app.getVersion(),
			platform: process.platform,
			secureStorage: safeStorage.isEncryptionAvailable(),
			codec: secretCodec(),
			send: (channel, payload) => { if (window && !window.isDestroyed()) { window.webContents.send(channel, payload); } },
			openExternal: async url => { await shell.openExternal(url); return true; },
			readClipboard: async () => clipboard.readText(),
			writeClipboard: async text => clipboard.writeText(text),
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
			appName: APP_NAME,
		}));
		createWindow();
		await controller.start();
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
