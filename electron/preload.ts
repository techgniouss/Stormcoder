/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';

type Listener<T> = (payload: T) => void;

function subscribe<T>(channel: string, listener: Listener<T>): () => void {
	const wrapped = (_e: unknown, payload: T) => listener(payload);
	ipcRenderer.on(channel, wrapped);
	return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * The only door between the shell page and the main process. Everything is a named,
 * fixed-purpose call — the page cannot reach `ipcRenderer` or any channel not listed here.
 */
contextBridge.exposeInMainWorld('stormcoder', {
	ready: () => ipcRenderer.send('renderer:ready'),
	sendToView: (view: string, message: unknown) => ipcRenderer.send('view:message', view, message),
	respond: (id: number, value: unknown) => ipcRenderer.send('ui:response', id, value),
	command: (id: string, ...args: unknown[]) => ipcRenderer.invoke('app:command', id, ...args),
	readFile: (file: string) => ipcRenderer.invoke('file:read', file),
	writeFile: (file: string, text: string) => ipcRenderer.invoke('file:write', file, text),
	openDialog: (opts: unknown) => ipcRenderer.invoke('dialog:open', opts),
	onViewMessage: (cb: Listener<{ view: string; message: unknown }>) => subscribe('view:message', cb),
	onViewReload: (cb: Listener<{ view: string }>) => subscribe('view:reload', cb),
	onRequest: (cb: Listener<{ id: number; req: unknown }>) => subscribe('ui:request', cb),
	onEvent: (cb: Listener<unknown>) => subscribe('ui:event', cb),
	onState: (cb: Listener<unknown>) => subscribe('app:state', cb),
	onNavigate: (cb: Listener<{ view: string }>) => subscribe('app:navigate', cb),
	onPalette: (cb: Listener<unknown>) => subscribe('app:palette', cb),
	onUpdate: (cb: Listener<unknown>) => subscribe('app:update', cb),
});
