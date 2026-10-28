/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Native OAuth sign-in for providers that offer a consumer subscription login
 * (Anthropic "Claude" accounts and OpenAI "ChatGPT" accounts), so users without an
 * API key can authenticate with the account they already pay for. Tokens are stored
 * in VS Code SecretStorage and refreshed transparently before they expire.
 *
 * Note: subscription tokens are intended by the providers for their own first-party
 * tools; both flows below mirror the public PKCE flows used by those tools.
 */

/**
 * Minimal `.env` loader — no external dependency, matching this extension's
 * zero-npm-dependency footprint. Reads `<extensionPath>/.env` (gitignored via the
 * repo's root `.env` / `.env.*` rules; see `.env.example` for the documented,
 * checked-in placeholder) and sets any `KEY=VALUE` pair not already present in
 * `process.env`, so a real OS-level env var still wins. Silent no-op if the file
 * doesn't exist — most users never need one. Call once, early in `activate()`.
 */
export function loadEnvFile(extensionPath: string): void {
	let contents: string;
	try {
		contents = fs.readFileSync(path.join(extensionPath, '.env'), 'utf8');
	} catch {
		return;
	}
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const eq = line.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		if (key && !(key in process.env)) {
			process.env[key] = value;
		}
	}
}

const SECRET_PREFIX = 'stormcoder.oauth.';
/** Refresh when the access token has less than this long left to live. */
const EXPIRY_SLACK_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference';

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const OPENAI_CALLBACK_PORT = 1455;
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_CALLBACK_PORT}/auth/callback`;
const OPENAI_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** A persisted OAuth session for one provider. */
export interface StoredOAuth {
	readonly type: 'anthropic' | 'openai' | 'antigravity';
	readonly access: string;
	readonly refresh: string;
	/** Absolute expiry time of `access`, in ms since the epoch. */
	readonly expires: number;
	/**
	 * `type: 'openai'` only — the ChatGPT-Account-ID derived from this session's
	 * id_token (see `chatgptAccountId` below). Persisted so it survives an
	 * extension-host restart; the in-process cache alone does not.
	 */
	readonly accountId?: string;
	/** Display name supplied by the provider, never a token. */
	readonly label?: string;
}

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';

/**
 * Google's Antigravity IDE OAuth client (shared with its CLI). Public — ships inside
 * Antigravity's own binary; the redirect-URI restriction is the actual security
 * control, not client_id/client_secret confidentiality. **Antigravity's ToS explicitly
 * bans using this credential through third-party tools**, and Google has already
 * banned paying subscribers for exactly this pattern (naming Claude Code and other
 * third-party agents by name in its own FAQ). Wired up only because it was explicitly
 * requested with a working reference implementation in hand — `GeminiProvider` in
 * `providers/gemini.ts` is the sanctioned alternative (a real AI-Studio API key).
 */
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_CALLBACK_PORT = 51121;
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;
const ANTIGRAVITY_SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

/**
 * Google's token endpoint requires a client_secret on this client's exchanges even
 * though it's a public "Desktop app" client. Kept out of source (unlike
 * `ANTHROPIC_CLIENT_ID`, which has no secret) because the literal value matches
 * secret-scanner patterns (`GOCSPX-...`) — set it via this environment variable
 * instead of hardcoding it here.
 */
function antigravityClientSecret(): string {
	const secret = process.env['ANTIGRAVITY_CLIENT_SECRET'];
	if (!secret) {
		throw new Error('Google Antigravity sign-in needs ANTIGRAVITY_CLIENT_SECRET. Set it as an environment variable, or put '
			+ 'ANTIGRAVITY_CLIENT_SECRET=<value> in a file named .env inside Stormcoder\'s user data folder '
			+ '(Menu > Open logs folder, one level up), then restart Stormcoder.');
	}
	return secret;
}

/** Which providers have a built-in web sign-in (no `authUrl` setting needed). */
export function supportsNativeSignIn(providerId: string): boolean {
	return providerId === 'anthropic' || providerId === 'openai' || providerId === 'openrouter' || providerId === 'antigravity';
}

interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

function base64url(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce(): Pkce {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

/** Decodes the (unverified) claims of a JWT, or undefined when it isn't one. */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
}

/**
 * The Codex backend needs a `ChatGPT-Account-ID` header on every request, decoded
 * from the `https://api.openai.com/auth` claim. `providers/codex.py` (the reference
 * this mirrors) decodes that claim from the sign-in's `id_token`, not the
 * `access_token` — so it's derived here (where `id_token` is available, right after
 * the code exchange / each refresh) and looked up by `chatgptBackend.ts` keyed on the
 * access token that goes out on the wire, since that module only ever sees that
 * single string (see `ChatProvider`'s "self-contained, fetch only" contract in
 * `providers/types.ts`).
 *
 * Cached in-process AND persisted on `StoredOAuth.accountId` (see below): the
 * in-process map alone doesn't survive an extension-host restart, and a still-valid
 * access token (the common case — restarting the editor doesn't expire a token with
 * time left) would otherwise skip both sign-in and refresh, the only two places that
 * used to derive it, and fail every request with "missing the account id" on an
 * otherwise perfectly good session.
 */
