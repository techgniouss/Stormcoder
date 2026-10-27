/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebAuthManager } from './auth';
import { RoleRouter } from './auto/router';
import { ChatViewProvider, InlineKind } from './chatViewProvider';
import { cancelDraftCommitMessage, draftCommitMessage, generateCommitMessage } from './git/commitMessage';
import { McpManager, isMissingFile, promptingConsent, rememberProjectConsent } from './mcp/manager';
import { loadEnvFile } from './oauth';
import { ProviderRegistry } from './providers/registry';
import { setStreamIdleTimeout } from './providers/types';
import { getRelayUrl, isRemoteEnabled } from './remote/config';
import { ensureCloudflared, getRelayMode, TUNNEL_TOKEN_KEY } from './remote/local/localHosting';
import { deployRelay } from './remote/deploy';
import { RemoteService } from './remote/remoteService';
import { SkillRegistry } from './skills';

/**
 * Providers only use `fetch`, so the stream stall timeout is pushed in from here and
 * kept in step with the setting.
 */
function applyStreamIdleTimeout(): void {
	const ms = vscode.workspace.getConfiguration('stormcoder').get<number>('stream.idleTimeoutMs');
	if (typeof ms === 'number') {
		setStreamIdleTimeout(ms);
	}
}

/**
 * The active {@link ChatViewProvider}, held at module scope only so {@link deactivate} can
 * reach it — `activate` otherwise keeps every other collaborator as a local, wired together
 * once and never referenced again outside the closures registered on `context.subscriptions`.
 */
let activeViewProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	loadEnvFile(context.extensionPath);
	applyStreamIdleTimeout();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('stormcoder.stream.idleTimeoutMs')) {
			applyStreamIdleTimeout();
		}
	}));
	const registry = new ProviderRegistry(context.secrets);
	const router = new RoleRouter(registry);
	const auth = new WebAuthManager(registry);
	const mcp = new McpManager(promptingConsent(context.workspaceState));
	const viewProvider = new ChatViewProvider(context, registry, auth, mcp);
	activeViewProvider = viewProvider;
	context.subscriptions.push(mcp);
	const remoteService = new RemoteService(context, viewProvider);
	context.subscriptions.push(remoteService);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerUriHandler(auth),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('stormcoder.focus', () =>
			vscode.commands.executeCommand('stormcoder.view.focus')),
		vscode.commands.registerCommand('stormcoder.newChat', () => viewProvider.newChat()),
		vscode.commands.registerCommand('stormcoder.openSettings', () => viewProvider.openSettingsWindow()),
		vscode.commands.registerCommand('stormcoder.selectProvider', () => selectProvider(registry, viewProvider)),
		vscode.commands.registerCommand('stormcoder.configureProvider', (presetId?: string) =>
			configureProvider(registry, viewProvider, presetId)),
		vscode.commands.registerCommand('stormcoder.signIn', (presetId?: string) =>
			signIn(registry, viewProvider, presetId)),
		vscode.commands.registerCommand('stormcoder.clearKey', () => clearKey(registry, viewProvider)),
		vscode.commands.registerCommand('stormcoder.mcpReconnect', async () => {
			mcp.reconnect();
			await mcp.ensureStarted();
			vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
		}),
		vscode.commands.registerCommand('stormcoder.mcpStatus', async () => {
			await mcp.ensureStarted();
			vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
		}),
		vscode.commands.registerCommand('stormcoder.selectSkill', () => selectSkill(viewProvider, context.extensionUri)),
		vscode.commands.registerCommand('stormcoder.createSkill', () => createSkill(viewProvider)),
		vscode.commands.registerCommand('stormcoder.mcpAdd', () => mcpAdd(mcp, context.workspaceState)),
		vscode.commands.registerCommand('stormcoder.mcpOpenConfig', () => mcpOpenConfig()),
		vscode.commands.registerCommand('stormcoder.remoteEnable', (options?: { quiet?: boolean }) => remoteEnable(remoteService, options?.quiet === true)),
		vscode.commands.registerCommand('stormcoder.remoteInstallCloudflared', () => remoteInstallCloudflared(context)),
		vscode.commands.registerCommand('stormcoder.remoteSetTunnel', () => remoteSetTunnel(context)),
		vscode.commands.registerCommand('stormcoder.remoteStatus', () => remoteStatus(remoteService)),
		vscode.commands.registerCommand('stormcoder.remoteDeployRelay', () => remoteDeployRelay(context, registry)),
		vscode.commands.registerCommand('stormcoder.generateCommitMessage', () => {
			const cts = new vscode.CancellationTokenSource();
			return generateCommitMessage(registry, cts.token).finally(() => cts.dispose());
		}),
		// Used by the Changes view; not in the manifest because they are not user commands.
		vscode.commands.registerCommand('stormcoder.git.draftMessage', (cwd: string) => draftCommitMessage(registry, cwd)),
		vscode.commands.registerCommand('stormcoder.git.cancelDraft', () => cancelDraftCommitMessage()),
	);

	// Covers every path that can reach the misconfigured state, not just this activation's
	// starting settings: the Settings UI (or a hand edit of settings.json) can flip
	// `remote.enabled` on, or clear `relayUrl`, without ever going through `remoteEnable()`.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (['enabled', 'relayUrl', 'relayMode'].some(key => e.affectsConfiguration(`stormcoder.remote.${key}`))) {
			void warnIfRemoteMisconfigured(context);
		}
	}));
	void warnIfRemoteMisconfigured(context);
}

