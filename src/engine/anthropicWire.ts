/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { estimateTokens } from '../agent/context';
import { CLOSE_MARK, OPEN_MARK } from '../persona/thinking';
import { MALFORMED_ARGS } from '../providers/toolCalls';
import { AgentStep, ChatImage, ChatMessage, FinishReason, ToolCall, ToolSpec } from '../providers/types';

/**
 * Anthropic Messages API wire shapes, and the pure functions that translate them to and from
 * Stormcoder's provider types. Only the translated path of the gateway uses the translators; the
 * pass-through path forwards bytes and reads at most `model` and `stream` (see `gateway.ts`).
 *
 * The request types are deliberately loose (`[key: string]: unknown`): Anthropic adds fields and
 * block types regularly, and an unknown one must be ignored, never rejected.
 */

/** A content block of any type. Known types are narrowed below; unknown ones pass through as data. */
export interface AnthropicBlock {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** One message in a request. */
export interface AnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string | readonly AnthropicBlock[];
}

/** One tool definition. Hosted server tools have a `type` such as `web_search_20250305` and no schema. */
export interface AnthropicTool {
	readonly name: string;
	readonly description?: string;
	readonly input_schema?: Record<string, unknown>;
	readonly type?: string;
	readonly [key: string]: unknown;
}

/** The subset of a Messages request the gateway reads. */
export interface AnthropicRequest {
	readonly model: string;
	readonly max_tokens?: number;
	readonly system?: string | readonly AnthropicBlock[];
	readonly messages: readonly AnthropicMessage[];
	readonly tools?: readonly AnthropicTool[];
	readonly tool_choice?: { readonly type: string; readonly name?: string };
	readonly stream?: boolean;
	readonly [key: string]: unknown;
}

/** What {@link toInternal} produced, and what it had to leave out. */
export interface InternalRequest {
	readonly messages: ChatMessage[];
	readonly tools: ToolSpec[];
	/** Human-readable notes about content that could not be carried over (hosted tools, URL images, ...). */
	readonly dropped: string[];
}

/** Options for {@link toInternal}. */
export interface ToInternalOptions {
	/** Whether the target model accepts images. When false an image is dropped and noted. */
	readonly allowImages: boolean;
}

/** Text of a block list: the `text` blocks joined, everything else ignored. */
function textOf(content: string | readonly AnthropicBlock[] | undefined): string {
	if (content === undefined) {
		return '';
	}
	if (typeof content === 'string') {
		return content;
	}
	return content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n');
}

/** A base64 image block as a {@link ChatImage}, or undefined for a URL source or malformed block. */
function imageOf(block: AnthropicBlock): ChatImage | undefined {
	const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
	if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
		return { mimeType: source.media_type, data: source.data };
	}
	return undefined;
}

/**
 * Translates a Messages request into Stormcoder's provider types.
 *
 * Deterministic and order-preserving: the same request always yields the same messages in the same
 * order, which is what lets a provider with automatic prompt caching keep hitting its cache across
 * the harness's many near-identical requests.
 */