const chatgptAccountIds = new Map<string, string>();

/** Decodes `chatgpt_account_id` from a ChatGPT sign-in's id_token, if present. */
function deriveChatGptAccountId(idToken: unknown): string | undefined {
	if (typeof idToken !== 'string') {
		return undefined;
	}
	const auth = decodeJwtClaims(idToken)?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
	const id = auth?.['chatgpt_account_id'];
	return typeof id === 'string' && id ? id : undefined;
}

function cacheChatGptAccountId(accessToken: string, id: string | undefined): void {
	if (id) {
		chatgptAccountIds.set(accessToken, id);
	}
}

/** Looks up an account id cached by {@link cacheChatGptAccountId}, if any. */
export function chatgptAccountId(accessToken: string): string | undefined {
	return chatgptAccountIds.get(accessToken);
}

/**
 * Persists and refreshes OAuth sessions. Owns no UI: the interactive sign-in flows
 * live in the exported `signIn*` functions below and write into this store.
 */
export class OAuthTokenStore {
	private readonly refreshing = new Map<string, Promise<string | undefined>>();
	private readonly mutations = new Map<string, Promise<unknown>>();
	private readonly latest = new Map<string, string>();

	constructor(private readonly secrets: vscode.SecretStorage) { }

	/** Serializes changes so parallel sign-ins and refreshes cannot lose an account. */
	private mutate<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
		this.mutations.set(id, next);
		void next.finally(() => {
			if (this.mutations.get(id) === next) { this.mutations.delete(id); }
		}).catch(() => undefined);
		return next;
	}

	/** Reads the legacy session plus independently refreshable additional accounts. */
	async accounts(id: string): Promise<{ id: string; record: StoredOAuth }[]> {
		const result: { id: string; record: StoredOAuth }[] = [];
		const primary = await this.get(id);
		if (primary) { result.push({ id: 'primary', record: primary }); }
		const extra = await this.readExtra(id);
		for (const [slot, record] of Object.entries(extra)) { result.push({ id: slot, record }); }
		return result;
	}

	/** Only valid, provider-matched records from encrypted storage enter the pool. */
	private valid(id: string, value: unknown): value is StoredOAuth {
		const record = value as StoredOAuth | undefined;
		return !!record && record.type === id && typeof record.access === 'string' && !!record.access
			&& typeof record.refresh === 'string' && !!record.refresh && typeof record.expires === 'number' && Number.isFinite(record.expires);
	}

	private async readExtra(id: string): Promise<Record<string, StoredOAuth>> {
		try {
			const parsed: unknown = JSON.parse(await this.secrets.get(SECRET_PREFIX + 'accounts.' + id) ?? '{}');
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return {}; }
			return Object.fromEntries(Object.entries(parsed).filter(([slot, record]) => /^[a-f0-9-]{36}$/.test(slot) && this.valid(id, record)));
		} catch { return {}; }
	}

	async get(id: string, slot = 'primary'): Promise<StoredOAuth | undefined> {
		if (slot !== 'primary') { return (await this.readExtra(id))[slot]; }
		try {
			const parsed: unknown = JSON.parse(await this.secrets.get(SECRET_PREFIX + id) ?? 'null');
			return this.valid(id, parsed) ? parsed : undefined;
		} catch { return undefined; }
	}

	/** Writes one session; callers changing an existing session keep its stable slot. */
	async set(id: string, record: StoredOAuth, slot = 'primary'): Promise<void> {
		await this.mutate(id, () => this.write(id, slot, record));
	}

	private async write(id: string, slot: string, record?: StoredOAuth): Promise<void> {
		if (slot === 'primary') {
			if (record) { await this.secrets.store(SECRET_PREFIX + id, JSON.stringify(record)); }
			else { await this.secrets.delete(SECRET_PREFIX + id); }
			return;
		}
		const extra = await this.readExtra(id);
		if (record) { extra[slot] = record; } else { delete extra[slot]; }
		if (Object.keys(extra).length) { await this.secrets.store(SECRET_PREFIX + 'accounts.' + id, JSON.stringify(extra)); }
		else { await this.secrets.delete(SECRET_PREFIX + 'accounts.' + id); }
	}

	/** Adds a sign-in without overwriting other accounts; reauthorizing an account updates it. */
	async add(id: string, record: StoredOAuth): Promise<string> {
		if (!this.valid(id, record)) { throw new Error('The provider returned incomplete sign-in credentials. Please sign in again.'); }
		return this.mutate(id, async () => {
			const accounts = await this.accounts(id);
			const existing = accounts.find(a => a.record.access === record.access || a.record.refresh === record.refresh
				|| (!!record.accountId && a.record.accountId === record.accountId));
			const slot = existing?.id ?? (accounts.some(a => a.id === 'primary') ? randomUUID() : 'primary');
			await this.write(id, slot, record);
			this.latest.set(id, slot);
			return slot;
		});
	}

	/** Slot saved by the last completed interactive sign-in. */
	latestAccount(id: string): string { return this.latest.get(id) ?? 'primary'; }

	async remove(id: string, slot: string): Promise<void> {
		await this.mutate(id, () => this.write(id, slot));
	}

	async clear(id: string): Promise<void> {
		await this.mutate(id, async () => {
			await this.secrets.delete(SECRET_PREFIX + id);
			await this.secrets.delete(SECRET_PREFIX + 'accounts.' + id);
			this.latest.delete(id);
		});
	}

	/** Refreshes only the selected account, with single-flight per stable account slot. */
	async getFreshAccessToken(id: string, slot = 'primary'): Promise<string | undefined> {
		const record = await this.get(id, slot);
		if (!record) { return undefined; }
		if (record.type === 'openai' && record.accountId) { cacheChatGptAccountId(record.access, record.accountId); }
		if (record.expires - EXPIRY_SLACK_MS > Date.now()) { return record.access; }
		const key = id + ':' + slot;
		let inflight = this.refreshing.get(key);
		if (!inflight) {
			inflight = this.refreshRecord(id, slot, record).finally(() => this.refreshing.delete(key));
			this.refreshing.set(key, inflight);
		}
		return inflight;
	}

	/** A late refresh may neither resurrect a removed session nor overwrite a newer login. */
	private async refreshRecord(id: string, slot: string, record: StoredOAuth): Promise<string | undefined> {
		const refreshed = record.type === 'anthropic' ? await refreshAnthropic(record.refresh)
			: record.type === 'openai' ? await refreshOpenAI(record.refresh, record.access)
				: await refreshAntigravity(record.refresh);
		return this.mutate(id, async () => {
			const current = await this.get(id, slot);
			if (!current) { return undefined; }
			if (current.refresh !== record.refresh || current.access !== record.access) {
				cacheChatGptAccountId(current.access, current.accountId);
				return current.access;
			}
			if (refreshed === 'invalid') {
				await this.write(id, slot);
				throw new Error('Your web sign-in session expired. Please sign in again (HTTP 401).');
			}
			const next = { ...refreshed, accountId: refreshed.accountId ?? current.accountId, label: refreshed.label ?? current.label };
			await this.write(id, slot, next);
			cacheChatGptAccountId(next.access, next.accountId);
			return next.access;
		});
	}
}