/**
 * `globalState` key recording that the user dismissed the nudge below via "Don't Ask Again".
 * `remote.enabled` is written at `ConfigurationTarget.Global` (see `remoteEnable`), so it's the
 * same everywhere — without this flag the nudge would re-fire on every window's activation until
 * the user deploys a relay, even for someone who's already seen it and is getting to it later.
 * Cleared as soon as the misconfiguration itself resolves (relay deployed, or remote disabled),
 * so a *future* re-enable-without-relay prompts fresh rather than staying silenced forever from
 * one old dismissal.
 */
const REMOTE_DEPLOY_NUDGE_DISMISSED_KEY = 'stormcoder.remote.deployNudgeDismissed';

/**
 * Nudges the user to finish relay setup when `remote.enabled` is on but `relayUrl` is still
 * empty — e.g. a settings sync/import, or the setting flipped by hand — without ever going
 * through {@link remoteEnable}'s prompt. `RemoteService.status()` already reports this case, but
 * nothing surfaced it: the host would sit silently unpaired until the user thought to run
 * "Remote: Status". Gives the same one-click "Deploy Your Own Relay"
 * `remoteEnable()` gives on first ask. Called at activation and on every relevant config change
 * — see the `onDidChangeConfiguration` listener in {@link activate}.
 *
 * Skipped in a folderless window: remote pairing is workspace-keyed (`getWorkspaceKey()`
 * in `remote/config.ts`), so a window with nothing to pair has nothing this nudge would unblock.
 */
async function warnIfRemoteMisconfigured(context: vscode.ExtensionContext): Promise<void> {
	// Local hosting needs no relay URL — only an explicit "hosted" choice with none set is broken.
	if (!isRemoteEnabled() || getRelayMode() === 'local' || getRelayUrl()) {
		// Resolved, or no longer enabled — reset so a later re-enable-without-relay nudges again.
		await context.globalState.update(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY, false);
		return;
	}
	if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
		return;
	}
	if (context.globalState.get<boolean>(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY)) {
		return;
	}
	const action = await vscode.window.showWarningMessage(
		'Stormcoder remote control is enabled, but no relay is deployed yet — pairing won\'t work until you do. '
		+ 'Run "Remote: Deploy Your Own Relay" to do that in one step.',
		'Deploy Your Own Relay', 'Don\'t Ask Again');
	if (action === 'Deploy Your Own Relay') {
		await vscode.commands.executeCommand('stormcoder.remoteDeployRelay');
	} else if (action === 'Don\'t Ask Again') {
		await context.globalState.update(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY, true);
	}
}

