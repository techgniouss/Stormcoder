/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { OAuthTokenStore } from '../oauth';
import { AnthropicProvider } from './anthropic';
import { AntigravityProvider } from './antigravity';
import { ClaudeCodeCliProvider } from './claudeCodeCli';
import { CLOUDFLARE_ACCOUNT_PLACEHOLDER, CloudflareProvider } from './cloudflare';
import { CooldownTracker } from './cooldown';
import { CopilotProvider } from './copilot';
import { OAuthProxyChatProvider } from './oauthProxy';
import { CustomProvider } from './custom';
import { GeminiProvider } from './gemini';
import { GrokProvider } from './grok';
import { GroqProvider } from './groq';
import { withProviderResilience } from './resilience';
import { KimiProvider } from './kimi';
import { KiroProvider } from './kiro';
import { MistralProvider } from './mistral';
import { NvidiaProvider } from './nvidia';
import { OpenAIProvider } from './openai';
import { OpenCodeZenProvider } from './opencodeZen';
import { OpenRouterProvider } from './openrouter';
import { QwenProvider } from './qwen';
import { ChatProvider, ModelEntry, notePooledKeys } from './types';
import { GeminiWebProvider } from './webCookie/geminiWebProvider';
import { XkiroProvider } from './xkiro';
import { ZaiProvider } from './zai';

const SECRET_PREFIX = 'stormcoder.apiKey.';
/** Backup keys for a provider, stored as a JSON string array. Rotated in on a 401/403/429
 * against the primary key — see {@link ProviderRegistry.rotateApiKey}. */
const EXTRA_KEY_PREFIX = 'stormcoder.apiKeysExtra.';

/**
 * Environment variables that can supply a provider's key, as a convenient escape hatch for
 * power users and CI. Each name is the one that provider's own SDK already reads, so an
 * environment set up for the vendor's CLI works here unchanged. Providers absent from this
 * map are configured through the panel only.
 */
const ENV_VARS: Record<string, string | undefined> = {
	openai: 'OPENAI_API_KEY',
	anthropic: 'ANTHROPIC_API_KEY',
	nvidia: 'NVIDIA_API_KEY',
	gemini: 'GEMINI_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	kimi: 'MOONSHOT_API_KEY',
	qwen: 'DASHSCOPE_API_KEY',
	groq: 'GROQ_API_KEY',
	mistral: 'MISTRAL_API_KEY',
	cloudflare: 'CLOUDFLARE_API_TOKEN',
	custom: 'CUSTOM_API_KEY',
};

/**
 * Providers with no `<id>.baseUrl` setting in package.json, so the panel's base-URL field
 * has nothing to read or write. Antigravity is the OAuth-spoofing backend that never fully
 * worked and now bans real accounts (see AntigravityProvider) — it ignores the `baseUrl`
 * it's handed and talks to a hardcoded endpoint. Copilot, Grok and Kiro are the same
 * category of OAuth-proxy backend, each pinned to one endpoint (or, for Copilot, an
 * account-reported one) that a user-supplied base URL could not meaningfully redirect.
 * `claude-code-cli` has no HTTP endpoint at all to redirect — it spawns a local binary — so
 * it gets its own `claude-code-cli.cliPath` setting instead (see ClaudeCodeCliProvider).
 */
const NO_BASE_URL_SETTING = new Set(['antigravity', 'copilot', 'grok', 'kiro', 'web_gemini', 'claude-code-cli']);