/**
 * True when a token endpoint response means the refresh token is dead: 401/403, or a
 * 400 whose body says `invalid_grant`. Any other 400 is treated as a transient error.
 */
export function isRefreshRejected(status: number, json: any): boolean {
	if (status === 401 || status === 403) {
		return true;
	}
	if (status === 400) {
		const error = typeof json?.error === 'string' ? json.error : typeof json?.error?.type === 'string' ? json.error.type : typeof json?.error?.code === 'string' ? json.error.code : '';
		return error === 'invalid_grant';
	}
	return false;
}

const AUTH_REQUEST_TIMEOUT_MS = 25_000;

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
	});
	return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
	});
	return { status: response.status, json: await response.json().catch(() => ({})) };
}

function toRecord(type: StoredOAuth['type'], json: any, accountId?: string): StoredOAuth {
	return {
		type,
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000,
		accountId: accountId ?? (type === 'anthropic' && typeof json?.account?.uuid === 'string' ? json.account.uuid : undefined),
		label: typeof json?.account?.email_address === 'string' ? json.account.email_address.slice(0, 200)
			: typeof decodeJwtClaims(typeof json?.id_token === 'string' ? json.id_token : '')?.email === 'string' ? String(decodeJwtClaims(json.id_token)!.email).slice(0, 200) : undefined,
	};
}

