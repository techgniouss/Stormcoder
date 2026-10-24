// End-to-end for REMOTE CONTROL: the real engine (dev host) with remote control switched on in
// Settings, the real local relay, and the real phone app (the PWA) in a phone-sized Chromium
// context, against a mock OpenAI-compatible model.
//
// The only stand-in is the Cloudflare tunnel: there is no internet here, so `cloudflaredPath`
// points at a fake `cloudflared` that prints a quick-tunnel address and says it registered. The
// phone reaches the local relay through a small TCP proxy we can cut and restore, which is how
// the "socket drops" cases are exercised for real (the relay, host and phone all see a dead link).
//
// Covers: pairing by typing the code, a streamed Ask reply, an Agent run that writes a file (tool
// card, approval card allow and deny), ask_user, steer and Stop, new/switch/close chats, allowed
// and refused slash commands, desktop-only messages refused when a phone sends them, reconnect
// mid-stream with the transcript intact, secrets redacted on the wire, and revoking the device.
import { launchChromium } from './browser.mjs';
import { startHost, startMock } from './harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const step = name => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`);

/** Polls `fn` until it returns something truthy, or fails with `what`. */
async function until(what, fn, timeout = 15000) {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value) { return value; }
		if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
		await sleep(100);
	}
}

/** A free loopback port. */
async function freePort() {
	return new Promise(resolve => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
	});
}

/** A TCP proxy to `target` whose connections can all be cut (`cut`) and the listener closed and reopened (`down`/`up`). */
async function startProxy(target) {
	const port = await freePort();
	const conns = new Set();
	const onConn = client => {
		const upstream = net.connect(target, '127.0.0.1');
		conns.add(client); conns.add(upstream);
		const end = () => { client.destroy(); upstream.destroy(); conns.delete(client); conns.delete(upstream); };
		client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
		client.pipe(upstream); upstream.pipe(client);
	};
	let server;
	const up = () => new Promise(resolve => { server = net.createServer(onConn); server.listen(port, '127.0.0.1', resolve); });
	await up();
	return {
		port,
		cut: () => { for (const c of conns) { c.destroy(); } conns.clear(); },
		down: () => { server.close(); server = undefined; for (const c of conns) { c.destroy(); } conns.clear(); },
		up,
		close: () => { server?.close(); for (const c of conns) { c.destroy(); } },
	};
}

// ---- Mock model -------------------------------------------------------------------------------
// Scenarios are chosen by an `SCN:<name>` tag in the user's prompt, so a nudge the agent loop adds
// afterwards (which carries no tag) never changes which script a run follows.

const SECRETS = {
	aws: 'AKIAIOSFODNN7EXAMPLE',
	gh: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6',
	sk: 'sk-' + 'proj1234567890abcdefghijkl',
	pw: 'hunter2hunter2xyz',
};
/** Resolved by the test to let a held request go; one gate per held scenario. */
const gates = {};
const hold = name => new Promise(resolve => { gates[name] = resolve; });
const release = name => { gates[name]?.(); delete gates[name]; };

