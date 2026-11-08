/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { anthropicAuthHeaders } from '../providers/anthropic';
import type { ProviderRegistry } from '../providers/registry';
import { withProviderResilience } from '../providers/resilience';
import { stripThinking } from '../persona/thinking';
import { AgentStep, ChatProvider, ModelEntry, isAbortError, modelSupportsVision } from '../providers/types';
import {
	AnthropicRequest, MessageStream, ThinkingFilter, WireUsage, buildMessage, errorBody, estimateRequestTokens, estimateUsage, sse,
	statusForFailure, stopReasonFor, toInternal,
} from './anthropicWire';
import { checkTarget } from './capabilities';
import { EngineTarget, FAST_ALIAS, MAIN_ALIAS, SessionRoute, isAnthropicTarget, resolveTarget } from './modelMap';

/** Largest request body accepted. Images are inline base64, so this is generous; it only stops abuse. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Requests served at once before the gateway answers 429. The harness runs a handful in parallel. */
const MAX_INFLIGHT = 64;

/** How often a quiet stream gets a keep-alive frame, so a slow model is not mistaken for a dead connection. */
const PING_MS = 10_000;

/**
 * How long a translated stream waits for the model's first output before opening the response
 * anyway. The harness retries a request that has produced no response at all within its first-byte
 * window, and a retry is a second paid request; a model that thinks for a minute before its first
 * token would trigger exactly that. A failure that arrives inside this grace period (a rejected key,
 * a rate limit) can still be answered with its real HTTP status and a rotated key.
 */
const EARLY_START_MS = 3_000;

/** How long an oversized upload is read and dropped after it was refused, before the connection is closed. */
const DRAIN_AFTER_REFUSAL_MS = 5_000;

/** HTTP statuses a different stored key has a real chance of surviving (mirrors `withProviderResilience`). */
const KEY_STATUSES = new Set([401, 402, 403, 429]);

/** Response headers worth handing back from Anthropic: they drive the harness's own retry and rate-limit handling. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'request-id', 'x-request-id', 'anthropic-organization-id'];

/** Tokens one finished request used, reported per session. */
export interface GatewayUsage {
	readonly sessionId: string;
	readonly providerId: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** True when the figures were estimated because the upstream did not report them. */
	readonly estimated: boolean;
	/** Which path served it. */
	readonly path: 'passthrough' | 'translated';
}

/** What a caller registers to start using the gateway for one chat session. */
export interface SessionRegistration {
	readonly id: string;
	readonly route: SessionRoute;
	readonly onUsage?: (usage: GatewayUsage) => void;
	/** Non-fatal things the user should see (a hosted tool was dropped, an image was left out). */
	readonly onNotice?: (text: string) => void;
}

/** A registered session: its bearer token, and the way to retire it. */
export interface GatewaySession {
	/** Sent by the engine as `ANTHROPIC_AUTH_TOKEN`. Only the gateway can resolve it. */
	readonly token: string;
	dispose(): void;
}

/** What the gateway needs from the rest of the app. */
export interface GatewayDeps {
	readonly registry: ProviderRegistry;
	/** The fetched model catalog for a provider, when there is one (window and tool-support data). */
	readonly catalog?: (providerId: string) => ModelEntry[] | undefined;
	/** One line per request: method, path, status, model. Never bodies or keys. */
	readonly log?: (line: string) => void;
	/** Overrides `fetch`; tests inject a stub. */
	readonly fetchImpl?: typeof fetch;
	/** Overrides the body cap. */
	readonly maxBodyBytes?: number;
	/** Overrides the keep-alive interval. */
	readonly pingMs?: number;
	/** Overrides how long a translated stream waits for the model before opening anyway. */
	readonly earlyStartMs?: number;
	/** Overrides how long an oversized upload is read and dropped after the 413 before the connection is cut. */
	readonly refusalDrainMs?: number;
}

interface ActiveSession extends SessionRegistration {
	/** Notices already shown, so a request that repeats every turn (the tool list) is reported once. */
	noticed?: Set<string>;
}

/** Counters for diagnostics. */
export interface GatewayStats {
	requests: number;
	passthrough: number;
	translated: number;
	errors: number;
}