export function deactivate(): void {
	// Settles every prompt still waiting for a reply — the one place that is allowed to
	// happen unconditionally; see PromptRegistry.settleAllUnanswered's doc for why a reload
	// must not do this.
	activeViewProvider?.dispose();
	activeViewProvider = undefined;
}

async function pickProvider(registry: ProviderRegistry, placeHolder: string): Promise<string | undefined> {
	const configs = await registry.resolveAll();
	const picked = await vscode.window.showQuickPick(
		configs.map(c => ({
			label: c.label,
			description: c.hasApiKey ? '$(key) key set' : (c.requiresApiKey ? '$(warning) no key' : 'no key needed'),
			detail: `Model: ${c.model}`,
			id: c.id,
		})),
		{ placeHolder, matchOnDetail: true },
	);
	return picked?.id;
}

async function selectProvider(registry: ProviderRegistry, view: ChatViewProvider): Promise<void> {
	const id = await pickProvider(registry, 'Select the AI provider to chat with');
	if (!id) {
		return;
	}
	await vscode.workspace.getConfiguration('stormcoder').update(
		'defaultProvider', id, vscode.ConfigurationTarget.Global);
	view.selectProvider(id);
	await view.refreshConfig();
}

/**
 * Placeholder shown in the API-key input box, per provider. A recognizable prefix is the
 * quickest way for someone to tell they are about to paste the wrong vendor's key; the
 * providers whose credentials carry no prefix say what is wanted in words instead, rather
 * than inheriting a misleading `sk-...`.
 */
const KEY_PLACEHOLDERS: Record<string, string | undefined> = {
	nvidia: 'nvapi-...',
	anthropic: 'sk-ant-...',
	gemini: 'AIza...',
	openrouter: 'sk-or-v1-...',
	groq: 'gsk_...',
	mistral: 'Your Mistral API key',
	cloudflare: 'Cloudflare API token with the Workers AI permission',
};

async function configureProvider(
	registry: ProviderRegistry, view: ChatViewProvider, presetId?: string,
): Promise<void> {
	const id = presetId ?? await pickProvider(registry, 'Which provider do you want to configure?');
	if (!id) {
		return;
	}
	const provider = registry.getProvider(id);
	if (!provider) {
		return;
	}
	const key = await vscode.window.showInputBox({
		title: `${provider.info.label} API key`,
		prompt: `Paste your API key (stored in the OS secret store). Get one at ${provider.info.apiKeyUrl}`,
		password: true,
		ignoreFocusOut: true,
		placeHolder: KEY_PLACEHOLDERS[id] ?? 'sk-...',
	});
	if (!key) {
		return;
	}
	await registry.addApiKey(id, key.trim());
	vscode.window.showInformationMessage(`Saved the API key for ${provider.info.label}.`);
	await view.credentialsChanged(id);
}

/**
 * Delegates to `ChatViewProvider.handleSignIn` — the one implementation of "sign in to a
 * provider" (device-flow OAuth, Kiro's credential import, the redirect-URI/native web flow,
 * or a paste-a-key prompt), shared with the webview panel's own "Sign in" button so the
 * Command Palette entry point never falls behind it again.
 */
async function signIn(registry: ProviderRegistry, view: ChatViewProvider, presetId?: string): Promise<void> {
	const id = presetId ?? await pickProvider(registry, 'Sign in to which provider?');
	if (!id) {
		return;
	}
	await view.handleSignIn(id);
}

async function selectSkill(view: ChatViewProvider, extensionUri: vscode.Uri): Promise<void> {
	const skills = await new SkillRegistry(extensionUri).list();
	const active = view.activeSkillIds();
	const picked = await vscode.window.showQuickPick(
		skills.map(s => ({ label: s.name, description: s.description, id: s.id, picked: active.includes(s.id) })),
		{ placeHolder: 'Activate skills (their instructions steer every message)', canPickMany: true },
	);
	if (picked) {
		await view.setActiveSkills(picked.map(p => p.id));
		await vscode.commands.executeCommand('stormcoder.view.focus');
	}
}

