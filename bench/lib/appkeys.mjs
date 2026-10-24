// Reusing the keys and provider settings a user already saved in the Stormcoder app.
//
// The app encrypts keys with the OS keychain (or a key file), which only Electron can open, so the
// benchmark runs its engine under Electron against a private COPY of the app's data. The copy is
// deliberately narrower than the original:
//   - API-key secrets are kept, still encrypted; nothing is ever decrypted to disk by this code.
//   - Sign-in sessions (`stormcoder.oauth.*`) are dropped. Refreshing a copied token can rotate the
//     refresh token and silently sign the real app out.
//   - Only provider settings (default provider, models, base URLs) are kept. MCP servers, hooks,
//     rules and the like would start processes or change results, and are not what is measured.
// The original files are only read, and the copy is deleted when the run ends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_KEY = 'stormcoder.apiKey.';
const OAUTH_KEY = 'stormcoder.oauth.';
const KEPT_SETTING = /^stormcoder\.(defaultProvider|maxTokens|(?!completions\.|persona\.)[a-z0-9_-]+\.(model|baseUrl|thinking|accountId))$/i;

/** Where the packaged app keeps its data on this machine. */
export function defaultAppData(platform = process.platform, env = process.env, home = os.homedir()) {
	if (platform === 'darwin') { return path.join(home, 'Library', 'Application Support', 'Stormcoder'); }
	if (platform === 'win32') { return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Stormcoder'); }
	return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Stormcoder');
}

/** App data saved before the rename uses `openvsChat.` names; the engine migrates them, and so does this reading. */
const normalizeName = name => name.startsWith('openvsChat.') ? `stormcoder.${name.slice('openvsChat.'.length)}` : name;

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * What the app has saved, from names alone (secret names are stored in the clear; their values
 * are not read). Returns undefined when there is no usable app data.
 */
export function inspectApp(dir) {
	if (!dir || !fs.existsSync(dir)) { return undefined; }
	const secrets = readJson(path.join(dir, 'secrets.json')) ?? {};
	const settings = Object.fromEntries(Object.entries(readJson(path.join(dir, 'settings.json')) ?? {}).map(([k, v]) => [normalizeName(k), v]));
	const names = Object.keys(secrets).map(normalizeName);
	const apiKeys = names.filter(n => n.startsWith(API_KEY)).map(n => n.slice(API_KEY.length));
	const signedIn = names.filter(n => n.startsWith(OAUTH_KEY)).map(n => n.slice(OAUTH_KEY.length)).filter(id => !apiKeys.includes(id));
	return { dir, apiKeys, signedIn, defaultProvider: settings['stormcoder.defaultProvider'], settings, hasKeyFile: fs.existsSync(path.join(dir, 'secret.key')) };
}

/** The model the user has configured for `provider`, if any. */
export function configuredModel(app, provider) {
	return app?.settings?.[`stormcoder.${provider}.model`];
}

/**
 * Builds the private data folder the benchmark's engine runs on: sanitized copies of the app's
 * secrets and settings, with `overrides` on top. Returns the folder and a function that removes it.
 */
export function prepareDataCopy(app, overrides) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-appdata-'));
	const secrets = readJson(path.join(app.dir, 'secrets.json')) ?? {};
	const kept = Object.fromEntries(Object.entries(secrets).filter(([name]) => !normalizeName(name).startsWith(OAUTH_KEY)));
	fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(kept), { mode: 0o600 });
	if (app.hasKeyFile) { fs.copyFileSync(path.join(app.dir, 'secret.key'), path.join(dir, 'secret.key')); fs.chmodSync(path.join(dir, 'secret.key'), 0o600); }
	const settings = Object.fromEntries(Object.entries(app.settings).filter(([k]) => KEPT_SETTING.test(k)));
	// An override left undefined (no --base-url given) must not erase the user's own value.
	const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...settings, ...defined }));
	return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