const mock = await startMock(async req => {
	const out = await script(req);
	// The agent's completion gate may nudge after a write; answer the nudge differently so a final answer is not repeated.
	const said = req.messages.some(m => m.role === 'assistant' && typeof out === 'string' && out.length > 12 && String(m.content).includes(out));
	return said ? 'Nothing more to do.' : out;
}, { chunkDelay: 40 });
/** The scripted model: what to say for one request. */
async function script(req) {
	const msgs = req.messages;
	const lastTag = msgs.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user' && /SCN:\w+/.test(String(m.content))).at(-1);
	const scn = lastTag ? /SCN:(\w+)/.exec(String(lastTag.m.content))[1] : '';
	const toolsAfter = lastTag ? msgs.slice(lastTag.i + 1).filter(m => m.role === 'tool') : [];
	const lastTool = toolsAfter.at(-1);
	const offered = name => req.tools?.some(t => t.function?.name === name);
	const wholeText = JSON.stringify(msgs);
	if (msgs.slice(-2).some(m => /Summarize the conversation above/.test(String(m.content)))) { return 'Summary of the earlier conversation.'; }
	if (!scn) {
		return /hello phone/i.test(wholeText) ? 'Hello from the mock model.' : 'Okay.';
	}
	if (scn === 'plain') { return 'Hello from the mock model.'; }
	if (scn === 'write') {
		return toolsAfter.length === 0 && offered('write_file')
			? { text: 'Writing the file.', tool: { name: 'write_file', args: { path: 'remote-e2e.txt', content: 'written from the phone\n' } } }
			: 'Wrote remote-e2e.txt.';
	}
	if (scn === 'deny') {
		return toolsAfter.length === 0 && offered('write_file')
			? { tool: { name: 'write_file', args: { path: 'denied.txt', content: 'must not exist\n' } } }
			: `Understood, not writing. Tool said: ${String(lastTool?.content).slice(0, 80)}`;
	}
	if (scn === 'ask') {
		return toolsAfter.length === 0
			? { tool: { name: 'ask_user', args: { question: 'Which flavour?', options: [{ label: 'Vanilla', description: 'plain' }, { label: 'Mango', description: 'fruity' }] } } }
			: `You picked: ${/answered: (.*)/.exec(String(lastTool?.content))?.[1] ?? '?'}`;
	}
	if (scn === 'secret') {
		return toolsAfter.length === 0 && offered('read_file')
			? { tool: { name: 'read_file', args: { path: 'secrets.txt' } } }
			: 'Read the file.';
	}
	if (scn === 'steer') {
		// Step 1 lists the folder; step 2 is held so the phone can steer; step 3 must see the steer.
		if (toolsAfter.length === 0) { return { tool: { name: 'list_dir', args: { path: '.' } } }; }
		if (toolsAfter.length === 1) { await hold('steer'); return { tool: { name: 'list_dir', args: { path: '.' } } }; }
		const steered = msgs.some(m => m.role === 'user' && String(m.content).includes('STEER-NOW'));
		return steered ? 'Steered: saw STEER-NOW.' : 'Not steered.';
	}
	if (scn === 'stop') {
		if (toolsAfter.length === 0) { return { tool: { name: 'list_dir', args: { path: '.' } } }; }
		await hold('stop');
		return 'This should never be shown after Stop.';
	}
	if (scn === 'slow') {
		// A reply that takes several seconds to arrive, so the link can be cut part-way through.
		await hold('slow');
		return 'The slow answer arrived in full after the link came back.';
	}
	return 'Okay.';
}
const seen = mock.seen;

// ---- Desktop ------------------------------------------------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-remote-'));
const fakeCloudflared = path.join(work, 'cloudflared');
fs.writeFileSync(fakeCloudflared, [
	'#!/usr/bin/env node',
	'// Stand-in for cloudflared: announces a quick-tunnel address and says the connector registered.',
	'console.error("INF |  https://e2e-fake.trycloudflare.com  |");',
	'console.error("INF Registered tunnel connection connIndex=0");',
	'setInterval(() => {}, 1 << 30);',
].join('\n'));
fs.chmodSync(fakeCloudflared, 0o755);
const relayPort = await freePort();

const host = await startHost({
	mockPort: mock.port,
	settings: {
		// 'always' means the phone's agent runs ask before every write, so approvals can be tested.
		'stormcoder.guardrails.approval': 'always',
		'stormcoder.remote.relayMode': 'local',
		'stormcoder.remote.cloudflaredPath': fakeCloudflared,
		'stormcoder.remote.localPort': relayPort,
	},
	files: {
		'secrets.txt': `AWS=${SECRETS.aws}\nGITHUB=${SECRETS.gh}\nOPENAI=${SECRETS.sk}\npassword = ${SECRETS.pw}\nplain line stays\n`,
		'notes.md': '# notes\n',
	},
});
const project = host.project;
const settingsFile = path.join(host.data, 'settings.json');
const proxy = await startProxy(relayPort);
const phoneOrigin = `http://127.0.0.1:${proxy.port}`;