/**
 * A local server that speaks the Anthropic Messages API to the Claude Code harness and serves it
 * from any Stormcoder provider.
 *
 * Two paths, chosen per request by the model's provider:
 *  - **Pass-through** (Anthropic API): the body is forwarded as received, so `cache_control`,
 *    thinking, betas, hosted tools and every field not yet invented reach Anthropic unchanged.
 *    Same tokens and cache hits as using Claude directly. Only the credential is swapped in.
 *  - **Translated** (everything else): the request becomes a provider `runAgentStep` /
 *    `streamChat` call, and the reply is emitted as Messages API events.
 *
 * The engine only ever holds a random per-session token; real provider keys never leave the
 * registry.
 */
export class AnthropicGateway {
	private server?: http.Server;
	private port = 0;
	private inflight = 0;
	/** Sessions by SHA-256 of their token, so a lookup never compares secrets character by character. */
	private readonly sessions = new Map<string, ActiveSession>();
	private readonly counters: GatewayStats = { requests: 0, passthrough: 0, translated: 0, errors: 0 };

	constructor(private readonly deps: GatewayDeps) { }

	/** `http://127.0.0.1:<port>`; valid after {@link start}. */
	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Whether the server is listening. */
	get listening(): boolean {
		return !!this.server?.listening;
	}

	/** A snapshot of the request counters. */
	stats(): GatewayStats {
		return { ...this.counters };
	}

	/** Starts listening on a random loopback port. Idempotent. */
	async start(): Promise<void> {
		if (this.server?.listening) {
			return;
		}
		const server = http.createServer((req, res) => {
			// A client that vanishes mid-request surfaces as an 'error' event; with no listener Node would throw.
			req.on('error', () => undefined);
			res.on('error', () => undefined);
			this.handle(req, res).catch(() => {
				try { res.destroy(); } catch { /* already gone */ }
			});
		});
		server.on('error', err => { this.deps.log?.(`gateway server error: ${err.message}`); });
		server.requestTimeout = 120_000;
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
		this.port = (server.address() as AddressInfo).port;
	}

