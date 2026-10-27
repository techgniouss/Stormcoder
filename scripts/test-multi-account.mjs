// Exercises real encrypted-store interfaces, account selection and OAuth HTTP callbacks
// with in-memory secrets and provider HTTP responses. Never uses a real account.
import assert from 'node:assert/strict';
import Module from 'node:module';
import http from 'node:http';
import { createHash } from 'node:crypto';

class Secrets {
	map = new Map();
	async get(key) { return this.map.get(key); }
	async store(key, value) { this.map.set(key, value); }
	async delete(key) { this.map.delete(key); }
}
let openExternal = async () => true;
let input = async () => undefined;
let onProgress = () => {};
const stub = {
	workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
	env: { openExternal: uri => openExternal(String(uri)) }, Uri: { parse: s => s },
	ProgressLocation: { Notification: 15 },
	window: {
		showInputBox: opts => input(opts),
		withProgress: (_opts, task) => task({}, {
			onCancellationRequested: fn => { onProgress(fn); return { dispose() {} }; },
		}),
	},
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...rest); };
const { ProviderRegistry } = await import('../out/providers/registry.js');
const { OAuthTokenStore, signInAnthropic, chatgptAccountId } = await import('../out/oauth.js');
const { withProviderResilience, isKeyFailure } = await import('../out/providers/resilience.js');
const { RateLimitTracker } = await import('../out/providers/rateLimits.js');
const { apiFetch, notePooledKeys, notePooledCredentialAlias, describeHttpError } = await import('../out/providers/types.js');
const { REMOTE_DENIED } = await import('../out/remote/policy.js');
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const previousEnv = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
const session = (type, name, extra = {}) => ({ type, access: `${name}-access`, refresh: `${name}-refresh`, expires: Date.now() + 3_600_000, ...extra });
const limited = () => new Error('Provider: rate limited (HTTP 429) usage_limit_reached');