async function refreshAnthropic(refreshToken: string): Promise<StoredOAuth | 'invalid'> {
	const { status, json } = await postJson(ANTHROPIC_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: ANTHROPIC_CLIENT_ID,
	});
	if (isRefreshRejected(status, json)) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the Claude sign-in (HTTP ${status}).`);
	}
	return toRecord('anthropic', { ...json, refresh_token: json.refresh_token ?? refreshToken });
}

async function refreshOpenAI(refreshToken: string, previousAccessToken: string): Promise<StoredOAuth | 'invalid'> {
	// Unlike the initial code exchange (form-encoded), OpenAI's refresh grant only
	// accepts a JSON body here — sending it form-encoded, like the code exchange, gets
	// silently ignored fields / auth failures. See providers/codex.py's
	// `_load_and_refresh_token` in the reference implementation this mirrors.
	const { status, json } = await postJson(OPENAI_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: OPENAI_CLIENT_ID,
		scope: 'openid profile email',
	});
	if (isRefreshRejected(status, json)) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the ChatGPT sign-in (HTTP ${status}).`);
	}
	// The refresh response doesn't always include a fresh id_token — carry the
	// previously-derived account id forward, same as the reference's
	// `tokens["id_token"] = new.get("id_token") or id_token`.
	const accountId = deriveChatGptAccountId(json.id_token) ?? chatgptAccountId(previousAccessToken);
	cacheChatGptAccountId(json.access_token, accountId);
	return toRecord('openai', { ...json, refresh_token: json.refresh_token ?? refreshToken }, accountId);
}

