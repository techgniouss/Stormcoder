/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import * as path from 'path';

export interface MenuActions {
	openFolder(): void;
	closeFolder(): void;
	command(id: string): void;
	navigate(view: string): void;
	palette(): void;
	getWindow(): BrowserWindow | undefined;
	recent(): string[];
	openRecent(folder: string): void;
	checkForUpdates(): void;
	appName: string;
}

/** The native menu: file/project actions, standard edit and view roles, and navigation. */
export function buildMenu(a: MenuActions): Menu {
	const isMac = process.platform === 'darwin';
	const recent = a.recent();
	const template: MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
		{
			label: 'File',
			submenu: [
				{ label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => a.command('openvsChat.newChat') },
				{ type: 'separator' },
				{ label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: a.openFolder },
				{
					label: 'Open Recent',
					enabled: recent.length > 0,
					submenu: recent.map(f => ({ label: `${path.basename(f)}  —  ${f}`, click: () => a.openRecent(f) })),
				},
				{ label: 'Close Project Folder', click: a.closeFolder },
				{ type: 'separator' },
				{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => a.navigate('settings') },
				{ type: 'separator' },
				isMac ? { role: 'close' } : { role: 'quit' },
			],
		},
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{ label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: a.palette },
				{ type: 'separator' },
				{ label: 'Chat', accelerator: 'CmdOrCtrl+1', click: () => a.navigate('chat') },
				{ label: 'History', accelerator: 'CmdOrCtrl+2', click: () => a.navigate('history') },
				{ label: 'Skills', accelerator: 'CmdOrCtrl+3', click: () => a.navigate('skills') },
				{ label: 'MCP Servers', accelerator: 'CmdOrCtrl+4', click: () => a.navigate('mcp') },
				{ type: 'separator' },
				{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
				{ role: 'toggleDevTools' },
			],
		},
		{ role: 'windowMenu' },
		{
			role: 'help',
			submenu: [
				{ label: 'Check for Updates…', click: a.checkForUpdates },
				{ label: `${a.appName} on GitHub`, click: () => void shell.openExternal('https://github.com/techgniouss/mjolnir') },
			],
		},
	];
	return Menu.buildFromTemplate(template);
}
