/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Variables an agent process started by Stormcoder (the Claude Code engine, the Codex reviewer) may
 * inherit: what a shell, a git command and a proxy need to work. Everything else, above all provider
 * API keys and cloud credentials, is dropped, so neither the process nor the commands it runs can
 * read a secret the user gave Stormcoder.
 */
const ENV_ALLOW = /^(PATH|HOME|USER|USERNAME|LOGNAME|SHELL|TERM|LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|TEMPDIR|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|XDG_[A-Z_]+|SSH_AUTH_SOCK|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|GIT_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY)$/i;

/**
 * The allow-listed subset of `parent`, plus any `extra` names the caller explicitly vouches for
 * (for example a tool's own config-folder variable).
 */
export function allowlistedEnv(parent: NodeJS.ProcessEnv, extra: readonly string[] = []): Record<string, string> {
	const wanted = new Set(extra.map(name => name.toUpperCase()));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined && (ENV_ALLOW.test(key) || wanted.has(key.toUpperCase()))) {
			env[key] = value;
		}
	}
	return env;
}
