/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { decodeJwtClaims } from './oauth';

/**
 * Names for accounts added through a browser sign-in, so the account list reads "@octocat" or
 * "me@example.com" instead of "API key 2". Every lookup is best effort and bounded: a failure just
 * means the generic fallback name is used, never that the sign-in fails.
 */

/** The GitHub login behind a Copilot device-flow token, as "@login". */
export async function githubAccountLabel(token: string, fallback = 'GitHub account'): Promise<string> {
	try {
		const res = await fetch('https://api.github.com/user', {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Stormcoder' },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) { return fallback; }
		const json: any = await res.json();
		return typeof json?.login === 'string' && json.login ? `@${json.login}` : fallback;
	} catch {
		return fallback;
	}
}

/** The e-mail claim of a token when it is a JWT that carries one, else `fallback`. */
export function tokenEmailLabel(token: string | undefined, fallback: string): string {
	const email = token ? decodeJwtClaims(token)?.email : undefined;
	return typeof email === 'string' && email ? email : fallback;
}