	/** Stops listening, drops every session and closes open connections. */
	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.sessions.clear();
		if (!server) {
			return;
		}
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}

	/** Registers a chat session and returns the token its engine process authenticates with. */
	registerSession(registration: SessionRegistration): GatewaySession {
		const token = `sk-stormcoder-${crypto.randomBytes(32).toString('base64url')}`;
		const key = hashToken(token);
		this.sessions.set(key, registration);
		return { token, dispose: () => { this.sessions.delete(key); } };
	}

	// --- request handling ----------------------------------------------------------------------

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this.counters.requests++;
		if (this.inflight >= MAX_INFLIGHT) {
			this.respond(res, 429, errorBody(429, 'The Stormcoder gateway is handling too many requests at once.'));
			return;
		}
		this.inflight++;
		try {
			if (!this.hostAllowed(req)) {
				this.respond(res, 403, errorBody(403, 'Forbidden.'));
				return;
			}
			const session = this.authenticate(req);
			if (!session) {
				this.respond(res, 401, errorBody(401, 'Invalid or expired Stormcoder gateway token.'));
				return;
			}
			const url = new URL(req.url ?? '/', this.baseUrl);
			const path = url.pathname.replace(/\/+$/, '');
			if (req.method === 'GET' && path === '/v1/models') {
				this.respond(res, 200, modelList(session.route));
			} else if (req.method === 'POST' && path === '/v1/messages') {
				await this.messages(req, res, session, url, '/messages');
			} else if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
				await this.messages(req, res, session, url, '/messages/count_tokens');
			} else {
				this.respond(res, 404, errorBody(404, `No such endpoint: ${req.method} ${path}`));
			}
		} catch (err) {
			this.counters.errors++;
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				const status = err instanceof BodyError ? err.status : 500;
				// An oversized upload is answered, then the connection closed: the rest of it is not read.
				this.respond(res, status, errorBody(status, message), err instanceof BodyError ? { connection: 'close' } : {});
			} else {
				res.end();
			}
		} finally {
			this.inflight--;
		}
	}

	/** Only loopback names on this server's own port: a page that rebinds DNS to 127.0.0.1 sends another `Host`. */
	private hostAllowed(req: http.IncomingMessage): boolean {
		const host = (req.headers.host ?? '').toLowerCase();
		return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}` || host === `[::1]:${this.port}`;
	}

	private authenticate(req: http.IncomingMessage): ActiveSession | undefined {
		const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
		const presented = bearer ?? String(req.headers['x-api-key'] ?? '');
		return presented ? this.sessions.get(hashToken(presented.trim())) : undefined;
	}

	private respond(res: http.ServerResponse, status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void {
		if (res.destroyed || res.writableEnded) {
			return;
		}
		try {
			if (res.headersSent) {
				res.end();
				return;
			}
			const text = JSON.stringify(body);
			res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
			res.end(text);
		} catch {
			try { res.destroy(); } catch { /* already gone */ }
		}
	}

	private async messages(req: http.IncomingMessage, res: http.ServerResponse, session: ActiveSession, url: URL, upstreamPath: string): Promise<void> {
		const raw = await readBody(req, this.deps.maxBodyBytes ?? MAX_BODY_BYTES, this.deps.refusalDrainMs ?? DRAIN_AFTER_REFUSAL_MS);
		let parsed: AnthropicRequest;
		try {
			parsed = JSON.parse(raw.toString('utf8')) as AnthropicRequest;
		} catch {
			this.respond(res, 400, errorBody(400, 'The request body is not valid JSON.'));
			return;
		}
		if (!parsed || typeof parsed.model !== 'string' || !Array.isArray(parsed.messages)) {
			this.respond(res, 400, errorBody(400, 'The request needs a "model" and a "messages" array.'));
			return;
		}
		const resolved = resolveTarget(parsed.model, session.route);
		if (!resolved) {
			this.counters.errors++;
			this.respond(res, 404, errorBody(404, `The model "${parsed.model}" is not mapped by Stormcoder. Choose a main model (and optionally a fast model) in the model picker and Settings > Engine.`));
			return;
		}
		this.deps.log?.(`${req.method} ${url.pathname} -> ${resolved.target.providerId}:${resolved.target.model}`);
		if (isAnthropicTarget(resolved.target)) {
			this.counters.passthrough++;
			await this.passthrough(req, res, session, resolved.target, resolved.rewrite, raw, parsed, url, upstreamPath);
		} else if (upstreamPath === '/messages/count_tokens') {
			this.respond(res, 200, { input_tokens: estimateRequestTokens(parsed) });
		} else {
			this.counters.translated++;
			await this.translated(res, session, resolved.target, parsed);
		}
	}

	// --- pass-through --------------------------------------------------------------------------

	private async passthrough(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		session: ActiveSession,
		target: EngineTarget,
		rewrite: boolean,
		raw: Buffer,
		parsed: AnthropicRequest,
		url: URL,
		upstreamPath: string,
	): Promise<void> {
		const registry = this.deps.registry;
		const doFetch = this.deps.fetchImpl ?? fetch;
		const base = (registry.getBaseUrl(target.providerId) || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
		// Unchanged bytes unless the engine used a model name that has to become the real one.
		const body = rewrite ? Buffer.from(JSON.stringify({ ...parsed, model: target.model })) : raw;
		const betas = String(req.headers['anthropic-beta'] ?? '').split(',').map(b => b.trim()).filter(Boolean);
		const abort = new AbortController();
		res.on('close', () => { if (!res.writableEnded) { abort.abort(); } });

		const attempted = new Set<string>();
		let upstream: Response | undefined;
		// A key-failure response is held, not discarded, until the next turn of the loop has a different
		// key to try; if there is none it is the answer, error body and all.
		let held: Response | undefined;
		for (let attempt = 0; attempt < 6; attempt++) {
			let apiKey = '';
			try {
				apiKey = (await registry.getApiKey(target.providerId)) ?? '';
			} catch (err) {
				if (held) {
					upstream = held;
					held = undefined;
					break;
				}
				this.respond(res, 401, errorBody(401, err instanceof Error ? err.message : String(err)));
				return;
			}
			if (!apiKey && !held) {
				this.respond(res, 401, errorBody(401, 'No Anthropic API key is saved. Add one in Providers.'));
				return;
			}
			if (!apiKey || attempted.has(apiKey)) {
				upstream = held ?? upstream;
				held = undefined;
				break;
			}
			if (held) {
				await held.body?.cancel().catch(() => undefined);
				held = undefined;
			}
			attempted.add(apiKey);
			try {
				upstream = await doFetch(`${base}${upstreamPath}${url.search}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(req.headers.accept ? { accept: String(req.headers.accept) } : {}),
						...(req.headers['user-agent'] ? { 'user-agent': String(req.headers['user-agent']) } : {}),
						...anthropicAuthHeaders(apiKey, betas),
						...(req.headers['anthropic-version'] ? { 'anthropic-version': String(req.headers['anthropic-version']) } : {}),
					},
					// A Buffer is a valid body at runtime; the DOM typings only name the narrower views.
					body: body as unknown as BodyInit,
					signal: abort.signal,
				});
			} catch (err) {
				if (abort.signal.aborted || isAbortError(err)) {
					return;
				}
				this.counters.errors++;
				this.respond(res, 503, errorBody(503, `Could not reach Anthropic: ${err instanceof Error ? err.message : String(err)}`));
				return;
			}
			if (KEY_STATUSES.has(upstream.status) && await registry.rotateApiKey(target.providerId, apiKey, `HTTP ${upstream.status}`)) {
				held = upstream;
				continue;
			}
			break;
		}
		if (held) {
			// The loop ran out of attempts with a response still held: it is the answer.
			upstream = held;
		}
		if (!upstream) {
			this.respond(res, 503, errorBody(503, 'No Anthropic credential could be used.'));
			return;
		}
		if (upstream.ok) {
			registry.noteApiKeySuccess(target.providerId);
		}

		const headers: Record<string, string> = {};
		for (const name of FORWARDED_RESPONSE_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) { headers[name] = value; }
		}
		upstream.headers.forEach((value, name) => { if (name.startsWith('anthropic-ratelimit-')) { headers[name] = value; } });
		res.writeHead(upstream.status, headers);
		const tap = new UsageTap((headers['content-type'] ?? '').includes('event-stream'));
		try {
			for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
				if (res.destroyed) {
					break;
				}
				tap.push(chunk);
				if (!res.write(chunk)) {
					await drained(res);
				}
			}
		} catch (err) {
			if (!abort.signal.aborted && !isAbortError(err)) {
				this.counters.errors++;
			}
		} finally {
			res.end();
		}
		if (upstreamPath === '/messages' && upstream.ok) {
			const usage = tap.result();
			session.onUsage?.({
				sessionId: session.id, providerId: target.providerId, model: target.model, path: 'passthrough', estimated: false,
				inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
			});
		}
	}

	// --- translation ---------------------------------------------------------------------------

	private async translated(res: http.ServerResponse, session: ActiveSession, target: EngineTarget, parsed: AnthropicRequest): Promise<void> {
		const registry = this.deps.registry;
		const provider = registry.getProvider(target.providerId);
		const check = checkTarget(target, provider, this.deps.catalog?.(target.providerId));
		if (!check.ok || !provider) {
			this.counters.errors++;
			this.respond(res, 400, errorBody(400, check.problems.join(' ')));
			return;
		}
		const internal = toInternal(parsed, { allowImages: modelSupportsVision(provider.info, target.model) });
		const unseen = [...new Set(internal.dropped)].filter(item => !(session.noticed ??= new Set()).has(item));
		if (unseen.length) {
			unseen.forEach(item => session.noticed!.add(item));
			session.onNotice?.(`Left out of the request to ${target.model}: ${unseen.join(', ')}.`);
		}
		const tools = parsed.tool_choice?.type === 'none' ? [] : internal.tools;
		const estimatedInput = estimateUsage({ ...internal, tools }, { content: '', toolCalls: [] }).inputTokens;
		if (estimatedInput > check.contextWindow * 0.98) {
			// The wording the harness recognises, so it compacts and retries instead of failing the turn.
			this.respond(res, 400, errorBody(400, `prompt is too long: ${estimatedInput} tokens > ${check.contextWindow} maximum`));
			return;
		}
		const maxTokens = Math.max(256, Math.min(parsed.max_tokens ?? 8192, registry.getMaxTokens()));
		const stream = parsed.stream === true;
		const id = `msg_${crypto.randomBytes(12).toString('hex')}`;
		const abort = new AbortController();
		res.on('close', () => { if (!res.writableEnded) { abort.abort(); } });
		const frames = new MessageStream(id, parsed.model);
		let ping: ReturnType<typeof setInterval> | undefined;
		const begin = (): void => {
			if (!stream || res.headersSent || res.destroyed || res.writableEnded) { return; }
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			safeWrite(res, frames.start(estimatedInput));
			ping = setInterval(() => safeWrite(res, MessageStream.ping()), this.deps.pingMs ?? PING_MS);
			ping.unref();
		};
		res.on('close', () => { if (ping) { clearInterval(ping); } });

		const early = setTimeout(begin, this.deps.earlyStartMs ?? EARLY_START_MS);
		early.unref();
		// Reasoning a provider streams inline is not the answer: the harness must never see it.
		const thinking = new ThinkingFilter();
		let visible = '';
		const show = (text: string): void => {
			visible += text;
			if (stream && text) { begin(); safeWrite(res, frames.text(text)); }
		};
		let step: AgentStep;
		try {
			step = await withProviderResilience(registry, target.providerId, target.model, apiKey => this.runStep(provider, {
				messages: internal.messages, tools, model: target.model, apiKey, baseUrl: registry.getBaseUrl(target.providerId),
				maxTokens, signal: abort.signal,
				onToken: delta => show(thinking.push(delta)),
			}), () => !frames.hasStarted);
		} catch (err) {
			clearTimeout(early);
			if (ping) { clearInterval(ping); }
			if (abort.signal.aborted || isAbortError(err)) {
				res.end();
				return;
			}
			this.counters.errors++;
			const message = err instanceof Error ? err.message : String(err);
			const status = statusForFailure(message);
			if (frames.hasStarted) {
				safeWrite(res, sse('error', errorBody(status, message)));
				res.end();
			} else {
				this.respond(res, status, errorBody(status, message));
			}
			return;
		}
		clearTimeout(early);
		if (ping) { clearInterval(ping); }

		// The answer without any inline reasoning: what was streamed, or (for a provider that returned it
		// whole) the content with its reasoning block removed.
		const answer = visible.trim() ? visible : stripThinking(step.content);
		step = { ...step, content: answer };
		const usage: WireUsage = estimateUsage({ ...internal, tools }, step);
		const finish = step.truncated ? 'length' : step.finishReason;
		if (stream) {
			// A provider may hand back its whole answer without streaming any of it.
			if (!frames.hasText) {
				show(answer.trim());
			}
			begin();
			for (const call of step.toolCalls) {
				safeWrite(res, frames.toolUse({ ...call, name: internal.names.original(call.name) }));
			}
			safeWrite(res, frames.finish(stopReasonFor(finish, step.toolCalls.length > 0), usage.outputTokens));
			res.end();
		} else {
			this.respond(res, 200, buildMessage(id, parsed.model, { ...step, toolCalls: step.toolCalls.map(call => ({ ...call, name: internal.names.original(call.name) })), finishReason: finish }, usage));
		}
		session.onUsage?.({
			sessionId: session.id, providerId: target.providerId, model: target.model, path: 'translated', estimated: usage.estimated,
			inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
		});
	}

	/** One model call: an agent step when tools are offered, a plain chat stream when not. */
	private async runStep(
		provider: ChatProvider,
		request: {
			messages: Parameters<ChatProvider['streamChat']>[0]['messages']; tools: Parameters<NonNullable<ChatProvider['runAgentStep']>>[0]['tools'];
			model: string; apiKey: string; baseUrl: string; maxTokens: number; signal: AbortSignal; onToken: (delta: string) => void;
		},
	): Promise<AgentStep> {
		if (request.tools.length > 0 && provider.runAgentStep) {
			return provider.runAgentStep(request);
		}
		let content = '';
		const result = await provider.streamChat({ ...request, onToken: delta => { content += delta; request.onToken(delta); } });
		return { content, toolCalls: [], truncated: result?.truncated, finishReason: result?.finishReason };
	}
}