export function toInternal(request: AnthropicRequest, options: ToInternalOptions): InternalRequest {
	const dropped: string[] = [];
	const messages: ChatMessage[] = [];
	const system = textOf(request.system as string | readonly AnthropicBlock[] | undefined);
	if (system) {
		messages.push({ role: 'system', content: system });
	}
	for (const message of request.messages) {
		if (typeof message.content === 'string') {
			messages.push({ role: message.role, content: message.content });
			continue;
		}
		const images: ChatImage[] = [];
		const toolCalls: ToolCall[] = [];
		const toolResults: ChatMessage[] = [];
		const text: string[] = [];
		for (const block of message.content) {
			switch (block.type) {
				case 'text':
					if (typeof block.text === 'string') { text.push(block.text); }
					break;
				case 'image': {
					const image = imageOf(block);
					if (!image) {
						dropped.push('an image given by URL (only inline images are supported)');
					} else if (!options.allowImages) {
						dropped.push('an image (the selected model does not accept images)');
					} else {
						images.push(image);
					}
					break;
				}
				case 'tool_use':
					toolCalls.push({
						id: String(block.id),
						name: String(block.name),
						args: (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>,
					});
					break;
				case 'tool_result': {
					const inner = Array.isArray(block.content) ? block.content as AnthropicBlock[] : undefined;
					const resultImages = (inner ?? []).filter(b => b.type === 'image').map(imageOf).filter((i): i is ChatImage => !!i && options.allowImages);
					const body = typeof block.content === 'string' ? block.content : textOf(inner);
					toolResults.push({
						role: 'tool',
						toolCallId: String(block.tool_use_id),
						content: block.is_error === true ? `Error: ${body}` : body,
						...(resultImages.length ? { images: resultImages } : {}),
					});
					break;
				}
				case 'thinking':
				case 'redacted_thinking':
					// Reasoning the translated upstream never produced: nothing to replay.
					break;
				default:
					dropped.push(`a "${block.type}" block`);
			}
		}
		if (message.role === 'assistant') {
			if (text.length || toolCalls.length) {
				messages.push({ role: 'assistant', content: text.join('\n'), ...(toolCalls.length ? { toolCalls } : {}) });
			}
			continue;
		}
		// Tool results must directly follow the assistant turn that called them, ahead of any new text.
		messages.push(...toolResults);
		if (text.length || images.length) {
			messages.push({ role: 'user', content: text.join('\n'), ...(images.length ? { images } : {}) });
		}
	}

	const tools: ToolSpec[] = [];
	for (const tool of request.tools ?? []) {
		if (!tool.input_schema) {
			dropped.push(`the hosted tool "${tool.name}"`);
			continue;
		}
		tools.push({ name: tool.name, description: tool.description ?? '', parameters: tool.input_schema });
	}
	return { messages, tools, dropped };
}

/** The Anthropic `stop_reason` for a provider's normalized finish reason. */
export function stopReasonFor(finish: FinishReason | undefined, hasToolCalls: boolean): 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' {
	if (hasToolCalls) {
		return 'tool_use';
	}
	switch (finish) {
		case 'length': return 'max_tokens';
		case 'tool_calls': return 'tool_use';
		case 'filtered':
		case 'refused': return 'refusal';
		default: return 'end_turn';
	}
}

/** Token counts reported to the engine, and whether they are estimates. */
export interface WireUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly estimated: boolean;
}

/** Estimated usage for a translated step: providers rarely report it through `runAgentStep`. */
export function estimateUsage(request: InternalRequest, step: Pick<AgentStep, 'content' | 'toolCalls'>): WireUsage {
	let input = 0;
	for (const m of request.messages) {
		input += estimateTokens(m.content) + 4;
		for (const call of m.toolCalls ?? []) {
			input += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args));
		}
	}
	for (const tool of request.tools) {
		input += estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters));
	}
	let output = estimateTokens(step.content);
	for (const call of step.toolCalls) {
		output += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args));
	}
	return { inputTokens: input, outputTokens: output, estimated: true };
}

/** Estimated input tokens of a raw Messages request, for `count_tokens` and the window check. */
export function estimateRequestTokens(request: AnthropicRequest): number {
	const internal = toInternal(request, { allowImages: true });
	return estimateUsage(internal, { content: '', toolCalls: [] }).inputTokens;
}

/** A tool call as an Anthropic `tool_use` block. Unparseable arguments become an empty input the harness reports back. */
export function toolUseBlock(call: ToolCall): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
	const malformed = call.args[MALFORMED_ARGS] !== undefined;
	return { type: 'tool_use', id: call.id, name: call.name, input: malformed ? {} : call.args };
}

/** A complete (non-streaming) Messages response for a translated step. */
export function buildMessage(id: string, model: string, step: AgentStep, usage: WireUsage): Record<string, unknown> {
	const content: unknown[] = [];
	if (step.content) {
		content.push({ type: 'text', text: step.content });
	}
	for (const call of step.toolCalls) {
		content.push(toolUseBlock(call));
	}
	return {
		id,
		type: 'message',
		role: 'assistant',
		model,
		content,
		stop_reason: stopReasonFor(step.finishReason, step.toolCalls.length > 0),
		stop_sequence: null,
		usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
	};
}