const browser = await launchChromium();
let failed = false;
const frames = []; // every frame the phone's page received, for wire-level assertions
const phoneErrors = [];
try {
	// ---- Desktop: switch remote on in Settings, mint a pairing code ---------------------------------
	step('desktop: open Settings > Remote control and turn it on');
	const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const desktopErrors = [];
	desktop.on('pageerror', e => desktopErrors.push(e.message));
	const hostFrames = [];
	desktop.on('websocket', ws => ws.on('framereceived', f => { if (typeof f.payload === 'string') { hostFrames.push(f.payload); } }));
	await desktop.goto(host.url);
	await desktop.frameLocator('#view-chat').locator('#input').waitFor();
	await desktop.click('[data-view=settings]');
	const settings = desktop.frameLocator('#view-settings');
	await settings.getByRole('button', { name: 'Remote control' }).click();
	await settings.locator('.area.active[data-area=remote]').waitFor();
	await settings.locator('.remote-status-label', { hasText: 'Remote: off' }).waitFor();
	await settings.locator('.remote-toggle').click();
	await settings.locator('.remote-status-label', { hasText: 'Remote: connected' }).waitFor({ timeout: 30000 });
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['stormcoder.remote.enabled'], true, 'the switch is saved');

	step('desktop: Pair a device (waits for the tunnel address, up to ~30s)');
	await settings.getByRole('button', { name: 'Pair a device' }).click();
	const card = settings.locator('.remote-pairing-card');
	await card.waitFor({ timeout: 90000 });
	const code = (await card.locator('.remote-pairing-code').textContent()).trim();
	assert.match(code, /^[A-Z0-9]{8}$/, 'an 8-character code is shown');
	assert.equal(await card.locator('svg.remote-pairing-qr').count(), 1, 'a QR code is drawn');
	const pairingUrl = hostFrames.map(f => { try { return JSON.parse(f).payload?.message; } catch { return undefined; } })
		.filter(p => p?.type === 'remote' && p.pairing).at(-1).pairing.url;
	assert.match(pairingUrl, /^https:\/\/e2e-fake\.trycloudflare\.com\/p\/[^/#]+#/, 'the QR link carries the tunnel address, room and code');
	const roomId = decodeURIComponent(new URL(pairingUrl).pathname.split('/')[2]);

	// ---- Phone ------------------------------------------------------------------------------------
	step('phone: open the app at a phone viewport and enter the code');
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
	});
	const phone = await context.newPage();
	phone.on('pageerror', e => phoneErrors.push(e.message));
	// The phone app ships a strict Content-Security-Policy (no inline script or style): a violation
	// means a file or a feature the policy would block, which must show up here and not on a user's phone.
	phone.on('console', m => { if (/Content[- ]Security[- ]Policy|violates the following/i.test(m.text())) { phoneErrors.push(m.text()); } });
	let documentCsp = '';
	phone.on('response', r => { if (r.request().resourceType() === 'document' && !documentCsp) { documentCsp = r.headers()['content-security-policy'] ?? ''; } });
	phone.on('websocket', ws => ws.on('framereceived', f => { if (typeof f.payload === 'string') { frames.push(f.payload); } }));
	// The relay refuses a room it does not know, so a wrong code must fail first.
	await phone.goto(`${phoneOrigin}/p/${encodeURIComponent(roomId)}`);
	await phone.locator('#pairScreen:not([hidden])').waitFor();
	await phone.fill('#pairCode', 'WRONGCDE');
	await phone.tap('#pairForm button[type=submit]');
	await phone.locator('#pairError', { hasText: /\S/ }).waitFor({ timeout: 10000 });
	assert.equal(await phone.locator('#app').evaluate(e => e.hidden), true, 'a wrong code does not pair');
	await phone.fill('#pairCode', code);
	await phone.tap('#pairForm button[type=submit]');
	await phone.locator('#app:not([hidden])').waitFor({ timeout: 15000 });
	await phone.locator('#status.status-ok').waitFor({ timeout: 15000 });
	assert.equal((await phone.locator('#status').textContent()).trim(), 'Connected');
	assert.equal(await phone.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'the context is a touch phone');
	// The code is single-use.
	const reuse = await phone.evaluate(async ({ room, code }) => {
		const r = await fetch(`/pair/claim?room=${encodeURIComponent(room)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'again' }) });
		return r.status;
	}, { room: roomId, code });
	assert.ok(reuse >= 400, `a used code is refused (got ${reuse})`);
	// The desktop lists the new device.
	await settings.locator('.remote-device-row', { hasText: 'iPhone · Safari (Stormcoder PWA)' }).waitFor({ timeout: 15000 }).catch(async () => {
		await settings.getByRole('button', { name: 'Refresh' }).click();
		await settings.locator('.remote-device-row', { hasText: 'iPhone · Safari (Stormcoder PWA)' }).waitFor({ timeout: 15000 });
	});

	// The Stop button is toggled with the `hidden` attribute (read as a property: the page's CSS gives it a display that overrides the attribute).
	const stopGone = timeout => until('the Stop button to go away', () => phone.locator('#stopBtn').evaluate(e => e.hidden), timeout);
	const stopShown = () => until('the Stop button to appear', async () => !(await phone.locator('#stopBtn').evaluate(e => e.hidden)), 20000);
	/** Taps a prompt button, waiting for the card. */
	const phoneCard = cls => phone.locator(`.prompt-card.prompt-open${cls}`).last();
	const send = async text => {
		await phone.fill('#composer', text);
		await phone.tap('#sendBtn');
	};
	const assistantText = () => phone.locator('.msg-assistant .msg-body').allTextContents();
	const waitAssistant = (text, timeout = 20000) => until(`phone to show "${text}"`, async () => (await assistantText()).some(t => t.includes(text)), timeout);

	// ---- Ask turn -------------------------------------------------------------------------------
	step('phone: send a message and see the streamed reply');
	await send('hello phone');
	await phone.locator('.msg-user', { hasText: 'hello phone' }).waitFor();
	await waitAssistant('Hello from the mock model.');
	assert.ok(seen.some(r => JSON.stringify(r.messages).includes('hello phone')), 'the model received what the phone typed');
	// The desktop shows the same conversation (the phone drives the shared chat engine).
	const desktopChat = desktop.frameLocator('#view-chat');
	const desktopShows = (text, timeout = 15000) => until(`the desktop to show "${text}"`, async () => (await desktopChat.locator('#messages').textContent().catch(() => '')).includes(text), timeout);
	await desktopShows('Hello from the mock model.');

	// ---- Agent: write + approval allow --------------------------------------------------------------
	step('phone: Agent run, approval card (Allow), tool card, file on disk');
	await phone.selectOption('#modeSelect', 'agent');
	await send('SCN:write create the file');
	const approval = phone.locator('.prompt-card.prompt-approval.prompt-open');
	await approval.waitFor({ timeout: 20000 });
	assert.match(await approval.textContent(), /remote-e2e\.txt/, 'the approval names the file');
	assert.equal(fs.existsSync(path.join(project, 'remote-e2e.txt')), false, 'nothing is written before approval');
	await approval.locator('.prompt-allow').tap();
	await waitAssistant('Wrote remote-e2e.txt.');
	await phone.locator('#stopBtn').evaluate(e => e.hidden).then(() => stopGone(20000));
	assert.equal((await assistantText()).filter(t => t.includes('Wrote remote-e2e.txt.')).length, 1, 'the final answer of an agent run is shown once');
	await phone.locator('.tool .tool-name', { hasText: 'write_file' }).first().waitFor();
	assert.equal(fs.readFileSync(path.join(project, 'remote-e2e.txt'), 'utf8'), 'written from the phone\n');
	await phone.locator('.prompt-card.prompt-answered').first().waitFor();
	await stopGone(15000);
	// The run is also visible on the desktop.
	await desktopShows('Wrote remote-e2e.txt.');

	// ---- Approval deny -------------------------------------------------------------------------
	step('phone: approval card (Deny)');
	await send('SCN:deny write denied.txt');
	const approval2 = phone.locator('.prompt-card.prompt-approval.prompt-open');
	await approval2.waitFor({ timeout: 20000 });
	await approval2.locator('.prompt-deny').tap();
	await waitAssistant('Understood, not writing.');
	assert.equal(fs.existsSync(path.join(project, 'denied.txt')), false, 'a denied write does not happen');

	// ---- ask_user ---------------------------------------------------------------------------------
	step('phone: ask_user question card');
	await send('SCN:ask pick one');
	const ask = phone.locator('.prompt-card.prompt-ask.prompt-open');
	await ask.waitFor({ timeout: 20000 });
	assert.match(await ask.textContent(), /Which flavour\?/);
	assert.match(await ask.textContent(), /fruity/, 'option descriptions are shown');
	await ask.locator('.prompt-option', { hasText: 'Mango' }).tap();
	await waitAssistant('You picked: Mango');

	// ---- Secrets redacted ----------------------------------------------------------------------------
	step('phone: secrets in tool output are redacted before leaving the desktop');
	await send('SCN:secret read secrets.txt');
	// read_file may or may not ask under 'always'; answer whichever arrives.
	for (let i = 0; i < 40 && !(await assistantText()).some(t => t.includes('Read the file.')); i++) {
		const pending = phone.locator('.prompt-card.prompt-approval.prompt-open .prompt-allow');
		if (await pending.count()) { await pending.first().tap(); }
		await sleep(250);
	}
	await waitAssistant('Read the file.');
	await phone.locator('.tool .tool-name', { hasText: 'read_file' }).first().waitFor();
	const phoneText = await phone.locator('#messages').evaluate(el => el.textContent);
	const wire = frames.join('\n');
	for (const [name, secret] of Object.entries(SECRETS)) {
		assert.ok(!wire.includes(secret), `the ${name} secret never crossed the relay`);
		assert.ok(!phoneText.includes(secret), `the ${name} secret is not on the phone`);
	}
	assert.ok(wire.includes('plain line stays'), 'ordinary file content still arrives');
	assert.ok(/redacted/.test(wire), 'redaction markers are on the wire');
	// ...while the desktop (the trusted side) sees the file as it is.
	assert.ok(hostFrames.some(f => f.includes(SECRETS.aws)), 'the desktop itself still sees the raw tool output');

	// ---- Steer ---------------------------------------------------------------------------------------
	step('phone: steer a running agent');
	await send('SCN:steer start working');
	await until('the steer scenario to reach its held step', () => gates.steer, 20000);
	await stopShown();
	assert.match(await phone.locator('#composer').getAttribute('placeholder'), /Steer/);
	await send('STEER-NOW please change course');
	await phone.locator('.msg-user', { hasText: 'STEER-NOW' }).waitFor();
	release('steer');
	await waitAssistant('Steered: saw STEER-NOW.');
	await stopGone(15000);

	// ---- Stop ----------------------------------------------------------------------------------------
	step('phone: Stop a running agent');
	await send('SCN:stop keep going');
	await until('the stop scenario to reach its held step', () => gates.stop, 20000);
	await stopShown();
	await phone.tap('#stopBtn');
	await stopGone(15000);
	release('stop');
	await sleep(500);
	assert.ok(!(await assistantText()).some(t => t.includes('This should never be shown')), 'a stopped run shows nothing more');
	// The chat accepts a new turn straight away.
	await send('SCN:plain hello phone again');
	await waitAssistant('Hello from the mock model.', 20000);

	// ---- Slash commands --------------------------------------------------------------------------------
	step('phone: allowed slash commands (/undo, /compact)');
	// /undo: the earlier write run is in another turn; run a fresh one so "latest run" is the writer.
	fs.rmSync(path.join(project, 'remote-e2e.txt'), { force: true });
	await send('SCN:write again');
	await phone.locator('.prompt-card.prompt-approval.prompt-open .prompt-allow').first().tap();
	await phone.locator('.undo-bar button', { hasText: 'Undo' }).waitFor({ timeout: 20000 });
	assert.ok(fs.existsSync(path.join(project, 'remote-e2e.txt')));
	await stopGone(20000);
	await send('/undo');
	await until('/undo to remove the file the run created', () => !fs.existsSync(path.join(project, 'remote-e2e.txt')), 15000);
	await until('the undo bar to clear', async () => (await phone.locator('.undo-bar').count()) === 0, 15000);

	await send('/compact');
	await phone.locator('.notice-info', { hasText: /Compact/i }).first().waitFor({ timeout: 30000 });
	await until('a compaction result', async () => (await phone.locator('#messages').textContent()).match(/Compacted \d+ earlier message|Not enough conversation/), 30000);

	step('phone: refused slash commands (/memory, /mcp, /skill new)');
	const memBefore = fs.existsSync(path.join(host.data, 'storage', 'memory', 'memory.md')) ? fs.readFileSync(path.join(host.data, 'storage', 'memory', 'memory.md'), 'utf8') : '';
	for (const cmd of ['/memory add user phone planted this', '/mcp add', '/skill new']) {
		const before = await phone.locator('.notice-error', { hasText: "isn't available from a remote device" }).count();
		await send(cmd);
		await until(`${cmd} to be refused`, async () => (await phone.locator('.notice-error', { hasText: "isn't available from a remote device" }).count()) > before, 10000);
	}
	await sleep(500);
	const memAfter = fs.existsSync(path.join(host.data, 'storage', 'memory', 'memory.md')) ? fs.readFileSync(path.join(host.data, 'storage', 'memory', 'memory.md'), 'utf8') : '';
	assert.equal(memAfter, memBefore, '/memory add from the phone saved nothing');
	assert.ok(!fs.existsSync(path.join(project, '.stormcoder', 'skills')), '/skill new from the phone created no skill file');
	assert.ok(!seen.some(r => JSON.stringify(r.messages).includes('phone planted this')), 'a refused command is not forwarded to the model');

	// ---- Chats: create, switch, close -------------------------------------------------------------------
	step('phone: create and switch chats');
	const tabsBefore = await phone.locator('#tabs .tab').count();
	await phone.tap('#newSessionBtn');
	await until('a new tab', async () => (await phone.locator('#tabs .tab').count()) === tabsBefore + 1, 10000);
	assert.equal(await phone.locator('.msg-assistant').count(), 0, 'the new chat is empty');
	await phone.selectOption('#modeSelect', 'ask');
	await send('SCN:plain hello phone from chat two');
	await waitAssistant('Hello from the mock model.');
	await phone.locator('#tabs .tab-title').first().tap();
	await phone.locator('.msg-user', { hasText: 'SCN:write create the file' }).waitFor();
	assert.equal(await phone.locator('.msg-user', { hasText: 'chat two' }).count(), 0, 'chats do not mix');
	await phone.locator('#tabs .tab-title').last().tap();
	await phone.locator('.msg-user', { hasText: 'chat two' }).waitFor();
	// The desktop did not get yanked to the phone's chat.
	// Close the second chat from the phone.
	await phone.locator('#tabs .tab-close').last().tap();
	await until('the chat to close', async () => (await phone.locator('#tabs .tab').count()) === tabsBefore, 10000);

	// ---- Desktop-only messages are refused -----------------------------------------------------------------
	step('phone: desktop-only messages are rejected');
	const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	const denied = await phone.evaluate(async ({ room }) => {
		const stored = JSON.parse(localStorage.getItem(`openvsRelay.device.${room}`));
		const ws = new WebSocket(`ws://${location.host}/ws/client?room=${encodeURIComponent(room)}&token=${encodeURIComponent(stored.token)}`);
		const got = [];
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('socket failed')); });
		ws.onmessage = e => got.push(e.data);
		const out = (seq, p) => ws.send(JSON.stringify({ v: 1, t: 'm', seq, p }));
		ws.send(JSON.stringify({ v: 1, t: 'c', seq: 1, p: { c: 'hello', role: 'client' } }));
		await new Promise(r => setTimeout(r, 500));
		const types = [
			{ type: 'setSystemPrompt', text: 'PWNED' }, { type: 'saveKey', provider: 'custom', key: 'stolen-key-123456' },
			{ type: 'setApproval', approval: 'yolo' }, { type: 'setBaseUrl', provider: 'custom', baseUrl: 'http://evil.example' },
			{ type: 'memoryAdd', text: 'phone memory' }, { type: 'memoryList' }, { type: 'memoryClear' },
			{ type: 'requestPairing' }, { type: 'listDevices' }, { type: 'revokeDevice', deviceId: 'x' },
			{ type: 'setRemoteEnabled', enabled: false }, { type: 'openExternal', url: 'https://evil.example' },
			{ type: 'applyEdit', text: 'x' }, { type: 'deleteHistory' }, { type: 'bogusUnknownType' },
		];
		types.forEach((p, i) => out(10 + i, p));
		await new Promise(r => setTimeout(r, 1500));
		ws.close();
		const errors = got.map(d => { try { return JSON.parse(d).p; } catch { return null; } }).filter(p => p && p.type === 'error').map(p => p.message);
		const leaked = got.filter(d => /"type":"(remote|memory\w*)"/.test(d) && !/"type":"error"/.test(d)).length;
		return { errors, leaked, count: types.length };
	}, { room: roomId });
	assert.equal(denied.errors.filter(m => /not permitted from a remote client/.test(m)).length, denied.count, 'every desktop-only or unknown message is refused with an error');
	assert.equal(denied.leaked, 0, 'no pairing, device or memory data came back');
	const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	assert.equal(after['stormcoder.guardrails.approval'], before['stormcoder.guardrails.approval'], 'approval policy unchanged');
	assert.equal(after['stormcoder.systemPrompt'], before['stormcoder.systemPrompt'], 'system prompt unchanged');
	assert.equal(after['stormcoder.remote.enabled'], true, 'remote control was not switched off by the phone');
	assert.ok(!JSON.stringify(after).includes('evil.example'), 'no base URL was changed');
	assert.ok(!seen.some(r => JSON.stringify(r.messages).includes('PWNED')), 'the model never saw a phone-set system prompt');
	await phone.locator('#status.status-ok').waitFor();

	// ---- Reconnect mid-stream -----------------------------------------------------------------------------------
	step('phone: cut the link mid-run, restore it, transcript intact');
	await phone.selectOption('#modeSelect', 'ask');
	await send('SCN:slow answer slowly');
	await until('the slow request to arrive', () => gates.slow, 20000);
	await stopShown();
	proxy.down();
	await phone.locator('#status', { hasText: /Reconnecting|Connecting/ }).waitFor({ timeout: 15000 });
	release('slow');
	await sleep(1500);
	await proxy.up();
	await phone.locator('#status.status-ok').waitFor({ timeout: 30000 });
	await waitAssistant('The slow answer arrived in full after the link came back.', 30000);
	await stopGone(15000);
	const all = await assistantText();
	assert.ok(all.some(t => t.includes('Hello from the mock model.')), 'earlier replies are still there');
	assert.ok(all.some(t => t.includes('Wrote remote-e2e.txt.')), 'earlier agent replies are still there');
	assert.equal(await phone.locator('.msg-assistant', { hasText: 'The slow answer arrived' }).count(), 1, 'the reply is not duplicated');
	// A plain socket drop (no outage) recovers too, and the phone can send afterwards.
	proxy.cut();
	await phone.locator('#status.status-ok').waitFor({ timeout: 30000 });
	await send('SCN:plain hello phone after the drop');
	await until('a reply after the drop', async () => (await phone.locator('.msg-user', { hasText: 'after the drop' }).count()) === 1 && (await phone.locator('.msg-assistant').count()) > 0, 20000);
	await stopGone(20000);
	// Reload the page: the pairing is remembered and the transcript comes back from the desktop.
	await phone.reload();
	await phone.locator('#status.status-ok').waitFor({ timeout: 30000 });
	await phone.locator('.msg-user', { hasText: 'after the drop' }).waitFor({ timeout: 15000 });

	// ---- Revoke ----------------------------------------------------------------------------------------------------
	step('desktop: revoke the device, phone is locked out');
	const savedToken = await phone.evaluate(room => JSON.parse(localStorage.getItem(`openvsRelay.device.${room}`)).token, roomId);
	await settings.getByRole('button', { name: 'Refresh' }).click();
	const row = settings.locator('.remote-device-row', { hasText: 'iPhone · Safari (Stormcoder PWA)' });
	await row.first().waitFor({ timeout: 15000 });
	await row.first().getByRole('button', { name: 'Revoke' }).click();
	await phone.locator('#pairScreen:not([hidden])').waitFor({ timeout: 20000 });
	assert.match(await phone.locator('#pairError').textContent(), /revoked/i);
	assert.equal(await phone.locator('#app').evaluate(e => e.hidden), true);
	await settings.locator('.remote-device-row', { hasText: 'iPhone · Safari (Stormcoder PWA)' }).waitFor({ state: 'detached', timeout: 15000 });
	// The old token no longer opens a socket, and the phone forgot it.
	const rejected = await new Promise(resolve => {
		const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/client?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(savedToken)}`);
		ws.on('open', () => { ws.close(); resolve(false); });
		ws.on('unexpected-response', () => resolve(true));
		ws.on('error', () => resolve(true));
	});
	assert.equal(rejected, true, 'a revoked token cannot connect');
	await phone.reload();
	await phone.locator('#pairScreen:not([hidden])').waitFor();
	assert.equal(await phone.locator('#app').evaluate(e => e.hidden), true, 'a reload does not get back in');
	// The desktop still works after a revoke.
	await desktop.click('[data-view=chat]');
	const replied = async () => { const t = await desktopChat.locator('#messages').textContent(); const k = t.lastIndexOf('SCN:plain hello phone desktop'); return k >= 0 && /Hello from the mock model\.|Nothing more to do\./.test(t.slice(k)); };
	await desktopChat.locator('#input').fill('SCN:plain hello phone desktop');
	await desktopChat.locator('#input').press('Enter');
	await until('the desktop to get a reply after the revoke', replied);

	assert.match(documentCsp, /script-src 'self'/, 'the phone app is served with a Content-Security-Policy');
	assert.doesNotMatch(documentCsp, /unsafe-inline|unsafe-eval/);
	assert.deepEqual(phoneErrors, [], 'no uncaught errors in the phone app');
	assert.deepEqual(desktopErrors, [], 'no uncaught errors on the desktop');
	console.log('remote-e2e: ok');
} catch (err) {
	failed = true;
	console.error('remote-e2e: FAILED\n', err);
	try {
		const pages = browser.contexts().flatMap(c => c.pages());
		for (const [i, p] of pages.entries()) { await p.screenshot({ path: path.join(os.tmpdir(), `remote-e2e-fail-${i}.png`) }); console.error('screenshot: ' + path.join(os.tmpdir(), `remote-e2e-fail-${i}.png`)); }
	} catch { /* best effort */ }
	console.error('phone errors:', phoneErrors);
	if (process.env.REMOTE_E2E_FRAMES) { console.error(frames.map(f => { try { const p = JSON.parse(f).p; return p?.type ? `${p.type}${p.delta ? ':' + JSON.stringify(p.delta) : ''}${p.content ? '=' + JSON.stringify(String(p.content).slice(0, 40)) : ''}` : `c:${p?.c}`; } catch { return '?'; } }).slice(-80).join('\n')); }
	console.error('last model requests:', JSON.stringify(seen.slice(-2)).slice(0, 1500));
	console.error(host.log().slice(-3000));
} finally {
	for (const name of Object.keys(gates)) { release(name); }
	await browser.close();
	proxy.close();
	host.stop();
	mock.close();
	fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
