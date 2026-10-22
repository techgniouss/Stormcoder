/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/** The ids of the two webviews the chat code talks to. */
export type ViewId = 'chat' | 'settings';

/** One choice in a quick pick. */
export interface PickEntry {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;
}

/** A request the host makes of the desktop shell (toast, prompt, picker, progress, file dialog). */
export type UiRequest =
	| { kind: 'message'; level: 'info' | 'warn' | 'error'; text: string; detail?: string; modal: boolean; actions: string[] }
	| { kind: 'input'; title?: string; prompt?: string; placeholder?: string; value?: string; password?: boolean }
	| { kind: 'pick'; title?: string; placeholder?: string; many: boolean; items: PickEntry[] }
	| { kind: 'openDialog'; title?: string; folders: boolean; files: boolean; many: boolean; defaultPath?: string }
	| { kind: 'edit'; path: string };

/** A fire-and-forget notification to the shell. */
export type UiEvent =
	| { kind: 'progress'; id: number; title?: string; message?: string; done: boolean }
	| { kind: 'status'; id: string; text: string; tooltip?: string; visible: boolean }
	| { kind: 'log'; channel: string; line: string }
	| { kind: 'focus'; view: ViewId }
	| { kind: 'workspace'; folder: string | undefined };

/**
 * Everything the compatibility layer needs from the process that embeds it. The Electron
 * main process supplies the real implementations; tests supply in-memory ones, which is why
 * `host/` never imports `electron`.
 */
export interface HostEnvironment {
	/** Root holding `media/`, `skills/`, `relay-pwa/` and the bundled `.env` reader's directory. */
	appRoot: string;
	/** Per-user data directory (settings, state, logs, secrets). */
	userDataDir: string;
	/** The open project folder, if any. */
	workspaceFolder: string | undefined;
	/** Whether the user has marked the open folder as trusted. */
	workspaceTrusted: boolean;
	/** The URI scheme the OS routes back to this app (OAuth callbacks). */
	uriScheme: string;
	appVersion: string;
	/** Shows UI and resolves with the user's answer (`undefined` = dismissed). */
	request(req: UiRequest): Promise<unknown>;
	notify(event: UiEvent): void;
	/** Sends a message to a webview. */
	postToView(view: ViewId, message: unknown): void;
	/** Stores the HTML a webview should load. */
	setViewHtml(view: ViewId, html: string): void;
	openExternal(url: string): Promise<boolean>;
	readClipboard(): Promise<string>;
	writeClipboard(text: string): Promise<void>;
	/** Encrypts/decrypts secrets at rest. */
	encrypt(plain: string): Buffer;
	decrypt(data: Buffer): string;
}

let current: HostEnvironment | undefined;

/** Installs the environment. Must be called before the shim is first used. */
export function configureHost(env: HostEnvironment): void {
	current = env;
}

/** The installed environment. */
export function host(): HostEnvironment {
	if (!current) {
		throw new Error('The host environment has not been configured.');
	}
	return current;
}

/** Atomically-ish writes JSON: temp file then rename, so a crash never leaves half a file. */
export function writeJsonFile(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, '\t'), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Reads JSON, returning `fallback` for a missing or corrupt file. */
export function readJsonFile<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return fallback;
	}
}
