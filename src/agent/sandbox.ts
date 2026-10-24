/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, join } from 'path';

/**
 * What `openvsChat.agent.sandbox` asks for.
 *  - `off`: commands run as the user, with only the deny-list in front of them.
 *  - `workspace`: the whole filesystem is read-only except the workspace folders, the
 *    temp folder and the usual tool caches (`~/.npm`, `~/.cache`, `~/.cargo`, …).
 *  - `workspace-offline`: as `workspace`, and the command has no network.
 */
export type SandboxMode = 'off' | 'workspace' | 'workspace-offline';

/** Parses the setting; anything unrecognized is `off`, the behavior before the setting existed. */
export function parseSandboxMode(raw: unknown): SandboxMode {
	return raw === 'workspace' || raw === 'workspace-offline' ? raw : 'off';
}

/** Caches a build tool writes under the home folder, writable inside the sandbox when they exist. */
const HOME_CACHES = ['.npm', '.cache', '.cargo', '.rustup', '.gradle', '.m2', '.yarn', '.pnpm-store', '.nuget', '.local/share/pnpm', '.bun', '.deno'];

/** Everything {@link sandboxedSpawn} needs to build the launch line. */
export interface SandboxRequest {
	readonly mode: Exclude<SandboxMode, 'off'>;
	readonly command: string;
	/** Working directory for the command. */
	readonly cwd: string;
	/** Workspace folders: the places a command may write. */
	readonly writable: readonly string[];
	/** Extra writable folders from `openvsChat.agent.sandboxWritablePaths`. */
	readonly extraWritable: readonly string[];
	/** Names inside a workspace folder that stay read-only (`.env`, key files). Globs are skipped. */
	readonly protectedNames: readonly string[];
	/** The shell that runs the command; `/bin/sh` when absent. */
	readonly shell?: string;
	readonly platform?: NodeJS.Platform;
	readonly home?: string;
	readonly tmp?: string;
	/** Injected for tests: whether a path exists. */
	readonly exists?: (path: string) => boolean;
	/** Injected for tests: finds an executable on PATH. */
	readonly which?: (name: string) => string | undefined;
}

/** How to launch the command, or why it cannot be sandboxed here. */
export type SandboxLaunch =
	| { readonly ok: true; readonly file: string; readonly args: string[] }
	| { readonly ok: false; readonly error: string };

function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		const candidate = join(dir, name);
		if (dir && existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * The program and arguments that run `command` inside the OS sandbox.
 *
 * Linux uses bubblewrap, macOS `sandbox-exec`. Anywhere else, or when the tool is missing, the
 * result is an error rather than an unsandboxed fallback: someone who switched the setting on
 * has asked for the protection, and silently running without it would be worse than failing.
 */
export function sandboxedSpawn(req: SandboxRequest): SandboxLaunch {
	const platform = req.platform ?? process.platform;
	const exists = req.exists ?? existsSync;
	const which = req.which ?? findOnPath;
	const home = req.home ?? homedir();
	const tmp = req.tmp ?? tmpdir();
	const shell = req.shell || '/bin/sh';
	const offline = req.mode === 'workspace-offline';
	const caches = HOME_CACHES.map(c => join(home, c));
	const writable = [...req.writable, ...req.extraWritable, ...caches].filter(p => exists(p));

	if (platform === 'linux') {
		const bwrap = which('bwrap');
		if (!bwrap) {
			return { ok: false, error: 'openvsChat.agent.sandbox is on, but bubblewrap (bwrap) is not installed. Install it (for example "apt install bubblewrap"), or set the sandbox to "off".' };
		}
		const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--unshare-pid'];
		if (offline) {
			args.push('--unshare-net');
		}
		for (const path of writable) {
			args.push('--bind', path, path);
		}
		// Secrets inside a writable workspace stay read-only: a later mount shadows the bind above.
		for (const root of req.writable) {
			for (const name of req.protectedNames) {
				const path = join(root, name);
				if (!name.includes('*') && name !== '.git' && exists(path)) {
					args.push('--ro-bind', path, path);
				}
			}
		}
		args.push('--chdir', req.cwd, '--', shell, '-c', req.command);
		return { ok: true, file: bwrap, args };
	}

	if (platform === 'darwin') {
		const exec = which('sandbox-exec');
		if (!exec) {
			return { ok: false, error: 'openvsChat.agent.sandbox is on, but sandbox-exec was not found. Set the sandbox to "off".' };
		}
		const quote = (p: string) => JSON.stringify(p);
		const roots = [...writable, tmp, '/private/tmp', '/private/var/folders'];
		const profile = [
			'(version 1)',
			'(allow default)',
			'(deny file-write*)',
			`(allow file-write* ${['/dev', ...roots].map(p => `(subpath ${quote(p)})`).join(' ')})`,
			...req.writable.flatMap(root => req.protectedNames
				.filter(n => !n.includes('*') && n !== '.git')
				.map(n => `(deny file-write* (literal ${quote(join(root, n))}))`)),
			...(offline ? ['(deny network*)', '(allow network* (local ip "localhost:*"))'] : []),
		].join('\n');
		return { ok: true, file: exec, args: ['-p', profile, shell, '-c', req.command] };
	}

	return { ok: false, error: `openvsChat.agent.sandbox is not supported on ${platform}. Set it to "off".` };
}