/**
 * Guided skill creation: asks for an id/name/description, writes a Markdown scaffold
 * to `.stormcoder/skills/<id>.md` in the workspace, and opens it for editing. The skill
 * shows up in the picker immediately (the registry re-reads the folder on each list).
 */
async function createSkill(view: ChatViewProvider): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		vscode.window.showWarningMessage('Open a folder first — workspace skills live in .stormcoder/skills/. (You can also define global skills via the "stormcoder.skills" setting.)');
		return;
	}
	const id = await vscode.window.showInputBox({
		title: 'New skill (1/3): id',
		prompt: 'Short identifier, used as the file name and in /skill <id>',
		placeHolder: 'e.g. api-reviewer',
		ignoreFocusOut: true,
		validateInput: v => /^[a-z0-9][a-z0-9-_]*$/.test(v) ? undefined : 'Use lowercase letters, digits, - or _ (must start with a letter or digit).',
	});
	if (!id) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: 'New skill (2/3): display name',
		value: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
		ignoreFocusOut: true,
	});
	if (name === undefined) {
		return;
	}
	const description = await vscode.window.showInputBox({
		title: 'New skill (3/3): one-line description',
		placeHolder: 'What does this skill make the assistant do?',
		ignoreFocusOut: true,
	});
	if (description === undefined) {
		return;
	}

	const file = vscode.Uri.joinPath(root, '.stormcoder', 'skills', `${id}.md`);
	try {
		await vscode.workspace.fs.stat(file);
		const overwrite = await vscode.window.showWarningMessage(
			`A skill file for "${id}" already exists. Overwrite it?`, { modal: true }, 'Overwrite');
		if (overwrite !== 'Overwrite') {
			return;
		}
	} catch {
		// Doesn't exist yet — the normal path.
	}
	const scaffold = [
		`# ${name || id}`,
		'',
		`> ${description || 'Describe what this skill does.'}`,
		'',
		'## Instructions',
		'',
		'Write the instructions the assistant should follow while this skill is active.',
		'Be specific: conventions to apply, steps to take, tone, what to avoid.',
		'',
	].join('\n');
	await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(scaffold));
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	vscode.window.showInformationMessage(`Skill "${id}" created. Edit the instructions, then activate it with /skill ${id} in the chat.`);
	await view.refreshConfig();
}

/**
 * Guided MCP server registration: asks where to store it (project file or global
 * settings), the server id and the launch command, then reconnects so its tools are
 * available to the agent right away.
 */
