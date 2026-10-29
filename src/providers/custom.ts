/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { AgentRequest, AgentStep, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult } from './types';

/** Certificate failures: the server answered, but its HTTPS certificate was not accepted. */
const CERTIFICATE = /CERT|SELF_SIGNED|SSL|TLS/i;

/**
 * Adds `/v1` to a bare address. Nearly every local runner (Ollama, LM Studio, vLLM, llama.cpp, LocalAI)
 * serves the OpenAI API under `/v1`, and people paste the address their server prints, without it.
 * An address that already has a path is left exactly as given.
 */
export function normalizeCustomBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!trimmed) { return ''; }
	try {
		const url = new URL(trimmed);
		return url.pathname === '/' || url.pathname === '' ? `${trimmed}/v1` : trimmed;
	} catch {
		return trimmed;
	}
}

/**
 * Provider for any OpenAI-compatible endpoint the user points it at: local runners
 * (Ollama, LM Studio, vLLM) or hosted open-model gateways (OpenRouter, Together, …).
 * The base URL defaults to Ollama's local endpoint and no API key is required —
 * if one is saved it is sent as a standard Bearer header for secured endpoints.
 */
export class CustomProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'custom',
		label: 'Custom (Local / Self-hosted)',
		suggestedModels: [
			'llama3.1',
			'qwen2.5-coder',
			'deepseek-r1',
			'mistral',
		],
		apiKeyUrl: '',
		requiresApiKey: false,
		supportsTools: true,
		// Arbitrary OSS models — we can't enumerate tool-capable ones in advance,
		// so stay permissive and let the backend's real error surface if a model
		// can't do tool calling.
		toolModelPatterns: [],
		// Same reasoning for vision (matches the NVIDIA provider's approach).
		visionModelPatterns: [],
		// Local runners serve the legacy completions endpoint with `suffix`, so any model
		// whose name marks it as FIM-trained can use it. Named rather than left open,
		// because a non-FIM model on that endpoint continues the prompt with no awareness
		// of the suffix at all, which is worse than offering no completion.
		fimModelPatterns: ['coder', 'codellama', 'starcoder', 'codegemma', 'codestral', 'deepseek-coder', 'stable-code'],
	};

	/**
	 * Runs `call` and turns the failures a person can act on into plain advice: no address set,
	 * nothing listening there, or an address that answers 404 (usually a missing `/v1`). The original
	 * wording stays in the message so retry logic that keys off it still works.
	 */
	private async explain<T>(baseUrl: string, call: () => Promise<T>): Promise<T> {
		const label = this.info.label;
		if (!baseUrl.trim()) {
			throw new Error(`${label}: no server address is set. Enter one under Settings > Providers > Custom, for example http://localhost:11434/v1 for Ollama.`);
		}
		try {
			return await call();
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') { throw err; }
			const message = err instanceof Error ? err.message : String(err);
			const code = String((err as { cause?: { code?: unknown } } | undefined)?.cause?.code ?? '');
			if (/fetch failed/i.test(message)) {
				// undici reports every network-level failure this way, with the reason (when it has one) in `cause`.
				if (CERTIFICATE.test(code)) {
					throw new Error(`${label}: ${baseUrl} answered, but its HTTPS certificate was not accepted (${code}). Use http:// for a local server, or install a trusted certificate. (${message})`);
				}
				throw new Error(`${label}: could not reach ${baseUrl}${code ? ` (${code})` : ''}. Is the server running, and is the address right? (${message})`);
			}
			if (/HTTP 404/.test(message)) {
				throw new Error(`${message} Check the server address: most servers answer under .../v1 (Ollama: http://localhost:11434/v1).`);
			}
			throw err;
		}
	}

	override streamChat(request: ChatRequest): Promise<StreamChatResult> {
		return this.explain(request.baseUrl, () => super.streamChat(request));
	}

	override listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		return this.explain(baseUrl, () => super.listModels(apiKey, baseUrl, signal));
	}

	override runAgentStep(request: AgentRequest): Promise<AgentStep> {
		return this.explain(request.baseUrl, () => super.runAgentStep(request));
	}
}
