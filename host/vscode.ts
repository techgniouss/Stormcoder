/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Mjolnir contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * A Node implementation of the slice of the `vscode` API the chat code uses.
 *
 * The chat engine (providers, the agent loop, MCP, sessions, remote control) was written as an
 * editor extension. Rather than fork 12k lines that call this API, the desktop app answers the
 * same calls itself: settings live in a JSON file, secrets are encrypted at rest, dialogs and
 * pickers become toasts and palettes in the shell, and a "webview" is an iframe the shell
 * hosts. Editor-only features (inline completions, code actions, the active text editor) are
 * deliberately absent — there is no editor here — and the code that used them degrades to
 * "nothing is open" rather than failing.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { host, readJsonFile, ViewId, writeJsonFile } from './env';
import CONFIG_DEFAULTS from './config-defaults.json';

// ---------------------------------------------------------------------------------------------
// Events, disposables, cancellation
// ---------------------------------------------------------------------------------------------

export interface IDisposable { dispose(): unknown }
export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: IDisposable[]) => Disposable;

export class Disposable implements IDisposable {
	constructor(private callOnDispose?: () => unknown) { }
	static from(...items: IDisposable[]): Disposable {
		return new Disposable(() => items.forEach(i => i.dispose()));
	}
	dispose(): void {
		const fn = this.callOnDispose;
		this.callOnDispose = undefined;
		fn?.();
	}
}

export class EventEmitter<T> {
	private listeners = new Set<(e: T) => unknown>();
	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		const bound = thisArgs ? listener.bind(thisArgs) : listener;
		this.listeners.add(bound);
		const d = new Disposable(() => this.listeners.delete(bound));
		disposables?.push(d);
		return d;
	};
	fire(data: T): void {
		for (const l of [...this.listeners]) {
			try {
				l(data);
			} catch (err) {
				console.error('[host] event listener failed:', err);
			}
		}
	}
	dispose(): void { this.listeners.clear(); }
}

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: Event<void>;
}