/** Per-provider runtime configuration resolved from settings + secret storage. */
export interface ResolvedProviderConfig {
	readonly id: string;
	readonly label: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly suggestedModels: string[];
	readonly apiKeyUrl: string;
	readonly requiresApiKey: boolean;
	readonly hasApiKey: boolean;
	/** True when the key comes from an environment variable, which can't be cleared from the panel. */
	readonly hasEnvKey: boolean;
	readonly supportsTools: boolean;
	/** Regex sources (case-insensitive) marking which models support Agent mode. */
	readonly toolModelPatterns: string[];
	/** Regex sources (case-insensitive) marking which models accept image attachments. */
	readonly visionModelPatterns: string[];
	/** A configured web sign-in endpoint, if any (enables the "Sign in" button). */
	readonly authUrl: string;
	/** How the current credential was obtained: web sign-in, an API key, or nothing. */
	readonly authKind: 'oauth' | 'key' | 'none';
	/**
	 * Cloudflare Workers AI only: the account id `getBaseUrl` substitutes into the URL
	 * (a token alone can't authenticate — see `CLOUDFLARE_ACCOUNT_PLACEHOLDER`). Undefined
	 * for every other provider; the settings panel only renders the field when this is set.
	 */
	readonly cloudflareAccountId?: string;
	/**
	 * Raw `<id>.baseUrl` setting value, unlike {@link baseUrl} which is what requests
	 * actually use (trailing slash stripped, Cloudflare's `{account_id}` substituted). This
	 * is what the panel's base-URL field edits — substituting the placeholder into it and
	 * saving that back would bake today's account id in and break the substitution for the
	 * next one. Undefined for providers with no such setting (see `NO_BASE_URL_SETTING`).
	 */
	readonly baseUrlOverride?: string;
	/** How many backup keys are stored beyond the primary — see {@link EXTRA_KEY_PREFIX}. */
	readonly extraApiKeyCount: number;
	/** Safe account metadata only; tokens and keys never enter webview messages. */
	readonly accounts: ProviderAccount[];
}

/** A credential row safe to display in Settings. */
export interface ProviderAccount {
	readonly id: string;
	readonly label: string;
	readonly kind: 'oauth' | 'key' | 'env';
	readonly active: boolean;
	readonly cooldownUntil: number;
	readonly removable: boolean;
}

interface Credential {
	id: string;
	kind: 'oauth' | 'key' | 'env';
	label: string;
	key?: string;
	slot?: string;
}

/** Stable opaque identity, so pool edits never move a cooldown onto another key. */
function keyId(key: string): string {
	return 'key:' + createHash('sha256').update(key).digest('hex');
}

/**
 * Owns the set of available chat providers and brokers access to their
 * configuration and (securely stored) API keys.
 */