async function mcpAdd(mcp: McpManager, workspaceState: vscode.Memento): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const target = await vscode.window.showQuickPick(
		[
			...(root ? [{ label: '$(root-folder) This project', description: '.stormcoder/mcp.json (checked into the repo if you commit it)', id: 'project' }] : []),
			{ label: '$(globe) Global', description: 'stormcoder.mcp.servers user setting (all projects)', id: 'global' },
		],
		{ placeHolder: 'Where should this MCP server be configured?' },
	);
	if (!target) {
		return;
	}
	// A hosted server is configured by URL alone, which is most of why anyone reaches for
	// one; asking for a launch command first and only accepting stdio made that whole class
	// of server unreachable from the UI.
	const kind = await vscode.window.showQuickPick(
		[
			{ label: '$(cloud) Remote server', description: 'A hosted MCP server you connect to by URL', id: 'url' },
			{ label: '$(terminal) Local server', description: 'A command this machine runs (stdio)', id: 'stdio' },
		],
		{ placeHolder: 'What kind of MCP server is this?' },
	);
	if (!kind) {
		return;
	}
	const id = await vscode.window.showInputBox({
		title: 'MCP server (1/2): id',
		prompt: 'Short name; the agent sees tools as mcp__<id>__<tool>',
		placeHolder: 'e.g. github',
		ignoreFocusOut: true,
		validateInput: v => /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(v) ? undefined : 'Use letters, digits, - or _.',
	});
	if (!id) {
		return;
	}
	let entry: Record<string, unknown>;
	if (kind.id === 'url') {
		const url = await vscode.window.showInputBox({
			title: 'MCP server (2/2): URL',
			prompt: 'The server\'s endpoint. Add an Authorization header afterwards in the config if it needs a token.',
			placeHolder: 'e.g. https://mcp.example.com/mcp',
			ignoreFocusOut: true,
			validateInput: v => /^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter an http:// or https:// URL.',
		});
		if (!url?.trim()) {
			return;
		}
		entry = { url: url.trim() };
	} else {
		const commandLine = await vscode.window.showInputBox({
			title: 'MCP server (2/2): launch command',
			prompt: 'The stdio command to start the server (arguments separated by spaces)',
			placeHolder: 'e.g. npx -y @modelcontextprotocol/server-github',
			ignoreFocusOut: true,
		});
		if (!commandLine?.trim()) {
			return;
		}
		const [command, ...args] = commandLine.trim().split(/\s+/);
		entry = { command, ...(args.length ? { args } : {}) };
	}

	if (target.id === 'project' && root) {
		const file = vscode.Uri.joinPath(root, '.stormcoder', 'mcp.json');
		let config: { servers: Record<string, unknown> } = { servers: {} };
		let raw: string | undefined;
		try {
			raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
		} catch (err) {
			if (!isMissingFile(err)) {
				vscode.window.showErrorMessage(`MCP: could not read ${file.fsPath} (${err instanceof Error ? err.message : String(err)}); nothing was changed.`);
				return;
			}
			// New file.
		}
		if (raw !== undefined) {
			// An existing file that does not parse is the user's work in progress: refuse to
			// overwrite it (which would silently drop every server already in it).
			let existing: any;
			try {
				existing = JSON.parse(raw);
			} catch (err) {
				vscode.window.showErrorMessage(`MCP: ${file.fsPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it first. Nothing was changed.`);
				return;
			}
			// Accept both wrapped and bare formats; keep whatever map we find.
			const servers = existing && typeof existing === 'object' && !Array.isArray(existing)
				? (existing.servers ?? existing.mcpServers ?? existing)
				: undefined;
			if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
				vscode.window.showErrorMessage(`MCP: ${file.fsPath} does not hold a map of servers; fix it first. Nothing was changed.`);
				return;
			}
			config = existing.servers ? existing : { servers };
		}
		config.servers[id] = entry;
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(config, null, '\t') + '\n'));
		// Added by the user, here and now: not a repository's server to ask them about.
		await rememberProjectConsent(workspaceState, id, JSON.parse(JSON.stringify(entry)));
	} else {
		const cfg = vscode.workspace.getConfiguration('stormcoder');
		const servers = { ...(cfg.get<Record<string, unknown>>('mcp.servers') ?? {}) };
		servers[id] = entry;
		await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global);
	}

	mcp.reconnect();
	await mcp.ensureStarted();
	vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
}

/** Opens (creating if needed) the project's `.stormcoder/mcp.json`. */
async function mcpOpenConfig(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		vscode.window.showWarningMessage('Open a folder first — the project MCP config lives in .stormcoder/mcp.json. (Global servers live in the "stormcoder.mcp.servers" setting.)');
		return;
	}
	const file = vscode.Uri.joinPath(root, '.stormcoder', 'mcp.json');
	try {
		await vscode.workspace.fs.stat(file);
	} catch {
		const scaffold = { servers: { 'example-disabled': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], disabled: true } } };
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(scaffold, null, '\t') + '\n'));
	}
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

/**
 * `stormcoder.remoteEnable`: flips `stormcoder.remote.enabled` on, or — if no relay URL is
 * configured yet — explains what's missing instead. There is no default relay; the user
 * deploys their own via `wrangler deploy` first.
 */