export class CancellationTokenSource {
	private readonly emitter = new EventEmitter<void>();
	private readonly state = { cancelled: false };
	readonly token: CancellationToken;
	constructor() {
		const state = this.state;
		this.token = {
			get isCancellationRequested() { return state.cancelled; },
			onCancellationRequested: this.emitter.event,
		};
	}
	cancel(): void {
		if (!this.state.cancelled) {
			this.state.cancelled = true;
			this.emitter.fire();
		}
	}
	dispose(): void { this.emitter.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------------------------

export class Uri {
	private constructor(
		readonly scheme: string,
		readonly authority: string,
		readonly path: string,
		readonly query: string,
		readonly fragment: string,
	) { }

	static file(p: string): Uri {
		let normalized = p.replace(/\\/g, '/');
		if (!normalized.startsWith('/')) {
			normalized = '/' + normalized;
		}
		return new Uri('file', '', normalized, '', '');
	}

	static parse(value: string): Uri {
		const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
		if (!m) {
			return new Uri('file', '', value, '', '');
		}
		const decode = (s: string | undefined) => {
			try {
				return decodeURIComponent(s ?? '');
			} catch {
				return s ?? '';
			}
		};
		return new Uri(m[1].toLowerCase(), m[2] ?? '', decode(m[3]), decode(m[4]), decode(m[5]));
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const joined = path.posix.join(base.path || '/', ...segments.map(s => s.replace(/\\/g, '/')));
		return base.with({ path: joined });
	}

	static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
	}

	get fsPath(): string {
		let p = this.path;
		if (this.authority && this.scheme === 'file') {
			p = `//${this.authority}${p}`;
		}
		if (process.platform === 'win32') {
			if (/^\/[a-zA-Z]:/.test(p)) {
				p = p.slice(1);
			}
			return p.replace(/\//g, '\\');
		}
		return p;
	}

	with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}

	toString(skipEncoding = false): string {
		const enc = (s: string) => skipEncoding ? s : encodeURI(s).replace(/[?#]/g, c => encodeURIComponent(c));
		let out = `${this.scheme}:`;
		if (this.authority || this.scheme === 'file') {
			out += `//${this.authority}`;
		}
		out += enc(this.path);
		if (this.query) {
			out += `?${skipEncoding ? this.query : encodeURIComponent(this.query).replace(/%3D/g, '=').replace(/%26/g, '&')}`;
		}
		if (this.fragment) {
			out += `#${skipEncoding ? this.fragment : encodeURIComponent(this.fragment)}`;
		}
		return out;
	}

	toJSON(): unknown {
		return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
	}
}

// ---------------------------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------------------------

export class Position {
	constructor(readonly line: number, readonly character: number) { }
	isEqual(o: Position): boolean { return this.line === o.line && this.character === o.character; }
	isBefore(o: Position): boolean { return this.line < o.line || (this.line === o.line && this.character < o.character); }
}

export class Range {
	readonly start: Position;
	readonly end: Position;
	constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
		if (typeof startLine === 'number' && typeof startCharacter === 'number') {
			this.start = new Position(startLine, startCharacter);
			this.end = new Position(endLine ?? startLine, endCharacter ?? startCharacter);
		} else {
			this.start = startLine as Position;
			this.end = startCharacter as Position;
		}
	}
	get isEmpty(): boolean { return this.start.isEqual(this.end); }
}

export class Selection extends Range {
	get anchor(): Position { return this.start; }
	get active(): Position { return this.end; }
}

export class TabInputText { constructor(readonly uri: Uri) { } }

export enum EndOfLine { LF = 1, CRLF = 2 }

export interface TextLine { text: string; lineNumber: number; range: Range }

/** A file read into memory. Positions are computed on demand from the text. */
export class TextDocument {
	version = 1;
	readonly languageId: string;
	constructor(readonly uri: Uri, private text: string) {
		this.languageId = languageForPath(uri.fsPath);
	}
	get fileName(): string { return this.uri.fsPath; }
	get lineCount(): number { return this.text.split('\n').length; }
	get eol(): EndOfLine { return this.text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF; }
	getText(range?: Range): string {
		if (!range) {
			return this.text;
		}
		return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
	}
	lineAt(line: number): TextLine {
		const lines = this.text.split('\n');
		const t = (lines[line] ?? '').replace(/\r$/, '');
		return { text: t, lineNumber: line, range: new Range(line, 0, line, t.length) };
	}
	offsetAt(p: Position): number {
		const lines = this.text.split('\n');
		let off = 0;
		for (let i = 0; i < p.line && i < lines.length; i++) {
			off += lines[i].length + 1;
		}
		const lineLen = (lines[Math.min(p.line, lines.length - 1)] ?? '').length;
		return Math.min(off + Math.min(p.character, lineLen), this.text.length);
	}
	positionAt(offset: number): Position {
		const clamped = Math.max(0, Math.min(offset, this.text.length));
		const before = this.text.slice(0, clamped).split('\n');
		return new Position(before.length - 1, before[before.length - 1].length);
	}
	save(): Promise<boolean> { return Promise.resolve(true); }
}

const LANGUAGES: Record<string, string> = {
	ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
	json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
	rb: 'ruby', php: 'php', sh: 'shellscript', yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', scss: 'scss', sql: 'sql',
	kt: 'kotlin', swift: 'swift', toml: 'toml', xml: 'xml',
};

function languageForPath(file: string): string {
	return LANGUAGES[path.extname(file).slice(1).toLowerCase()] ?? 'plaintext';
}

export class WorkspaceEdit {
	readonly ops: Array<{ uri: Uri; range: Range; text: string }> = [];
	replace(uri: Uri, range: Range, text: string): void { this.ops.push({ uri, range, text }); }
	insert(uri: Uri, position: Position, text: string): void { this.ops.push({ uri, range: new Range(position, position), text }); }
}

// ---------------------------------------------------------------------------------------------
// Enums and small value types
// ---------------------------------------------------------------------------------------------

export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ProgressLocation { Notification = 15, Window = 10, SourceControl = 1 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }

export class RelativePattern {
	readonly baseUri: Uri;
	constructor(base: WorkspaceFolder | Uri | string, readonly pattern: string) {
		this.baseUri = typeof base === 'string' ? Uri.file(base) : 'uri' in base ? base.uri : base;
	}
}
export type GlobPattern = string | RelativePattern;

export interface WorkspaceFolder { readonly uri: Uri; readonly name: string; readonly index: number }

export class FileSystemError extends Error {
	constructor(message: string, readonly code = 'Unknown') { super(message); this.name = 'FileSystemError'; }
	static FileNotFound(m?: string): FileSystemError { return new FileSystemError(m ?? 'File not found', 'FileNotFound'); }
}

// ---------------------------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------------------------

export interface Memento {
	keys(): readonly string[];
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

/** A JSON-file-backed key/value store, written through on every update. */
class FileMemento implements Memento {
	private data: Record<string, unknown>;
	constructor(private readonly file: string) {
		this.data = readJsonFile<Record<string, unknown>>(file, {});
	}
	keys(): readonly string[] { return Object.keys(this.data); }
	get<T>(key: string, defaultValue?: T): T | undefined {
		return key in this.data ? this.data[key] as T : defaultValue;
	}
	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			delete this.data[key];
		} else {
			this.data[key] = value;
		}
		writeJsonFile(this.file, this.data);
	}
}

export interface SecretStorageChangeEvent { key: string }

/** Secrets encrypted with the embedder's `encrypt`/`decrypt` (the OS keychain in the app). */
export class SecretStorage {
	private readonly emitter = new EventEmitter<SecretStorageChangeEvent>();
	readonly onDidChange = this.emitter.event;
	private data: Record<string, string>;
	constructor(private readonly file: string) {
		this.data = readJsonFile<Record<string, string>>(file, {});
	}
	async get(key: string): Promise<string | undefined> {
		const raw = this.data[key];
		if (raw === undefined) {
			return undefined;
		}
		try {
			return host().decrypt(Buffer.from(raw, 'base64'));
		} catch {
			return undefined;
		}
	}
	async store(key: string, value: string): Promise<void> {
		this.data[key] = host().encrypt(value).toString('base64');
		writeJsonFile(this.file, this.data);
		this.emitter.fire({ key });
	}
	async delete(key: string): Promise<void> {
		delete this.data[key];
		writeJsonFile(this.file, this.data);
		this.emitter.fire({ key });
	}
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ConfigurationChangeEvent { affectsConfiguration(section: string): boolean }

export interface WorkspaceConfiguration {
	get<T>(section: string): T | undefined;
	get<T>(section: string, defaultValue: T): T;
	has(section: string): boolean;
	inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T } | undefined;
	update(section: string, value: unknown, target?: ConfigurationTarget | boolean): Thenable<void>;
}

const configEmitter = new EventEmitter<ConfigurationChangeEvent>();
let settingsFile = '';
let settings: Record<string, unknown> = {};

function loadSettings(): void {
	settingsFile = path.join(host().userDataDir, 'settings.json');
	settings = readJsonFile<Record<string, unknown>>(settingsFile, {});
}

/** Reads the user's settings file again (called when it was edited in the built-in editor). */
export function reloadSettings(): void {
	const before = settings;
	loadSettings();
	const keys = new Set([...Object.keys(before), ...Object.keys(settings)]);
	const changed = [...keys].filter(k => JSON.stringify(before[k]) !== JSON.stringify(settings[k]));
	if (changed.length) {
		configEmitter.fire({ affectsConfiguration: s => changed.some(k => k === s || k.startsWith(s + '.') || s.startsWith(k + '.')) });
	}
}

/** Every setting key the app declares, with its default. */
export function settingDefaults(): Readonly<Record<string, unknown>> {
	return (CONFIG_DEFAULTS as { defaults: Record<string, unknown> }).defaults;
}

function lookup(fullKey: string): unknown {
	if (fullKey in settings) {
		return settings[fullKey];
	}
	const defaults = settingDefaults();
	return fullKey in defaults ? defaults[fullKey] : undefined;
}

function makeConfiguration(section: string): WorkspaceConfiguration {
	const full = (key: string) => section ? `${section}.${key}` : key;
	return {
		get<T>(key: string, defaultValue?: T): T | undefined {
			const v = lookup(full(key));
			return (v === undefined || v === null ? defaultValue : v) as T | undefined;
		},
		has: key => full(key) in settings || full(key) in settingDefaults(),
		inspect: <T>(key: string) => ({ key: full(key), defaultValue: settingDefaults()[full(key)] as T | undefined, globalValue: settings[full(key)] as T | undefined }),
		async update(key: string, value: unknown): Promise<void> {
			const k = full(key);
			if (value === undefined) {
				delete settings[k];
			} else {
				settings[k] = value;
			}
			writeJsonFile(settingsFile, settings);
			configEmitter.fire({ affectsConfiguration: s => k === s || k.startsWith(s + '.') });
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

function toPath(uri: Uri): string { return uri.fsPath; }

function mapFsError(err: unknown): never {
	const e = err as NodeJS.ErrnoException;
	if (e?.code === 'ENOENT') {
		throw FileSystemError.FileNotFound(e.message);
	}
	throw err;
}

const fileSystem = {
	async stat(uri: Uri): Promise<{ type: FileType; size: number; mtime: number; ctime: number }> {
		try {
			const s = await fs.promises.lstat(toPath(uri));
			const real = s.isSymbolicLink() ? await fs.promises.stat(toPath(uri)).catch(() => s) : s;
			const type = (real.isDirectory() ? FileType.Directory : real.isFile() ? FileType.File : FileType.Unknown)
				| (s.isSymbolicLink() ? FileType.SymbolicLink : 0);
			return { type, size: real.size, mtime: real.mtimeMs, ctime: real.ctimeMs };
		} catch (err) { return mapFsError(err); }
	},
	async readDirectory(uri: Uri): Promise<[string, FileType][]> {
		try {
			const entries = await fs.promises.readdir(toPath(uri), { withFileTypes: true });
			return entries.map(e => [e.name, e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : FileType.Unknown] as [string, FileType]);
		} catch (err) { return mapFsError(err); }
	},
	async readFile(uri: Uri): Promise<Uint8Array> {
		try { return new Uint8Array(await fs.promises.readFile(toPath(uri))); } catch (err) { return mapFsError(err); }
	},
	async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
		await fs.promises.mkdir(path.dirname(toPath(uri)), { recursive: true });
		await fs.promises.writeFile(toPath(uri), content);
	},
	async createDirectory(uri: Uri): Promise<void> { await fs.promises.mkdir(toPath(uri), { recursive: true }); },
	async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
		try { await fs.promises.rm(toPath(uri), { recursive: options?.recursive ?? false, force: false }); } catch (err) { mapFsError(err); }
	},
	async rename(from: Uri, to: Uri, options?: { overwrite?: boolean }): Promise<void> {
		if (!options?.overwrite && fs.existsSync(toPath(to))) {
			throw new FileSystemError('Target exists', 'FileExists');
		}
		await fs.promises.rename(toPath(from), toPath(to));
	},
	async copy(from: Uri, to: Uri, options?: { overwrite?: boolean }): Promise<void> {
		await fs.promises.cp(toPath(from), toPath(to), { recursive: true, force: options?.overwrite ?? false });
	},
};

/** Converts a VS Code-style glob (`**`, `*`, `?`, `{a,b}`) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '{') {
			re += '(?:';
		} else if (c === '}') {
			re += ')';
		} else if (c === ',') {
			// A comma is an alternation only inside braces; the glob grammar here never has a bare one.
			re += '|';
		} else if (/[.+^$()|[\]\\]/.test(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

async function findFiles(include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number): Promise<Uri[]> {
	const folders = workspaceFolderList();
	const roots = include instanceof RelativePattern ? [{ dir: include.baseUri.fsPath }] : folders.map(f => ({ dir: f.uri.fsPath }));
	const includeRe = globToRegExp(typeof include === 'string' ? include : include.pattern);
	const excludeRe = exclude ? globToRegExp(typeof exclude === 'string' ? exclude : exclude.pattern) : undefined;
	const limit = maxResults ?? 10_000;
	const results: Uri[] = [];
	const pruneDirs = /(^|\/)(node_modules|\.git)$/;
	for (const root of roots) {
		const stack = [''];
		while (stack.length && results.length < limit) {
			const rel = stack.pop() as string;
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(path.join(root.dir, rel), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				const childRel = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) {
					if (!pruneDirs.test(childRel) && !(excludeRe && excludeRe.test(`${childRel}/x`))) {
						stack.push(childRel);
					}
				} else if (e.isFile() && includeRe.test(childRel) && !(excludeRe && excludeRe.test(childRel))) {
					results.push(Uri.file(path.join(root.dir, childRel)));
					if (results.length >= limit) {
						break;
					}
				}
			}
		}
	}
	return results;
}

// ---------------------------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------------------------

function workspaceFolderList(): WorkspaceFolder[] {
	const dir = host().workspaceFolder;
	return dir ? [{ uri: Uri.file(dir), name: path.basename(dir), index: 0 }] : [];
}

const noopEvent: Event<never> = () => new Disposable();

export const workspace = {
	get workspaceFolders(): WorkspaceFolder[] | undefined {
		const list = workspaceFolderList();
		return list.length ? list : undefined;
	},
	get name(): string | undefined { return workspaceFolderList()[0]?.name; },
	get isTrusted(): boolean { return host().workspaceTrusted; },
	get workspaceFile(): Uri | undefined { return undefined; },
	get textDocuments(): TextDocument[] { return []; },
	fs: fileSystem,
	getConfiguration: (section?: string): WorkspaceConfiguration => makeConfiguration(section ?? ''),
	onDidChangeConfiguration: configEmitter.event as Event<ConfigurationChangeEvent>,
	onDidSaveTextDocument: noopEvent as Event<TextDocument>,
	onDidChangeWorkspaceFolders: noopEvent as Event<unknown>,
	getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
		return workspaceFolderList().find(f => {
			const rel = path.relative(f.uri.fsPath, uri.fsPath);
			return !rel.startsWith('..') && !path.isAbsolute(rel);
		});
	},
	asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
		const fsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
		const folder = workspaceFolderList().find(f => {
			const rel = path.relative(f.uri.fsPath, fsPath);
			return !rel.startsWith('..') && !path.isAbsolute(rel);
		});
		if (!folder) {
			return fsPath;
		}
		const rel = path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
		return includeWorkspaceFolder ? `${folder.name}/${rel}` : rel;
	},
	findFiles,
	async openTextDocument(arg: Uri | string): Promise<TextDocument> {
		const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
		let text = '';
		try {
			text = await fs.promises.readFile(uri.fsPath, 'utf8');
		} catch (err) {
			mapFsError(err);
		}
		return new TextDocument(uri, text);
	},
	async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
		try {
			const byFile = new Map<string, WorkspaceEdit['ops']>();
			for (const op of edit.ops) {
				byFile.set(op.uri.fsPath, [...(byFile.get(op.uri.fsPath) ?? []), op]);
			}
			for (const [file, ops] of byFile) {
				const doc = new TextDocument(Uri.file(file), await fs.promises.readFile(file, 'utf8').catch(() => ''));
				let text = doc.getText();
				// Later ranges first, so earlier offsets stay valid.
				const ordered = ops
					.map(o => ({ start: doc.offsetAt(o.range.start), end: doc.offsetAt(o.range.end), text: o.text }))
					.sort((a, b) => b.start - a.start);
				for (const o of ordered) {
					text = text.slice(0, o.start) + o.text + text.slice(o.end);
				}
				await fs.promises.writeFile(file, text, 'utf8');
			}
			return true;
		} catch {
			return false;
		}
	},
	// `findTextInFiles` is intentionally absent: tools.ts feature-detects it and falls back
	// to its own sweep, which is what runs here.
} as {
	workspaceFolders: WorkspaceFolder[] | undefined;
	name: string | undefined;
	isTrusted: boolean;
	workspaceFile: Uri | undefined;
	textDocuments: TextDocument[];
	fs: typeof fileSystem;
	getConfiguration(section?: string): WorkspaceConfiguration;
	onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
	onDidSaveTextDocument: Event<TextDocument>;
	onDidChangeWorkspaceFolders: Event<unknown>;
	getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
	asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
	findFiles(include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number): Thenable<Uri[]>;
	openTextDocument(arg: Uri | string): Thenable<TextDocument>;
	applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
	findTextInFiles?: (query: unknown, options: unknown, callback: (m: TextSearchMatch) => void) => Thenable<unknown>;
};

export interface TextSearchMatch {
	uri: Uri;
	ranges: Range | Range[];
	preview: { text: string; matches: Range | Range[] };
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

const commandTable = new Map<string, (...args: never[]) => unknown>();

export const commands = {
	registerCommand(id: string, callback: (...args: never[]) => unknown): Disposable {
		commandTable.set(id, callback);
		return new Disposable(() => commandTable.delete(id));
	},
	async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
		if (id === 'openvsChat.view.focus') {
			host().notify({ kind: 'focus', view: 'chat' });
			return undefined;
		}
		const fn = commandTable.get(id);
		if (!fn) {
			// Editor commands (inline suggestions, setContext, …) have nothing to run here.
			return undefined;
		}
		return await (fn as (...a: unknown[]) => unknown)(...args) as T;
	},
	getCommands: async (): Promise<string[]> => [...commandTable.keys()],
};

/** Runs a registered command by id; used by the shell's menu and palette. */
export function runCommand(id: string, ...args: unknown[]): Promise<unknown> {
	return commands.executeCommand(id, ...args);
}

/** The ids of all registered commands. */
export function registeredCommands(): string[] {
	return [...commandTable.keys()];
}

// ---------------------------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------------------------

export interface MessageOptions { modal?: boolean; detail?: string }
export interface QuickPickItem { label: string; description?: string; detail?: string; picked?: boolean }
export interface InputBoxOptions { title?: string; prompt?: string; placeHolder?: string; value?: string; password?: boolean; ignoreFocusOut?: boolean; validateInput?(v: string): string | undefined | null | Thenable<string | undefined | null> }
export interface QuickPickOptions { title?: string; placeHolder?: string; canPickMany?: boolean; ignoreFocusOut?: boolean; matchOnDescription?: boolean; matchOnDetail?: boolean }
export interface OpenDialogOptions { title?: string; canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; defaultUri?: Uri; openLabel?: string; filters?: Record<string, string[]> }

function show(level: 'info' | 'warn' | 'error') {
	return async (text: string, ...rest: Array<MessageOptions | string | { title: string }>): Promise<string | undefined> => {
		const options = rest.find((r): r is MessageOptions => typeof r === 'object' && !('title' in r)) as MessageOptions | undefined;
		const actions = rest.filter((r): r is string => typeof r === 'string');
		const answer = await host().request({ kind: 'message', level, text, detail: options?.detail, modal: options?.modal === true, actions });
		return typeof answer === 'string' ? answer : undefined;
	};
}

type QuickPickFn = {
	<T extends QuickPickItem | string>(items: readonly T[] | Thenable<readonly T[]>, options: QuickPickOptions & { canPickMany: true }): Promise<T[] | undefined>;
	<T extends QuickPickItem | string>(items: readonly T[] | Thenable<readonly T[]>, options?: QuickPickOptions): Promise<T | undefined>;
};

async function showQuickPick<T extends QuickPickItem | string>(items: readonly T[] | Thenable<readonly T[]>, options?: QuickPickOptions): Promise<T | T[] | undefined> {
	const list = await items;
	const entries = list.map(i => typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail, picked: i.picked });
	const answer = await host().request({ kind: 'pick', title: options?.title, placeholder: options?.placeHolder, many: options?.canPickMany === true, items: entries });
	if (answer === undefined || answer === null) {
		return undefined;
	}
	if (options?.canPickMany) {
		return (answer as number[]).map(i => list[i]);
	}
	return list[answer as number];
}

let progressIds = 0;

export interface OutputChannel {
	readonly name: string;
	append(value: string): void;
	appendLine(value: string): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
	clear(): void;
	dispose(): void;
}

export interface StatusBarItem {
	text: string;
	tooltip: string | undefined;
	command: string | undefined;
	show(): void;
	hide(): void;
	dispose(): void;
}

export interface UriHandler { handleUri(uri: Uri): unknown }
const uriHandlers: UriHandler[] = [];

/** Delivers an OS-routed `mjolnir://` link to the registered handler (OAuth callbacks). */
export function deliverUri(uri: string): void {
	for (const h of uriHandlers) {
		h.handleUri(Uri.parse(uri));
	}
}

/** The stub the chat code gets for the editor surface it expects; there is no editor here. */
export interface TextEditor {
	document: TextDocument;
	selection: Selection;
	edit(cb: (b: { insert(p: Position, t: string): void }) => void): Thenable<boolean>;
}

export const window = {
	showInformationMessage: show('info'),
	showWarningMessage: show('warn'),
	showErrorMessage: show('error'),
	async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
		for (;;) {
			const v = await host().request({ kind: 'input', title: options?.title, prompt: options?.prompt, placeholder: options?.placeHolder, value: options?.value, password: options?.password });
			if (typeof v !== 'string') {
				return undefined;
			}
			const problem = options?.validateInput ? await options.validateInput(v) : undefined;
			if (!problem) {
				return v;
			}
			host().request({ kind: 'message', level: 'warn', text: problem, modal: false, actions: [] }).catch(() => undefined);
		}
	},
	showQuickPick: showQuickPick as QuickPickFn,
	async showOpenDialog(options?: OpenDialogOptions): Promise<Uri[] | undefined> {
		const answer = await host().request({
			kind: 'openDialog', title: options?.title, folders: options?.canSelectFolders === true,
			files: options?.canSelectFiles !== false, many: options?.canSelectMany === true, defaultPath: options?.defaultUri?.fsPath,
		});
		return Array.isArray(answer) && answer.length ? (answer as string[]).map(p => Uri.file(p)) : undefined;
	},
	async showTextDocument(arg: TextDocument | Uri): Promise<undefined> {
		const uri = arg instanceof Uri ? arg : arg.uri;
		await host().request({ kind: 'edit', path: uri.fsPath });
		return undefined;
	},
	async withProgress<R>(options: { location: ProgressLocation; title?: string; cancellable?: boolean }, task: (progress: { report(v: { message?: string; increment?: number }): void }, token: CancellationToken) => Thenable<R>): Promise<R> {
		const id = ++progressIds;
		const cts = new CancellationTokenSource();
		host().notify({ kind: 'progress', id, title: options.title, done: false });
		try {
			return await task({ report: v => host().notify({ kind: 'progress', id, title: options.title, message: v.message, done: false }) }, cts.token);
		} finally {
			host().notify({ kind: 'progress', id, title: options.title, done: true });
			cts.dispose();
		}
	},
	createOutputChannel(name: string): OutputChannel {
		const file = path.join(host().userDataDir, 'logs', `${name.replace(/[^\w.-]+/g, '_')}.log`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const write = (line: string) => {
			fs.appendFile(file, line, () => undefined);
			host().notify({ kind: 'log', channel: name, line });
		};
		return {
			name,
			append: v => write(v),
			appendLine: v => write(v + '\n'),
			show: () => { void host().request({ kind: 'edit', path: file }); },
			hide: () => undefined,
			clear: () => { fs.writeFile(file, '', () => undefined); },
			dispose: () => undefined,
		};
	},
	createStatusBarItem(_alignment?: StatusBarAlignment, _priority?: number): StatusBarItem {
		const id = `status-${++progressIds}`;
		const item = { text: '', tooltip: undefined as string | undefined, command: undefined as string | undefined };
		const push = (visible: boolean) => host().notify({ kind: 'status', id, text: item.text, tooltip: item.tooltip, visible });
		return Object.assign(item, { show: () => push(true), hide: () => push(false), dispose: () => push(false) });
	},
	registerUriHandler(handler: UriHandler): Disposable {
		uriHandlers.push(handler);
		return new Disposable(() => { const i = uriHandlers.indexOf(handler); if (i >= 0) { uriHandlers.splice(i, 1); } });
	},
	registerWebviewViewProvider(_viewType: string, provider: WebviewViewProvider, _options?: unknown): Disposable {
		const view = createView('chat');
		provider.resolveWebviewView(view as unknown as WebviewView, {}, new CancellationTokenSource().token);
		return new Disposable(() => view.fireDispose());
	},
	createWebviewPanel(_type: string, _title: string, _column: ViewColumn, _options?: unknown): WebviewPanel {
		const panel = createView('settings');
		host().notify({ kind: 'focus', view: 'settings' });
		return panel as unknown as WebviewPanel;
	},
	activeTextEditor: undefined as TextEditor | undefined,
	visibleTextEditors: [] as TextEditor[],
	tabGroups: { all: [] as Array<{ tabs: Array<{ input: unknown; isActive: boolean }> }> },
};

// ---------------------------------------------------------------------------------------------
// Webviews
// ---------------------------------------------------------------------------------------------

export interface Webview {
	options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
	html: string;
	readonly cspSource: string;
	postMessage(message: unknown): Thenable<boolean>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onDidReceiveMessage: Event<any>;
	asWebviewUri(uri: Uri): Uri;
}
export interface WebviewView {
	readonly webview: Webview;
	readonly visible: boolean;
	onDidDispose: Event<void>;
	onDidChangeVisibility: Event<void>;
	show(preserveFocus?: boolean): void;
}
export interface WebviewPanel extends WebviewView {
	reveal(column?: ViewColumn, preserveFocus?: boolean): void;
	dispose(): void;
}
export interface WebviewViewProvider {
	resolveWebviewView(view: WebviewView, context: unknown, token: CancellationToken): Thenable<void> | void;
}

/** The origin the shell serves bundled assets from; webview HTML references files below it. */
export const ASSET_ORIGIN = 'mjolnir-asset://app';

const liveViews = new Map<ViewId, ReturnType<typeof createView>>();

function createView(id: ViewId) {
	const messages = new EventEmitter<unknown>();
	const disposed = new EventEmitter<void>();
	const visible = new EventEmitter<void>();
	const webview: Webview = {
		options: {},
		cspSource: ASSET_ORIGIN,
		onDidReceiveMessage: messages.event,
		asWebviewUri: uri => {
			// Files under the app root become asset URLs; anything else is passed through.
			const rel = path.relative(host().appRoot, uri.fsPath).replace(/\\/g, '/');
			return rel.startsWith('..') ? uri : Uri.parse(`${ASSET_ORIGIN}/${rel}`);
		},
		postMessage: async message => { host().postToView(id, message); return true; },
		get html() { return html; },
		set html(value: string) { html = value; host().setViewHtml(id, value); },
	};
	let html = '';
	const view = {
		webview,
		visible: true,
		onDidDispose: disposed.event,
		onDidChangeVisibility: visible.event,
		show: () => host().notify({ kind: 'focus', view: id }),
		reveal: () => host().notify({ kind: 'focus', view: id }),
		dispose: () => view.fireDispose(),
		fireDispose: () => { liveViews.delete(id); disposed.fire(); },
		receive: (message: unknown) => messages.fire(message),
	};
	liveViews.set(id, view);
	return view;
}

/** Routes a message from a shell iframe to the webview object the chat code holds. */
export function deliverToView(id: ViewId, message: unknown): void {
	liveViews.get(id)?.receive(message);
}

// ---------------------------------------------------------------------------------------------
// env, extensions, languages
// ---------------------------------------------------------------------------------------------

export const env = {
	get uriScheme(): string { return host().uriScheme; },
	appName: 'Mjolnir',
	language: 'en',
	get machineId(): string { return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex'); },
	openExternal: (uri: Uri | string): Thenable<boolean> => host().openExternal(typeof uri === 'string' ? uri : uri.toString(true)),
	asExternalUri: async (uri: Uri): Promise<Uri> => uri,
	clipboard: {
		readText: (): Thenable<string> => host().readClipboard(),
		writeText: (text: string): Thenable<void> => host().writeClipboard(text),
	},
};

export const extensions = {
	getExtension<T = unknown>(_id: string): { isActive: boolean; activate(): Thenable<T>; exports: T } | undefined { return undefined; },
};

// ---------------------------------------------------------------------------------------------
// Extension context
// ---------------------------------------------------------------------------------------------

export interface ExtensionContext {
	readonly subscriptions: IDisposable[];
	readonly extensionPath: string;
	readonly extensionUri: Uri;
	readonly globalState: Memento;
	readonly workspaceState: Memento;
	readonly secrets: SecretStorage;
	readonly globalStorageUri: Uri;
	readonly storageUri: Uri | undefined;
}

/** Builds the context the chat code receives at activation. */
export function createContext(): ExtensionContext {
	const env = host();
	loadSettings();
	const wsKey = env.workspaceFolder
		? crypto.createHash('sha1').update(path.resolve(env.workspaceFolder).toLowerCase()).digest('hex').slice(0, 16)
		: 'no-folder';
	const stateDir = path.join(env.userDataDir, 'state');
	return {
		subscriptions: [],
		extensionPath: env.appRoot,
		extensionUri: Uri.file(env.appRoot),
		globalState: new FileMemento(path.join(stateDir, 'global.json')),
		workspaceState: new FileMemento(path.join(stateDir, `workspace-${wsKey}.json`)),
		secrets: new SecretStorage(path.join(env.userDataDir, 'secrets.json')),
		globalStorageUri: Uri.file(path.join(env.userDataDir, 'storage')),
		storageUri: env.workspaceFolder ? Uri.file(path.join(env.userDataDir, 'storage', wsKey)) : undefined,
	};
}

/** Clears every registration so the extension can be activated afresh (folder switch). */
export function resetHost(): void {
	commandTable.clear();
	uriHandlers.length = 0;
	for (const v of [...liveViews.values()]) {
		v.fireDispose();
	}
}

// Editor-only surfaces are exported as inert values so a stray reference compiles and no-ops.
export const languages = {
	registerInlineCompletionItemProvider: (): Disposable => new Disposable(),
	registerCodeActionsProvider: (): Disposable => new Disposable(),
};