/** Resolves when `res` can take more data, or has been closed (a client that left never drains). */
function drained(res: http.ServerResponse): Promise<void> {
	return new Promise(resolve => {
		if (res.destroyed) {
			resolve();
			return;
		}
		const done = (): void => {
			res.off('drain', done);
			res.off('close', done);
			resolve();
		};
		res.once('drain', done);
		res.once('close', done);
	});
}

/** Writes to a response that may already be gone; a write to a dead socket is silently dropped. */
function safeWrite(res: http.ServerResponse, chunk: string): void {
	if (!res.destroyed && !res.writableEnded) {
		try { res.write(chunk); } catch { /* the client left */ }
	}
}

/** The SHA-256 of a token, hex. */
function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

/** `/v1/models` for a session: the names its engine may use. */
function modelList(route: SessionRoute): Record<string, unknown> {
	const ids = [...new Set([
		isAnthropicTarget(route.main) ? route.main.model : MAIN_ALIAS,
		isAnthropicTarget(route.fast) ? route.fast.model : FAST_ALIAS,
	])];
	return {
		data: ids.map(id => ({ type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z' })),
		has_more: false,
		first_id: ids[0] ?? null,
		last_id: ids[ids.length - 1] ?? null,
	};
}

/** A request body that could not be accepted, with the HTTP status to answer it with. */
class BodyError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

/** Reads a request body up to `limit` bytes. */
function readBody(req: http.IncomingMessage, limit: number, drainMs: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers['content-length'] ?? 0);
		if (declared > limit) {
			reject(new BodyError(413, `The request is larger than the ${limit} byte limit.`));
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		req.on('data', (chunk: Buffer) => {
			if (over) {
				return; // drained and dropped: nothing more is kept
			}
			size += chunk.length;
			if (size > limit) {
				over = true;
				chunks.length = 0;
				reject(new BodyError(413, `The request is larger than the ${limit} byte limit.`));
				// The upload is read and dropped just long enough for the 413 to reach the client, then cut:
				// destroying at once would reset the connection before the answer arrived, and never
				// destroying would let one endless upload hold a slot.
				const cut = setTimeout(() => req.destroy(), drainMs);
				cut.unref();
				req.once('close', () => clearTimeout(cut));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

/**
 * Reads token usage out of an Anthropic response as it streams past, without holding the response:
 * `message_start` carries input and cache tokens, `message_delta` the final output count. A
 * non-streaming JSON reply is parsed once at the end (bounded, so a huge body cannot be buffered).
 */
export class UsageTap {
	private input = 0;
	private output = 0;
	private cacheRead = 0;
	private cacheWrite = 0;
	private buffer = '';
	private readonly decoder = new TextDecoder();
	/** Past this a JSON reply is no longer retained for parsing. */
	private static readonly MAX_JSON_BYTES = 8 * 1024 * 1024;
	/** Past this, a streamed line with no newline is dropped. */
	private static readonly MAX_LINE_CHARS = 1024 * 1024;

	constructor(private readonly streaming: boolean) { }

	/** Feeds the next chunk. */
	push(chunk: Uint8Array): void {
		const text = this.decoder.decode(chunk, { stream: true });
		if (!this.streaming) {
			if (this.buffer.length < UsageTap.MAX_JSON_BYTES) { this.buffer += text; }
			return;
		}
		this.buffer += text;
		if (this.buffer.length > UsageTap.MAX_LINE_CHARS && !this.buffer.includes('\n')) {
			this.buffer = ''; // one enormous line carries no usage worth the memory
		}
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			this.line(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf('\n');
		}
	}

	/** The totals seen so far. */
	result(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
		if (!this.streaming && this.buffer) {
			try {
				this.absorb((JSON.parse(this.buffer) as { usage?: Record<string, number> }).usage);
			} catch { /* an error body has no usage */ }
			this.buffer = '';
		}
		return { input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite };
	}

	private line(line: string): void {
		if (!line.startsWith('data:')) { return; }
		try {
			const event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
			if (event.type === 'message_start') { this.absorb(event.message?.usage); }
			if (event.type === 'message_delta') { this.absorb(event.usage); }
		} catch { /* a partial or non-JSON line carries no usage */ }
	}

	private absorb(usage: Record<string, number> | undefined): void {
		if (!usage) { return; }
		if (typeof usage.input_tokens === 'number') { this.input = Math.max(this.input, usage.input_tokens); }
		if (typeof usage.output_tokens === 'number') { this.output = Math.max(this.output, usage.output_tokens); }
		if (typeof usage.cache_read_input_tokens === 'number') { this.cacheRead = Math.max(this.cacheRead, usage.cache_read_input_tokens); }
		if (typeof usage.cache_creation_input_tokens === 'number') { this.cacheWrite = Math.max(this.cacheWrite, usage.cache_creation_input_tokens); }
	}
}