async function remoteEnable(remoteService: RemoteService, quiet = false): Promise<void> {
	if (getRelayMode() === 'local') {
		// The user asked for remote: local hosting may install cloudflared without asking again.
		remoteService.enableRequested();
		await vscode.workspace.getConfiguration('stormcoder').update('remote.enabled', true, vscode.ConfigurationTarget.Global);
		// `quiet`: turned on from the Settings panel's own switch, which is already showing
		// where to pair — the "Pair a Device" nudge would only point back at it.
		if (quiet) {
			return;
		}
		const choice = await vscode.window.showInformationMessage(
			'Stormcoder remote control is on. Stormcoder runs the relay on this machine and reaches your phone through Cloudflare Tunnel — pair a device from Settings → Remote control.',
			'Pair a Device');
		if (choice) {
			await vscode.commands.executeCommand('stormcoder.openSettings');
		}
		return;
	}
	if (!getRelayUrl()) {
		const action = await vscode.window.showWarningMessage(
			'Remote relay mode is set to "hosted", but no relay URL is set. Set "stormcoder.remote.relayMode" to "auto" to have Stormcoder host the relay on this computer, '
			+ 'or run "Remote: Deploy Your Own Relay" to deploy one to Cloudflare.',
			'Deploy Your Own Relay');
		if (action) {
			await vscode.commands.executeCommand('stormcoder.remoteDeployRelay');
		}
		return;
	}
	await vscode.workspace.getConfiguration('stormcoder').update('remote.enabled', true, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(
		'Stormcoder remote control is enabled. Open ⚙ Providers & settings → Remote control to pair a device.');
}

/**
 * `stormcoder.remoteInstallCloudflared`: installs Cloudflare's official `cloudflared` into this
 * extension's storage (or reports the one already on the machine) — the manual path to what
 * local hosting otherwise does on its own the first time remote is turned on.
 */
async function remoteInstallCloudflared(context: vscode.ExtensionContext): Promise<void> {
	const binary = await ensureCloudflared(context, false);
	if (binary) {
		vscode.window.showInformationMessage(`Cloudflare Tunnel is ready: ${binary}`);
	}
}

/**
 * `stormcoder.remoteSetTunnel`: switches local hosting from a quick tunnel (a random address
 * that changes on every restart, so phones re-pair) to the user's own named tunnel, whose
 * hostname never changes. Takes the hostname and the tunnel's connector token from the
 * Cloudflare dashboard (Zero Trust → Networks → Tunnels → the tunnel's install command); the
 * token goes to SecretStorage, never settings. An empty hostname goes back to a quick tunnel.
 */
async function remoteSetTunnel(context: vscode.ExtensionContext): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('stormcoder');
	const hostname = await vscode.window.showInputBox({
		title: 'Use My Cloudflare Tunnel (1/2)',
		prompt: 'Public hostname of your named tunnel, routed to http://localhost:8787 (or your "stormcoder.remote.localPort"). Leave empty to go back to a quick tunnel.',
		placeHolder: 'remote.example.com',
		value: cfg.get<string>('remote.tunnelHostname') ?? '',
		ignoreFocusOut: true,
	});
	if (hostname === undefined) {
		return;
	}
	const clean = hostname.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
	if (!clean) {
		await context.secrets.delete(TUNNEL_TOKEN_KEY);
		await cfg.update('remote.tunnelHostname', '', vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage('Stormcoder Remote is back on a quick tunnel.');
		return;
	}
	const token = await vscode.window.showInputBox({
		title: 'Use My Cloudflare Tunnel (2/2)',
		prompt: 'Your tunnel connector token: the long value after "--token" in the install command the dashboard shows.',
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.trim().length > 20 ? undefined : 'Paste the full tunnel token.',
	});
	if (!token) {
		return;
	}
	await context.secrets.store(TUNNEL_TOKEN_KEY, token.trim());
	// Written last: this change is what restarts local hosting, and it must find the token.
	await cfg.update('remote.tunnelHostname', clean, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Stormcoder Remote will use https://${clean}. Pair your phone once more; after that the address never changes.`);
}

/**
 * `stormcoder.remoteStatus`: shows the current connection state (disabled / connecting / connected / …).
 * The in-panel status indicator (`media/pairing.js`, in Settings → Remote control) shows this
 * live; this command remains as a keyboard-only / Command Palette alternative.
 */
function remoteStatus(remoteService: RemoteService): void {
	vscode.window.showInformationMessage(`Stormcoder remote control: ${remoteService.status()}.`);
}

/**
 * Where the relay package can actually be run from. In a packaged build the bundled copy sits
 * inside `app.asar`, which a child process cannot use as a working directory, so it is mapped to
 * the `app.asar.unpacked` mirror (see `asarUnpack`). If that location is not writable (a
 * read-only AppImage or a system-wide install), `npm install` could not create `node_modules`
 * there, so the package is copied into the user's storage directory and run from the copy.
 * Returns `undefined` when the package cannot be found or copied.
 */
function writableRelayDir(bundled: string, storageDir: string): string | undefined {
	const unpacked = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
	if (!fs.existsSync(unpacked)) {
		return undefined;
	}
	try {
		fs.accessSync(unpacked, fs.constants.W_OK);
		return unpacked;
	} catch {
		// read-only install: fall through to the copy
	}
	const copy = path.join(storageDir, 'openvs-relay');
	try {
		fs.cpSync(unpacked, copy, { recursive: true, force: true });
		return copy;
	} catch {
		return undefined;
	}
}

/**
 * `stormcoder.remoteDeployRelay`: turns the manual "deploy your own relay" steps this
 * extension has always required (see `remoteEnable`'s warning) into one click — installs
 * `openvs-relay/`'s dependencies if needed, mints and uploads a `RELAY_PEPPER` secret, runs
 * `wrangler deploy`, and saves the resulting URL into `stormcoder.remote.relayUrl`. Only works
 * from a full source checkout: `openvs-relay/` is a sibling of `extensions/` in this repo, not
 * something a normally-installed extension carries with it — this extension ships built-in
 * only (a packaged VSIX is refused, see `chatViewProvider.ts`'s `search_files` doc), so anyone
 * running it at all is, by construction, running it from a checkout of this monorepo.
 *
 * Authenticates `wrangler` non-interactively via `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
 * rather than the `wrangler login` browser flow — reusing the exact credential the Cloudflare
 * Workers AI *chat provider* already asks for (`registry.getApiKey('cloudflare')`, the same
 * secret `ENV_VARS.cloudflare = 'CLOUDFLARE_API_TOKEN'` names in `providers/registry.ts`, plus
 * `stormcoder.cloudflare.accountId`). One Cloudflare credential serves both features instead of
 * this command inventing a second, parallel place to paste the same token. When either half is
 * missing this refuses up front with a pointer to where to add it, rather than letting
 * `wrangler` fail deep into the pipeline with a login prompt that has nothing to attach to in a
 * non-interactive spawn.
 */
async function remoteDeployRelay(context: vscode.ExtensionContext, registry: ProviderRegistry): Promise<void> {
	const relayDir = writableRelayDir(vscode.Uri.joinPath(context.extensionUri, 'openvs-relay').fsPath, context.globalStorageUri.fsPath);
	if (!relayDir || !fs.existsSync(relayDir)) {
		vscode.window.showErrorMessage(
			'Could not find the bundled openvs-relay/ — the relay package is missing from this installation. '
			+ 'From a checkout: cd openvs-relay && npm install && npx wrangler deploy, then paste the printed URL into "stormcoder.remote.relayUrl".');
		return;
	}

	const cloudflareToken = await registry.getApiKey('cloudflare');
	const cloudflareAccountId = vscode.workspace.getConfiguration('stormcoder').get<string>('cloudflare.accountId')?.trim();
	if (!cloudflareToken || !cloudflareAccountId) {
		const missing = !cloudflareToken && !cloudflareAccountId ? 'API token and Account ID'
			: !cloudflareToken ? 'API token' : 'Account ID';
		const action = await vscode.window.showWarningMessage(
			`Deploying your own relay needs a Cloudflare ${missing} first — add ${missing === 'API token and Account ID' ? 'both' : 'it'} `
			+ 'under ⚙ Providers & settings → Providers → Cloudflare, then retry this command.',
			'Open Settings');
		if (action) {
			await vscode.commands.executeCommand('stormcoder.openSettings');
		}
		return;
	}

	const channel = vscode.window.createOutputChannel('Stormcoder: Deploy Relay');
	channel.show(true);
	channel.appendLine(`Deploying your own Stormcoder relay from ${relayDir} …`);

	const skipInstall = fs.existsSync(path.join(relayDir, 'node_modules'));
	// `withProgress`'s CancellationToken has no native relationship to `deployRelay`'s
	// AbortSignal (it predates AbortController in the vscode API) — bridged by hand so Cancel
	// actually kills the in-flight `npm`/`wrangler` process instead of merely hiding the
	// notification while the deploy keeps running unattended.
	const controller = new AbortController();
	let cancelled = false;
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Deploying Stormcoder relay…', cancellable: true },
		(_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; controller.abort(); });
			return deployRelay({
				relayDir,
				skipInstall,
				env: { CLOUDFLARE_API_TOKEN: cloudflareToken, CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId },
				signal: controller.signal,
			});
		},
	);
	channel.appendLine(result.output);

	if (!result.ok || !result.url) {
		if (cancelled) {
			channel.appendLine('\n[Cancelled by user]');
			vscode.window.showInformationMessage('Relay deploy cancelled.');
			return;
		}
		channel.appendLine(`\n[FAILED at step: ${result.step ?? 'unknown'}]`);
		const stepHint = result.step === 'install' ? 'npm install failed — check your network connection and retry.'
			: result.step === 'secret' ? 'Check that the Cloudflare API token under ⚙ Providers & settings → Providers → Cloudflare has "Edit Cloudflare Workers" permission, then retry.'
			: 'wrangler deploy failed, or its output did not contain a *.workers.dev URL — see the output for the real reason.';
		const action = await vscode.window.showErrorMessage(`Relay deploy failed. ${stepHint}`, 'Show Output');
		if (action) {
			channel.show();
		}
		return;
	}

	const existingRelayUrl = getRelayUrl();
	if (existingRelayUrl && existingRelayUrl !== result.url) {
		const decision = await vscode.window.showWarningMessage(
			`stormcoder.remote.relayUrl is already set to ${existingRelayUrl}. Replace it with the newly deployed ${result.url}?`,
			'Replace', 'Keep Existing');
		if (decision !== 'Replace') {
			channel.appendLine(`\nDeployed to ${result.url}, but kept the existing relayUrl (${existingRelayUrl}) — update it yourself if you want to switch.`);
			return;
		}
	}

	await vscode.workspace.getConfiguration('stormcoder').update('remote.relayUrl', result.url, vscode.ConfigurationTarget.Global);
	channel.appendLine(`\nRelay deployed: ${result.url}`);
	channel.appendLine('Note: push notifications need VAPID_PUBLIC/VAPID_PRIVATE/VAPID_SUBJECT secrets set separately (see openvs-relay/wrangler.jsonc) — remote control itself works without them.');

	const choice = await vscode.window.showInformationMessage(
		`Stormcoder relay deployed at ${result.url}. Enable remote control now?`, 'Enable Remote Control');
	if (choice) {
		await vscode.commands.executeCommand('stormcoder.remoteEnable');
	}
}

async function clearKey(registry: ProviderRegistry, view: ChatViewProvider): Promise<void> {
	const id = await pickProvider(registry, 'Clear the stored API key for which provider?');
	if (!id) {
		return;
	}
	await registry.clearApiKey(id);
	vscode.window.showInformationMessage(`Cleared the API key for ${registry.getProvider(id)?.info.label ?? id}.`);
	await view.credentialsChanged(id);
}