/** Length of the longest suffix of `text` that is a proper prefix of `mark`. */
function partialMarkSuffix(text: string, mark: string): number {
	for (let len = Math.min(text.length, mark.length - 1); len > 0; len--) {
		if (text.endsWith(mark.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

/**
 * Removes the reasoning a provider streams inline from a token stream, leaving the answer.
 *
 * Providers with native reasoning wrap it in {@link OPEN_MARK} and {@link CLOSE_MARK} so Stormcoder's
 * own chat can fold it away. The Claude Code harness has no such convention: sent through, the
 * reasoning would appear as the model's answer and be replayed in every later request. Marks may be
 * split across chunks, so a possible partial mark is held back until the next chunk settles it.
 */
export class ThinkingFilter {
	private inside = false;
	private held = '';

	/** Feeds one streamed delta; returns the part of it that is answer text. */
	push(delta: string): string {
		let text = this.held + delta;
		this.held = '';
		let visible = '';
		for (;;) {
			const mark = this.inside ? CLOSE_MARK : OPEN_MARK;
			const at = text.indexOf(mark);
			if (at >= 0) {
				if (!this.inside) {
					visible += text.slice(0, at);
				}
				text = text.slice(at + mark.length);
				this.inside = !this.inside;
				continue;
			}
			const keep = partialMarkSuffix(text, mark);
			if (!this.inside) {
				visible += text.slice(0, text.length - keep);
			}
			this.held = text.slice(text.length - keep);
			return visible;
		}
	}

	/** Called when the stream ends: a held partial mark outside reasoning was ordinary text after all. */
	flush(): string {
		const rest = this.inside ? '' : this.held;
		this.held = '';
		return rest;
	}
}

/** One server-sent event, serialized. */
export function sse(event: string, data: Record<string, unknown>): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Builds the SSE frames of one streamed message, in the order the Messages API emits them. Text is
 * streamed as the provider produces it; tool calls are emitted when the step completes, because
 * `runAgentStep` returns them whole.
 */
export class MessageStream {
	private index = -1;
	private textOpen = false;
	private started = false;
	private emittedText = false;

	constructor(private readonly id: string, private readonly model: string) { }

	/** Whether `start` has produced its frame yet. */
	get hasStarted(): boolean {
		return this.started;
	}

	/** Whether any answer text has been streamed. */
	get hasText(): boolean {
		return this.emittedText;
	}

	/** The `message_start` frame (once). */
	start(inputTokens: number): string {
		if (this.started) {
			return '';
		}
		this.started = true;
		return sse('message_start', {
			type: 'message_start',
			message: {
				id: this.id, type: 'message', role: 'assistant', model: this.model, content: [],
				stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 },
			},
		});
	}

	/** A text fragment, opening a text block first when needed. */
	text(delta: string): string {
		if (!delta) {
			return '';
		}
		this.emittedText = true;
		let out = '';
		if (!this.textOpen) {
			this.index++;
			this.textOpen = true;
			out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
		}
		return out + sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: delta } });
	}

	/** Closes an open text block. */
	private closeText(): string {
		if (!this.textOpen) {
			return '';
		}
		this.textOpen = false;
		return sse('content_block_stop', { type: 'content_block_stop', index: this.index });
	}

	/** A whole tool call as start, one input delta and stop. */
	toolUse(call: ToolCall): string {
		const block = toolUseBlock(call);
		let out = this.closeText();
		this.index++;
		out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
		out += sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
		return out + sse('content_block_stop', { type: 'content_block_stop', index: this.index });
	}

	/** Closes the message with its stop reason and final usage. */
	finish(stopReason: string, outputTokens: number): string {
		return this.closeText()
			+ sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
			+ sse('message_stop', { type: 'message_stop' });
	}

	/** A keep-alive frame. */
	static ping(): string {
		return sse('ping', { type: 'ping' });
	}
}

/** The error `type` the Messages API uses for an HTTP status. */
export function errorTypeFor(status: number): string {
	switch (status) {
		case 400: return 'invalid_request_error';
		case 401: return 'authentication_error';
		case 403: return 'permission_error';
		case 404: return 'not_found_error';
		case 413: return 'request_too_large';
		case 429: return 'rate_limit_error';
		case 503:
		case 529: return 'overloaded_error';
		default: return 'api_error';
	}
}

/** An error body in the Messages API's shape. */
export function errorBody(status: number, message: string): Record<string, unknown> {
	return { type: 'error', error: { type: errorTypeFor(status), message } };
}

/** The HTTP status a provider failure message should be reported as, so the engine's own retry logic behaves. */
export function statusForFailure(message: string): number {
	const http = /\bhttp (\d{3})\b/i.exec(message);
	if (http) {
		const code = Number(http[1]);
		if (code === 401 || code === 403 || code === 404 || code === 413 || code === 429) { return code; }
		if (code >= 500) { return code === 529 ? 529 : 503; }
		if (code >= 400) { return 400; }
	}
	if (/rate.?limit|quota|too many requests/i.test(message)) { return 429; }
	if (/overloaded|unavailable|timed? ?out|econnreset|fetch failed|network/i.test(message)) { return 503; }
	if (/context|too long|too many tokens/i.test(message)) { return 400; }
	return 500;
}