export class ProviderRegistry {
	private readonly providers = new Map<string, ChatProvider>();
	/** OAuth sessions from the built-in web sign-in flows (Claude / ChatGPT accounts). */
	readonly oauth: OAuthTokenStore;
	private readonly activeCredential = new Map<string, string>();
	private readonly credentialCooldowns = new CooldownTracker();
	/** Maps issued wire tokens back to stable accounts, including across token refresh. */
	private readonly issued = new Map<string, Map<string, string>>();
	private readonly mutations = new Map<string, Promise<unknown>>();
	/** Per (provider, model) quota parking — see {@link CooldownTracker}. Public so
	 * `auto/router.ts` and `chatViewProvider.ts` can consult it without a registry method
	 * per call site. */
	readonly cooldowns = new CooldownTracker();

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.oauth = new OAuthTokenStore(secrets);
		for (const provider of [new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider(() => vscode.workspace.getConfiguration('stormcoder').get<string>('anthropic.thinking') === 'off' ? 'off' : 'auto'), new GeminiProvider(), new AntigravityProvider(), new OpenRouterProvider(), new GroqProvider(), new MistralProvider(), new CloudflareProvider(), new KimiProvider(), new QwenProvider(), new ZaiProvider(), new OpenCodeZenProvider(), new XkiroProvider(), new CopilotProvider(), new GrokProvider(), new KiroProvider(), new GeminiWebProvider(), new ClaudeCodeCliProvider(), new CustomProvider()]) {
			this.providers.set(provider.info.id, provider);
			if (provider instanceof OAuthProxyChatProvider) {
				provider.setCredentialPersister((previous, next) => this.replaceStoredKey(provider.info.id, previous, next));
			}
		}
	}

	get ids(): string[] {
		return [...this.providers.keys()];
	}

	getProvider(id: string): ChatProvider | undefined {
		return this.providers.get(id);
	}

	getDefaultProviderId(): string {
		const configured = vscode.workspace.getConfiguration('stormcoder').get<string>('defaultProvider');
		if (configured && this.providers.has(configured)) {
			return configured;
		}
		return this.ids[0];
	}

	getModel(id: string): string {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		const configured = cfg.get<string>(`${id}.model`);
		return configured?.trim() || this.providers.get(id)?.info.suggestedModels[0] || '';
	}

	getBaseUrl(id: string): string {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		const configured = (cfg.get<string>(`${id}.baseUrl`)?.trim() || '').replace(/\/+$/, '');
		if (id === 'cloudflare') {
			// Cloudflare is the one backend whose credential is split between a header and the
			// URL path, so the account id is substituted here — the single place the base URL is
			// resolved — rather than being threaded through every provider call. Left in place
			// when unset so the provider can raise a message that names the setting.
			const accountId = cfg.get<string>('cloudflare.accountId')?.trim();
			return accountId ? configured.replace(CLOUDFLARE_ACCOUNT_PLACEHOLDER, accountId) : configured;
		}
		return configured;
	}

	getAuthUrl(id: string): string {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		return (cfg.get<string>(`${id}.authUrl`)?.trim() || '');
	}

	getMaxTokens(): number {
		return vscode.workspace.getConfiguration('stormcoder').get<number>('maxTokens') ?? 8192;
	}

	getSystemPrompt(): string {
		return vscode.workspace.getConfiguration('stormcoder').get<string>('systemPrompt') ?? '';
	}

	/** The environment variable that can supply this provider's key, if any. */
	private envVarName(id: string): string | undefined {
		return ENV_VARS[id];
	}

	/** Whether an environment credential is configured; it cannot be removed from Settings. */
	hasEnvKey(id: string): boolean {
		const envName = this.envVarName(id);
		return !!(envName && process.env[envName]);
	}

	/** All stored keys, deduplicated, including a backup-only configuration. */
	async getApiKeys(id: string): Promise<string[]> {
		const primary = await this.secrets.get(SECRET_PREFIX + id);
		const all = [...new Set([primary, ...await this.getExtraApiKeys(id)].filter((k): k is string => !!k))];
		return all;
	}

	/** Builds the credential pool without refreshing or exposing any secrets to the UI. */
	private async credentials(id: string): Promise<Credential[]> {
		const envName = this.envVarName(id);
		const envKey = envName ? process.env[envName] : undefined;
		const keys = await this.getApiKeys(id);
		const result: Credential[] = keys.map((key, i) => ({ id: keyId(key), kind: 'key', key, label: `API key ${i + 1}` }));
		if (envKey) {
			const duplicate = result.findIndex(c => c.key === envKey);
			if (duplicate >= 0) { result.splice(duplicate, 1); }
			result.unshift({ id: keyId(envKey), kind: 'env', key: envKey, label: envName! });
		}
		const accounts = await this.oauth.accounts(id);
		for (const [i, account] of accounts.entries()) {
			result.push({ id: 'oauth:' + account.id, kind: 'oauth', slot: account.id, key: account.record.access, label: account.record.label || `Signed-in account ${i + 1}` });
		}
		notePooledKeys(result.map(c => c.key ?? ''), id);
		return result;
	}

	private available(id: string, credentials: Credential[]): Credential | undefined {
		const ready = credentials.filter(c => !this.credentialCooldowns.isCoolingDown(id, c.id));
		return ready.find(c => c.id === this.activeCredential.get(id)) ?? ready[0];
	}

	/** Resolves and refreshes just the selected account. A dead session cannot block backups. */
	async getApiKey(id: string): Promise<string | undefined> {
		let lastError: unknown;
		const credentials = await this.credentials(id);
		if (!credentials.length) { return undefined; }
		for (let attempt = 0; attempt < credentials.length; attempt++) {
			const credential = this.available(id, credentials);
			if (!credential) { break; }
			this.activeCredential.set(id, credential.id);
			try {
				const token = credential.kind === 'oauth'
					? await this.oauth.getFreshAccessToken(id, credential.slot) : credential.key;
				if (!token) { throw new Error('The selected account was removed.'); }
				credential.key = token;
				notePooledKeys(credentials.map(c => c.key ?? ''), id);
				let issued = this.issued.get(id);
				if (!issued) { issued = new Map(); this.issued.set(id, issued); }
				issued.set(token, credential.id);
				if (issued.size > 1000) { issued.delete(issued.keys().next().value!); }
				return token;
			} catch (err) {
				lastError = err;
				this.credentialCooldowns.markCooldown(id, credential.id, String(err));
			}
		}
		if (lastError) { throw lastError; }
		throw new Error('All saved accounts or keys for ' + id + ' are cooling down after a limit or authentication failure. Wait for the cooldown or add another account in Settings.');
	}

	/** Parks exactly the failed account; concurrent failures cannot skip a healthy account. */
	async rotateApiKey(id: string, failedKey?: string, detail = 'HTTP 429'): Promise<boolean> {
		const credentials = await this.credentials(id);
		const failedId = failedKey ? this.issued.get(id)?.get(failedKey)
			?? credentials.find(c => c.key === failedKey)?.id : this.activeCredential.get(id);
		// A long-running agent may still hold an access token that expired mid-run.
		// Refresh that account before treating an ordinary expiry as quota exhaustion.
		const failed = credentials.find(c => c.id === failedId);
		if (/\bhttp 401\b/i.test(detail) && failed?.kind === 'oauth') {
			try {
				const fresh = await this.oauth.getFreshAccessToken(id, failed.slot);
				if (fresh && fresh !== failedKey) {
					this.activeCredential.set(id, failed.id);
					return true;
				}
			} catch { /* A dead login must not prevent the next account from taking over. */ }
		}
		if (failedId) { this.credentialCooldowns.markCooldown(id, failedId, detail); }
		const next = this.available(id, credentials);
		if (!next || next.id === failedId) { return false; }
		this.activeCredential.set(id, next.id);
		return true;
	}

	/** Success never erases a different account's cooldown. */
	noteApiKeySuccess(_id: string): void { }

	/** Settings receives only opaque ids, labels and state, never credential contents. */
	async getAccounts(id: string): Promise<ProviderAccount[]> {
		const credentials = await this.credentials(id);
		const active = this.available(id, credentials)?.id;
		return credentials.map(c => ({
			id: c.id, label: c.label, kind: c.kind, active: c.id === active,
			cooldownUntil: this.credentialCooldowns.remainingMs(id, c.id) ? Date.now() + this.credentialCooldowns.remainingMs(id, c.id) : 0, removable: c.kind !== 'env',
		}));
	}

	/** Removes exactly one stored credential while retaining the other accounts. */
	async removeAccount(id: string, accountId: string): Promise<void> {
		await this.mutate(id, async () => {
			const credential = (await this.credentials(id)).find(c => c.id === accountId);
			if (!credential || credential.kind === 'env') { return; }
			if (credential.kind === 'oauth') { await this.oauth.remove(id, credential.slot!); }
			else {
				if (await this.secrets.get(SECRET_PREFIX + id) === credential.key) { await this.secrets.delete(SECRET_PREFIX + id); }
				await this.writeExtraApiKeys(id, (await this.getExtraApiKeys(id)).filter(k => k !== credential.key));
			}
			if (this.activeCredential.get(id) === accountId) { this.activeCredential.delete(id); }
		});
	}

	/** Queues read/modify/write changes to stored keys and imported login credentials. */
	private mutate<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
		this.mutations.set(id, next);
		void next.finally(() => { if (this.mutations.get(id) === next) { this.mutations.delete(id); } }).catch(() => undefined);
		return next;
	}

	/** Adds a key or imported login without replacing any previously configured account. */
	async addApiKey(id: string, key: string): Promise<void> {
		const cleaned = key.trim();
		if (!cleaned) { return; }
		await this.mutate(id, async () => {
			const keys = await this.getApiKeys(id);
			if (!keys.includes(cleaned)) {
				if (!await this.secrets.get(SECRET_PREFIX + id)) { await this.secrets.store(SECRET_PREFIX + id, cleaned); }
				else { await this.writeExtraApiKeys(id, [...await this.getExtraApiKeys(id), cleaned]); }
			}
			this.cooldowns.clearProvider(id);
			this.credentialCooldowns.clear(id, keyId(cleaned));
			this.activeCredential.set(id, keyId(cleaned));
		});
	}

	/** The provider's backup key pool, beyond the primary key — see {@link EXTRA_KEY_PREFIX}. */
	async getExtraApiKeys(id: string): Promise<string[]> {
		const raw = await this.secrets.get(EXTRA_KEY_PREFIX + id);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0) : [];
		} catch {
			return [];
		}
	}

	/** Replaces the provider's backup key pool. An empty list clears the stored secret entirely
	 * rather than persisting an empty array, so `hasExtraApiKeys`-style checks stay simple. */
	async setExtraApiKeys(id: string, keys: string[]): Promise<void> {
		await this.mutate(id, () => this.writeExtraApiKeys(id, keys));
		this.cooldowns.clearProvider(id);
	}

	private async writeExtraApiKeys(id: string, keys: string[]): Promise<void> {
		const cleaned = [...new Set(keys.map(k => k.trim()).filter(k => k.length > 0))];
		if (cleaned.length) {
			await this.secrets.store(EXTRA_KEY_PREFIX + id, JSON.stringify(cleaned));
		} else {
			await this.secrets.delete(EXTRA_KEY_PREFIX + id);
		}
	}

	/** Credential presence is checked without triggering a refresh. */
	async hasCredentials(id: string): Promise<boolean> {
		return (await this.credentials(id)).length > 0;
	}

	/** How the currently selected credential authenticates. */
	async getAuthKind(id: string): Promise<'oauth' | 'key' | 'none'> {
		const credentials = await this.credentials(id);
		const credential = this.available(id, credentials) ?? credentials[0];
		return credential ? (credential.kind === 'oauth' ? 'oauth' : 'key') : 'none';
	}

	/**
	 * Replaces one stored credential with its refreshed form, wherever it sits in `id`'s pool
	 * (the primary key or a backup), leaving the rest untouched. For providers whose stored
	 * "key" is a refreshable token pair — see `OAuthProxyChatProvider.setCredentialPersister`.
	 * A credential no longer stored (removed or replaced meanwhile) is left alone.
	 */
	async replaceStoredKey(id: string, previous: string, next: string): Promise<void> {
		await this.mutate(id, async () => {
			if (await this.secrets.get(SECRET_PREFIX + id) === previous) {
				await this.secrets.store(SECRET_PREFIX + id, next);
			} else {
				const extra = await this.getExtraApiKeys(id);
				const index = extra.indexOf(previous);
				if (index < 0) { return; }
				extra[index] = next;
				await this.writeExtraApiKeys(id, extra);
			}
			if (this.activeCredential.get(id) === keyId(previous)) { this.activeCredential.set(id, keyId(next)); }
			for (const [token, account] of this.issued.get(id) ?? []) {
				if (account === keyId(previous)) { this.issued.get(id)!.set(token, keyId(next)); }
			}
		});
	}

	/** Replaces the primary API key, preserving independently configured login accounts. */
	async setApiKey(id: string, key: string): Promise<void> {
		await this.mutate(id, async () => {
			await this.secrets.store(SECRET_PREFIX + id, key);
			this.cooldowns.clearProvider(id);
			this.credentialCooldowns.clear(id, keyId(key));
			this.activeCredential.set(id, keyId(key));
		});
	}

	/** Selects the just-added login without deleting API keys or other sessions. */
	async adoptOAuth(id: string): Promise<void> {
		const accountId = 'oauth:' + this.oauth.latestAccount(id);
		this.cooldowns.clearProvider(id);
		this.credentialCooldowns.clear(id, accountId);
		this.activeCredential.set(id, accountId);
	}

	async setModel(id: string, model: string): Promise<void> {
		await vscode.workspace.getConfiguration('stormcoder').update(
			`${id}.model`, model, vscode.ConfigurationTarget.Global);
	}

	/** Persists the Cloudflare account id — see `cloudflareAccountId` on {@link ResolvedProviderConfig}. */
	async setCloudflareAccountId(accountId: string): Promise<void> {
		await vscode.workspace.getConfiguration('stormcoder').update(
			'cloudflare.accountId', accountId.trim(), vscode.ConfigurationTarget.Global);
	}

	/**
	 * Persists a provider's base URL override, or clears it back to the package.json
	 * default when the field is emptied — an explicit empty string would otherwise win
	 * over that default rather than falling back to it.
	 */
	async setBaseUrl(id: string, value: string): Promise<void> {
		const trimmed = value.trim();
		await vscode.workspace.getConfiguration('stormcoder').update(
			`${id}.baseUrl`, trimmed || undefined, vscode.ConfigurationTarget.Global);
	}

	/** Fetches the live model list for a provider using its stored key (if it needs one). */
	async listModels(id: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const provider = this.providers.get(id);
		if (!provider) {
			throw new Error(`Unknown provider: ${id}`);
		}
		return withProviderResilience(this, id, this.getModel(id), async apiKey => {
			if (!apiKey && provider.info.requiresApiKey) { throw new Error(`Set an API key for ${provider.info.label} first.`); }
			return provider.listModels(apiKey, this.getBaseUrl(id), signal);
		});
	}

	async clearApiKey(id: string): Promise<void> {
		await this.mutate(id, async () => {
			await this.secrets.delete(SECRET_PREFIX + id);
			await this.secrets.delete(EXTRA_KEY_PREFIX + id);
			await this.oauth.clear(id);
			this.activeCredential.delete(id);
			this.cooldowns.clearProvider(id);
			this.issued.delete(id);
		});
	}

	async resolve(id: string): Promise<ResolvedProviderConfig | undefined> {
		const provider = this.providers.get(id);
		if (!provider) {
			return undefined;
		}
		return {
			id,
			label: provider.info.label,
			model: this.getModel(id),
			baseUrl: this.getBaseUrl(id) || '',
			suggestedModels: provider.info.suggestedModels,
			apiKeyUrl: provider.info.apiKeyUrl,
			requiresApiKey: provider.info.requiresApiKey,
			hasApiKey: await this.hasCredentials(id),
			hasEnvKey: this.hasEnvKey(id),
			supportsTools: provider.info.supportsTools,
			toolModelPatterns: provider.info.toolModelPatterns,
			visionModelPatterns: provider.info.visionModelPatterns,
			authUrl: this.getAuthUrl(id),
			authKind: await this.getAuthKind(id),
			cloudflareAccountId: id === 'cloudflare'
				? (vscode.workspace.getConfiguration('stormcoder').get<string>('cloudflare.accountId')?.trim() ?? '')
				: undefined,
			baseUrlOverride: NO_BASE_URL_SETTING.has(id)
				? undefined
				: (vscode.workspace.getConfiguration('stormcoder').get<string>(`${id}.baseUrl`)?.trim() ?? ''),
			extraApiKeyCount: (await this.getExtraApiKeys(id)).length,
			accounts: await this.getAccounts(id),
		};
	}

	async resolveAll(): Promise<ResolvedProviderConfig[]> {
		const result: ResolvedProviderConfig[] = [];
		for (const id of this.ids) {
			const resolved = await this.resolve(id);
			if (resolved) {
				result.push(resolved);
			}
		}
		return result;
	}
}