try {
	// A depleted account's token window cannot pace another account on the same model.
	{
		const tracker = new RateLimitTracker();
		const depleted = tracker.fetchOpts('same-model', 'account-a');
		depleted.onResponse(new Response('', { headers: {
			'x-ratelimit-limit-tokens': '10000', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '30s',
		} }));
		assert.ok(depleted.pace(100) > 0);
		assert.equal(tracker.fetchOpts('same-model', 'account-b').pace(100), 0);
	}
	// Exchanged wire tokens use immediate fallback too; removing a pool restores single-key retries.
	{
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }); };
		notePooledKeys(['stored-a', 'stored-b'], 'wire-test');
		notePooledCredentialAlias('stored-a', 'exchanged-wire-token');
		await apiFetch('https://example.test', { headers: { Authorization: 'Bearer exchanged-wire-token' } }, new AbortController().signal);
		assert.equal(calls, 1);
		notePooledKeys(['stored-a'], 'wire-test');
		calls = 0;
		await apiFetch('https://example.test', { headers: { Authorization: 'Bearer stored-a' } }, new AbortController().signal, { rateLimitRetries: 1 });
		assert.equal(calls, 2, 'single-key retry behavior is preserved after pool removal');
		notePooledKeys([], 'wire-test');
		const reset = await describeHttpError('ChatGPT', new Response(JSON.stringify({ error: { code: 'usage_limit_reached', resets_in_seconds: 3600 } }), { status: 429 }));
		assert.match(reset, /try again in ~3600s/);
	}
	// Adding credentials retains legacy storage and supports mixed OAuth/API pools.
	{
		const secrets = new Secrets();
		const r = new ProviderRegistry(secrets);
		await r.oauth.set('openai', session('openai', 'legacy', { accountId: 'acct-a' }));
		await r.oauth.add('openai', session('openai', 'second', { accountId: 'acct-b' }));
		await r.adoptOAuth('openai');
		await r.addApiKey('openai', 'sk-api');
		await r.addApiKey('openai', 'sk-api');
		assert.equal((await r.getAccounts('openai')).length, 3);
		assert.equal(await r.getApiKey('openai'), 'sk-api');
		await r.adoptOAuth('openai');
		assert.equal(await r.getApiKey('openai'), 'second-access');
		assert.equal(chatgptAccountId('second-access'), 'acct-b');
		assert.equal(await r.rotateApiKey('openai', 'second-access', 'HTTP 429 daily quota exceeded'), true);
		assert.equal(await r.getApiKey('openai'), 'sk-api');
		assert.equal(await r.rotateApiKey('openai', 'sk-api'), true);
		assert.equal(await r.getApiKey('openai'), 'legacy-access');
		assert.equal(chatgptAccountId('legacy-access'), 'acct-a');
		assert.equal(await r.rotateApiKey('openai', 'legacy-access'), false);
		await assert.rejects(r.getApiKey('openai'), /cooling down/);
		const safe = JSON.stringify(await r.resolve('openai'));
		for (const secret of ['sk-api', 'second-access', 'legacy-access', 'second-refresh']) {
			assert.ok(!safe.includes(secret), 'config must not contain credentials');
		}
		assert.ok(await secrets.get('stormcoder.oauth.openai'), 'legacy session is preserved');
	}
	// Every saved key is tried once; the first two failures cannot hide a working fifth key.
	{
		const r = new ProviderRegistry(new Secrets());
		await Promise.all(['a', 'b', 'c', 'd', 'e'].map(key => r.addApiKey('mistral', key)));
		assert.equal((await r.getApiKeys('mistral')).length, 5, 'concurrent additions retain all keys');
		const seen = [];
		const result = await withProviderResilience(r, 'mistral', 'model', async key => {
			seen.push(key);
			if (key !== 'd') { throw limited(); }
			return 'ok';
		});
		assert.equal(result, 'ok');
		assert.equal(new Set(seen).size, seen.length);
		assert.deepEqual(seen, ['e', 'a', 'b', 'c', 'd']);
		assert.equal(r.cooldowns.isCoolingDown('mistral', 'model'), false);
		assert.equal((await r.getAccounts('mistral')).filter(a => a.cooldownUntil > Date.now()).length, 4);
		// Success on d does not restore the exhausted accounts.
		r.noteApiKeySuccess('mistral');
		assert.equal(await r.getApiKey('mistral'), 'd');
	}
	// Exhaustion stops, records cooldown, and recovers once the cooldown ends.
	{
		const r = new ProviderRegistry(new Secrets());
		await r.setApiKey('mistral', 'a');
		await r.setExtraApiKeys('mistral', ['a', 'b', 'b', 'c']);
		const seen = [];
		await assert.rejects(withProviderResilience(r, 'mistral', 'model', async key => { seen.push(key); throw limited(); }), /HTTP 429/);
		assert.deepEqual(seen, ['a', 'b', 'c']);
		await assert.rejects(r.getApiKey('mistral'), /cooling down/);
		Date.now = () => originalNow() + 901_000;
		assert.ok(await r.getApiKey('mistral'));
		Date.now = originalNow;
		await r.addApiKey('mistral', 'new-account');
		assert.equal(r.cooldowns.isCoolingDown('mistral', 'model'), false, 'new capacity clears provider/model exhaustion for Auto routing');
		assert.equal(await r.getApiKey('mistral'), 'new-account');
	}
	// Environment keys can fall back to stored keys; they remain non-removable.
	{
		process.env.OPENAI_API_KEY = 'env-key';
		const r = new ProviderRegistry(new Secrets());
		await r.setExtraApiKeys('openai', ['backup-only']);
		assert.equal(await r.hasCredentials('openai'), true);
		assert.equal(await r.getApiKey('openai'), 'env-key');
		await r.removeAccount('openai', (await r.getAccounts('openai'))[0].id);
		assert.equal(await r.getApiKey('openai'), 'env-key');
		assert.equal(await r.rotateApiKey('openai', 'env-key'), true);
		assert.equal(await r.getApiKey('openai'), 'backup-only');
		delete process.env.OPENAI_API_KEY;
	}
	// Concurrent failures park the failed account once; reordering/removing keys does not transfer its cooldown.
	{
		const r = new ProviderRegistry(new Secrets());
		await r.setApiKey('mistral', 'a');
		await r.setExtraApiKeys('mistral', ['b', 'c']);
		const failed = await r.getApiKey('mistral');
		await Promise.all([r.rotateApiKey('mistral', failed), r.rotateApiKey('mistral', failed)]);
		assert.equal(await r.getApiKey('mistral'), 'b');
		const primary = (await r.getAccounts('mistral')).find(a => a.label === 'API key 1');
		await r.removeAccount('mistral', primary.id);
		assert.equal(await r.getApiKey('mistral'), 'b', 'removing primary retains backup-only pool');
		await r.setExtraApiKeys('mistral', ['c', 'b']);
		assert.equal(await r.getApiKey('mistral'), 'b', 'identity survives reordering');
	}
	// Failed refresh removes only that login and automatically selects the next account.
	{
		const r = new ProviderRegistry(new Secrets());
		await r.oauth.set('anthropic', session('anthropic', 'dead', { expires: 0 }));
		await r.oauth.add('anthropic', session('anthropic', 'healthy'));
		globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
		assert.equal(await r.getApiKey('anthropic'), 'healthy-access');
		assert.equal((await r.oauth.accounts('anthropic')).length, 1);
	}
	// Refresh is single-flight per account, not per provider, and preserves account identity.
	{
		const store = new OAuthTokenStore(new Secrets());
		const first = await store.add('openai', session('openai', 'first', { expires: 0, accountId: 'one' }));
		const second = await store.add('openai', session('openai', 'second', { expires: 0, accountId: 'two' }));
		let count = 0;
		globalThis.fetch = async (_url, req) => {
			count++;
			const refresh = JSON.parse(req.body).refresh_token;
			await new Promise(resolve => setTimeout(resolve, 10));
			return new Response(JSON.stringify({ access_token: `${refresh}-new`, refresh_token: `${refresh}-rotated`, expires_in: 3600 }));
		};
		const tokens = await Promise.all([store.getFreshAccessToken('openai', first), store.getFreshAccessToken('openai', first), store.getFreshAccessToken('openai', second)]);
		assert.equal(count, 2);
		assert.equal(tokens[0], tokens[1]);
		assert.equal(chatgptAccountId(tokens[0]), 'one');
		assert.equal(chatgptAccountId(tokens[2]), 'two');
		// Reauthorizing the same account updates rather than duplicates it.
		await store.add('openai', session('openai', 'reauthorized', { accountId: 'two' }));
		assert.equal((await store.accounts('openai')).length, 2);
	}
	// Successful and rejected late refreshes cannot resurrect a removed account.
	for (const status of [200, 400]) {
		const store = new OAuthTokenStore(new Secrets());
		await store.set('anthropic', session('anthropic', 'old', { expires: 0 }));
		let release;
		let began;
		const started = new Promise(resolve => { began = resolve; });
		globalThis.fetch = async () => { began(); await new Promise(resolve => { release = resolve; }); return new Response(JSON.stringify(status === 200 ? { access_token: 'new', refresh_token: 'new-r', expires_in: 3600 } : { error: 'invalid_grant' }), { status }); };
		const refreshing = store.getFreshAccessToken('anthropic');
		await started;
		await store.clear('anthropic');
		release();
		assert.equal(await refreshing, undefined);
		assert.deepEqual(await store.accounts('anthropic'), []);
	}
	// A 401 from an expired, in-flight token refreshes that same account before giving up.
	{
		const r = new ProviderRegistry(new Secrets());
		await r.oauth.set('anthropic', session('anthropic', 'old'));
		assert.equal(await r.getApiKey('anthropic'), 'old-access');
		Date.now = () => originalNow() + 3_700_000;
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'fresh-r', expires_in: 3600 }));
		assert.equal(await r.rotateApiKey('anthropic', 'old-access', 'HTTP 401'), true);
		assert.equal(await r.getApiKey('anthropic'), 'fresh');
		Date.now = originalNow;
	}
	// Stream/cancellation guards prevent replay; a 503 never burns another account.
	for (const [error, retryAllowed] of [[limited(), false], [new Error('HTTP 503'), true]]) {
		const r = new ProviderRegistry(new Secrets());
		await r.setApiKey('mistral', 'a'); await r.addApiKey('mistral', 'b');
		let calls = 0;
		await assert.rejects(withProviderResilience(r, 'mistral', 'model', async () => { calls++; throw error; }, () => retryAllowed));
		assert.equal(calls, 1);
	}
	assert.equal(isKeyFailure('HTTP 402 payment required'), true);
	assert.equal(isKeyFailure('usage_limit_reached'), true);
	assert.equal(isKeyFailure('HTTP 400 invalid tools'), false);
	assert.ok(REMOTE_DENIED.includes('removeAccount'));

	// Claude browser callback: reject forged state, exchange matching PKCE/redirect, keep old login.
	{
		const store = new OAuthTokenStore(new Secrets());
		await store.set('anthropic', session('anthropic', 'existing'));
		let authorize;
		const statuses = [];
		const get = url => new Promise((resolve, reject) => http.get(url, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
		openExternal = async url => {
			authorize = new URL(url);
			const callback = new URL(authorize.searchParams.get('redirect_uri'));
			callback.hostname = '127.0.0.1';
			setTimeout(async () => {
				statuses.push(await get(`${callback}?state=forged&code=bad`));
				statuses.push(await get(`${callback}?state=${authorize.searchParams.get('state')}&code=good`));
			}, 10);
			return true;
		};
		globalThis.fetch = async (_url, req) => {
			const body = JSON.parse(req.body);
			assert.equal(body.code, 'good');
			assert.equal(body.state, authorize.searchParams.get('state'));
			assert.equal(body.redirect_uri, authorize.searchParams.get('redirect_uri'));
			assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
			assert.notEqual(body.code_verifier, body.state);
			return new Response(JSON.stringify({ access_token: 'browser-access', refresh_token: 'browser-refresh', expires_in: 3600 }));
		};
		assert.equal(await signInAnthropic(store, 'browser'), true);
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepEqual(statuses, [400, 200]);
		assert.equal((await store.accounts('anthropic')).length, 2);
		await assert.rejects(get(authorize.searchParams.get('redirect_uri')), { code: 'ECONNREFUSED' });
	}
	// Claude authorization-code choice validates state and masks pasted codes.
	{
		const store = new OAuthTokenStore(new Secrets());
		let state;
		openExternal = async url => { state = new URL(url).searchParams.get('state'); return true; };
		input = async opts => { assert.equal(opts.password, true); return `manual#${state}`; };
		globalThis.fetch = async (_url, req) => { assert.equal(JSON.parse(req.body).code, 'manual'); return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })); };
		assert.equal(await signInAnthropic(store, 'code'), true);
		input = async () => 'code#wrong-state';
		await assert.rejects(signInAnthropic(store, 'code'), /different sign-in attempt/);
		input = async () => undefined;
		assert.equal(await signInAnthropic(store, 'code'), false);
		openExternal = async () => false;
		await assert.rejects(signInAnthropic(store, 'browser'), /Could not open/);
		openExternal = async () => { throw new Error('browser unavailable'); };
		await assert.rejects(signInAnthropic(store, 'browser'), /Could not open/);
		onProgress = cancel => queueMicrotask(cancel);
		openExternal = async () => true;
		assert.equal(await signInAnthropic(store, 'browser'), false);
		onProgress = () => {};
	}
	console.log('All multi-account and Claude authorization assertions passed.');
} finally {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
	Module._load = originalLoad;
	if (previousEnv === undefined) { delete process.env.OPENAI_API_KEY; } else { process.env.OPENAI_API_KEY = previousEnv; }
}