async function refreshAntigravity(refreshToken: string): Promise<StoredOAuth | 'invalid'> {
	const { status, json } = await postForm(ANTIGRAVITY_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: ANTIGRAVITY_CLIENT_ID,
		client_secret: antigravityClientSecret(),
	});
	if (isRefreshRejected(status, json)) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the Antigravity sign-in (HTTP ${status}).`);
	}
	return toRecord('antigravity', { ...json, refresh_token: json.refresh_token ?? refreshToken });
}

/** The two supported Claude authorization flows. */
export type ClaudeSignInMethod = 'browser' | 'code';

/** Authorizes Claude with either an automatic loopback callback or a pasted code. */
export async function signInAnthropic(store: OAuthTokenStore, method: ClaudeSignInMethod = 'browser'): Promise<boolean> {
	const pkce = createPkce();
	const expectedState = base64url(randomBytes(32));
	const authorize = (redirectUri: string): string => {
		const url = new URL(ANTHROPIC_AUTHORIZE_URL);
		url.searchParams.set('code', 'true');
		url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('redirect_uri', redirectUri);
		url.searchParams.set('scope', ANTHROPIC_SCOPES);
		url.searchParams.set('code_challenge', pkce.challenge);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('state', expectedState);
		return url.toString();
	};
	let code: string;
	let redirectUri = ANTHROPIC_REDIRECT_URI;
	if (method === 'browser') {
		const result = await waitForOAuthCallback('Claude', authorize, expectedState);
		if (!result) { return false; }
		code = result.code;
		redirectUri = result.redirectUri;
	} else {
		if (!await vscode.env.openExternal(vscode.Uri.parse(authorize(redirectUri)))) {
			throw new Error('Could not open the Claude sign-in page in a browser.');
		}
		const pasted = await vscode.window.showInputBox({
			title: 'Sign in with Claude — authorization code',
			prompt: 'Approve access in the browser, then paste the authorization code shown on the confirmation page.',
			placeHolder: 'Paste authorization code…', password: true, ignoreFocusOut: true,
		});
		if (!pasted?.trim()) { return false; }
		const parts = pasted.trim().split('#');
		code = parts[0];
		if (!code || parts.length > 2 || (parts[1] !== undefined && parts[1] !== expectedState)) {
			throw new Error('That code belongs to a different sign-in attempt. Start Claude sign-in again and paste the code it shows.');
		}
	}
	const { status, json } = await postJson(ANTHROPIC_TOKEN_URL, {
		grant_type: 'authorization_code', code, state: expectedState,
		client_id: ANTHROPIC_CLIENT_ID, redirect_uri: redirectUri, code_verifier: pkce.verifier,
	});
	if (status < 200 || status >= 300 || typeof json?.access_token !== 'string' || !json.access_token
		|| typeof json?.refresh_token !== 'string' || !json.refresh_token) {
		throw new Error(`Claude sign-in failed (HTTP ${status}). Please start sign-in again.`);
	}
	await store.add('anthropic', toRecord('anthropic', json));
	return true;
}

/** Uses the public Claude OAuth client's supported localhost redirect, bound only to loopback. */
function waitForOAuthCallback(label: string, authorize: (redirectUri: string) => string, expectedState: string, port = 0, callbackPath = '/callback'): Promise<{ code: string; redirectUri: string } | undefined> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let redirectUri = '';
		let cancelSubscription: vscode.Disposable | undefined;
		let progressDone: (() => void) | undefined;
		const finish = (complete: () => void): void => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			cancelSubscription?.dispose();
			server.close();
			progressDone?.();
			complete();
		};
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (url.pathname !== callbackPath || req.method !== 'GET') { res.writeHead(404).end(); return; }
			if (url.searchParams.get('state') !== expectedState) { res.writeHead(400).end('Invalid sign-in state.'); return; }
			const code = url.searchParams.get('code');
			const error = url.searchParams.get('error');
			res.writeHead(code && !error ? 200 : 400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
			res.end('Sign-in received. Return to Stormcoder. You can close this page.');
			finish(() => {
				if (error || !code) { reject(new Error(`${label} sign-in was rejected or returned an invalid callback.`)); }
				else { resolve({ code, redirectUri }); }
			});
		});
		const timer = setTimeout(() => finish(() => reject(new Error(`${label} sign-in timed out. Try again.`))), SIGN_IN_TIMEOUT_MS);
		server.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(new Error(err.code === 'EADDRINUSE'
			? `Port ${port} is in use. Close the other sign-in and try again.` : `Could not start the ${label} browser callback.`))));
		server.listen(port, '127.0.0.1', () => {
			if (settled) { server.close(); return; }
			const address = server.address();
			if (!address || typeof address === 'string') { finish(() => reject(new Error('Could not start the browser callback.'))); return; }
			redirectUri = `http://localhost:${address.port}${callbackPath}`;
			void vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Waiting for ${label} sign-in in the browser…`, cancellable: true },
				(_progress, cancel) => new Promise<void>(done => {
					progressDone = done;
					cancelSubscription = cancel.onCancellationRequested(() => finish(() => resolve(undefined)));
					if (settled) { done(); }
				}),
			).then(undefined, () => finish(() => reject(new Error(`${label} sign-in was interrupted.`))));
			if (settled) { return; }
			void vscode.env.openExternal(vscode.Uri.parse(authorize(redirectUri))).then(opened => {
				if (!opened) { finish(() => reject(new Error('Could not open the sign-in page in a browser.'))); }
			}, () => finish(() => reject(new Error('Could not open the sign-in page in a browser.'))));
		});
	});
}

export interface OpenAISignInResult {
	/** How the session will authenticate: a real API key, or ChatGPT subscription tokens. */
	readonly mode: 'apiKey' | 'chatgpt';
	/** Present when the account had API access and a key could be minted. */
	readonly apiKey?: string;
}

/**
 * Runs the ChatGPT account sign-in: starts a one-shot localhost callback server (the
 * redirect URI registered for OpenAI's public CLI client is fixed to port 1455),
 * opens the browser, and exchanges the returned code. If the account has API access,
 * an API key is minted via token exchange and returned; otherwise the subscription
 * tokens are stored for the ChatGPT backend. Returns undefined when cancelled.
 */
export async function signInOpenAI(store: OAuthTokenStore): Promise<OpenAISignInResult | undefined> {
	const pkce = createPkce();
	const state = base64url(randomBytes(16));
	const url = new URL(`${OPENAI_ISSUER}/oauth/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', OPENAI_CLIENT_ID);
	url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
	url.searchParams.set('scope', OPENAI_SCOPES);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('id_token_add_organizations', 'true');
	url.searchParams.set('codex_cli_simplified_flow', 'true');
	url.searchParams.set('originator', 'codex_cli_rs');

	const code = await waitForOpenAICallback(url.toString(), state);
	if (!code) {
		return undefined;
	}

	const { status, json } = await postForm(OPENAI_TOKEN_URL, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: OPENAI_REDIRECT_URI,
		client_id: OPENAI_CLIENT_ID,
		code_verifier: pkce.verifier,
	});
	if (typeof json?.access_token !== 'string') {
		throw new Error(`ChatGPT sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	const accountId = deriveChatGptAccountId(json.id_token);
	cacheChatGptAccountId(json.access_token, accountId);

	// Accounts with API access can mint a normal API key from the id token; that is
	// the most compatible path (works with every OpenAI endpoint). Subscription-only
	// accounts fall back to the ChatGPT backend using the OAuth access token.
	if (typeof json.id_token === 'string') {
		try {
			const exchanged = await postForm(OPENAI_TOKEN_URL, {
				grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
				client_id: OPENAI_CLIENT_ID,
				requested_token: 'openai-api-key',
				subject_token: json.id_token,
				subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
			});
			const key = exchanged.json?.access_token;
			if (typeof key === 'string' && key.startsWith('sk-')) {
				return { mode: 'apiKey', apiKey: key };
			}
		} catch {
			// No API org / exchange unavailable: use the subscription path below.
		}
	}

	await store.add('openai', toRecord('openai', json, accountId));
	return { mode: 'chatgpt' };
}

/**
 * Serves the OAuth redirect on localhost:1455 for a single sign-in attempt and
 * resolves with the authorization code (or undefined on cancel/timeout).
 */
async function waitForOpenAICallback(authorizeUrl: string, expectedState: string): Promise<string | undefined> {
	return (await waitForOAuthCallback('ChatGPT', () => authorizeUrl, expectedState, OPENAI_CALLBACK_PORT, '/auth/callback'))?.code;
}

/**
 * Runs the Google Antigravity sign-in: PKCE + a local callback server on the fixed
 * port Antigravity's own OAuth client is registered against. See the caveat on
 * `ANTIGRAVITY_CLIENT_ID` above before wiring this up anywhere new.
 */
export async function signInAntigravity(store: OAuthTokenStore): Promise<boolean> {
	// Fail before opening a browser tab if the secret isn't configured.
	const clientSecret = antigravityClientSecret();

	const pkce = createPkce();
	const state = base64url(randomBytes(16));
	const url = new URL(ANTIGRAVITY_AUTHORIZE_URL);
	url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI);
	url.searchParams.set('scope', ANTIGRAVITY_SCOPES);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('access_type', 'offline');
	// select_account makes Google show its account chooser even when the browser is already signed in,
	// so a second Google account can be added without signing out of the first.
	url.searchParams.set('prompt', 'select_account consent');
	url.searchParams.set('state', state);

	const code = await waitForAntigravityCallback(url.toString(), state);
	if (!code) {
		return false;
	}

	const { status, json } = await postForm(ANTIGRAVITY_TOKEN_URL, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		client_id: ANTIGRAVITY_CLIENT_ID,
		client_secret: clientSecret,
		code_verifier: pkce.verifier,
	});
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Antigravity sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	const who = await fetchGoogleIdentity(json.access_token);
	const base = toRecord('antigravity', json, who?.id);
	const record: StoredOAuth = who?.email ? { ...base, label: who.email.slice(0, 200) } : base;
	await store.add('antigravity', record);
	return true;
}

/**
 * Looks up which Google account a fresh token belongs to, so a repeat sign-in updates that account
 * instead of adding a duplicate, and the account list can show the address. Best effort: without it
 * the account is still stored, just unlabelled.
 */
async function fetchGoogleIdentity(accessToken: string): Promise<{ id?: string; email?: string } | undefined> {
	try {
		const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) { return undefined; }
		const json: any = await res.json();
		return {
			id: typeof json?.id === 'string' ? json.id : undefined,
			email: typeof json?.email === 'string' ? json.email : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Serves the OAuth redirect on localhost:51121 for a single sign-in attempt and
 * resolves with the authorization code (or undefined on cancel/timeout).
 */
async function waitForAntigravityCallback(authorizeUrl: string, expectedState: string): Promise<string | undefined> {
	return (await waitForOAuthCallback('Antigravity', () => authorizeUrl, expectedState, ANTIGRAVITY_CALLBACK_PORT, '/oauth-callback'))?.code;
}

/**
 * Runs the OpenRouter one-click sign-in: a PKCE flow against openrouter.ai that ends
 * with OpenRouter minting a user-controlled API key (no expiry, revocable from their
 * dashboard), which we store like a pasted key. Serves the callback on an ephemeral
 * localhost port since OpenRouter accepts any `callback_url`. Returns the key, or
 * undefined when the user cancelled.
 */
export async function signInOpenRouter(): Promise<string | undefined> {
	const pkce = createPkce();
	const code = await waitForOpenRouterCallback(pkce.challenge);
	if (!code) {
		return undefined;
	}
	const { status, json } = await postJson(OPENROUTER_KEYS_URL, {
		code,
		code_verifier: pkce.verifier,
		code_challenge_method: 'S256',
	});
	if (typeof json?.key !== 'string') {
		throw new Error(`OpenRouter sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	return json.key;
}

/**
 * Serves the OpenRouter OAuth redirect on an ephemeral localhost port for a single
 * sign-in attempt and resolves with the authorization code (or undefined on cancel).
 */
function waitForOpenRouterCallback(codeChallenge: string): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
			if (requestUrl.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			const error = requestUrl.searchParams.get('error');
			const code = requestUrl.searchParams.get('code');
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html><body style="font-family:sans-serif"><h2>Sign-in received</h2><p>You can close this window and return to the editor.</p></body></html>');
			finish(() => {
				if (error) {
					reject(new Error(`OpenRouter sign-in was rejected: ${error}`));
				} else if (!code) {
					reject(new Error('OpenRouter sign-in returned an invalid callback.'));
				} else {
					resolve(code);
				}
			});
		});

		const timer = setTimeout(() => finish(() => reject(new Error('Sign-in timed out. Please try again.'))), SIGN_IN_TIMEOUT_MS);

		function finish(complete: () => void): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			server.close();
			complete();
		}

		server.on('error', err => finish(() => reject(err)));

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const url = new URL(OPENROUTER_AUTH_URL);
			url.searchParams.set('callback_url', `http://127.0.0.1:${port}/callback`);
			url.searchParams.set('code_challenge', codeChallenge);
			url.searchParams.set('code_challenge_method', 'S256');
			vscode.env.openExternal(vscode.Uri.parse(url.toString())).then(opened => {
				if (!opened) {
					finish(() => reject(new Error('Could not open the sign-in page in a browser.')));
				}
			});
		});

		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Waiting for OpenRouter sign-in in the browser…', cancellable: true },
			(_progress, cancel) => new Promise<void>(done => {
				cancel.onCancellationRequested(() => finish(() => resolve(undefined)));
				const poll = setInterval(() => {
					if (settled) {
						clearInterval(poll);
						done();
					}
				}, 250);
			}),
		);
	});
}

/** A fresh session id per extension host, matching the first-party client's header. */
export const chatgptSessionId = randomUUID();
