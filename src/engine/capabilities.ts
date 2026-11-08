/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextWindowFor } from '../agent/contextWindow';
import { ChatProvider, ModelEntry, entrySupportsTools } from '../providers/types';
import { EngineTarget, isAnthropicTarget } from './modelMap';

/**
 * What the harness may keep depends on the model that ends up serving it: a Claude model reached
 * through Anthropic's API keeps every Claude feature (the request is forwarded unchanged); any other
 * model is served through a translation that cannot carry them. Decided per target, never globally.
 */
export type UpstreamKind = 'anthropic' | 'translated';

/** The kind of upstream a target is. */
export function upstreamKind(target: EngineTarget): UpstreamKind {
	return isAnthropicTarget(target) ? 'anthropic' : 'translated';
}

/**
 * The smallest context window a model may have and still run the harness. Its system prompt and tool
 * definitions alone are well over ten thousand tokens; below this there is no room to work.
 */
export const MIN_CONTEXT_TOKENS = 32_000;

/** Below this a model works but compacts constantly, so the user is told. */
export const COMFORTABLE_CONTEXT_TOKENS = 100_000;

/** Whether a target can serve the harness, and what the user should know if it can. */
export interface TargetCheck {
	readonly ok: boolean;
	/** Why it cannot serve. Empty when `ok`. */
	readonly problems: string[];
	/** Things that work but cost quality or money. */
	readonly warnings: string[];
	/** The model's context window in tokens. */
	readonly contextWindow: number;
}

/** Checks one target against what the harness needs. */
export function checkTarget(
	target: EngineTarget,
	provider: ChatProvider | undefined,
	catalog: ModelEntry[] | undefined,
): TargetCheck {
	const problems: string[] = [];
	const warnings: string[] = [];
	const contextWindow = contextWindowFor(target.model, catalog);
	if (!provider) {
		return { ok: false, problems: [`The provider "${target.providerId}" is not available.`], warnings, contextWindow };
	}
	if (upstreamKind(target) === 'translated') {
		if (!provider.runAgentStep || !entrySupportsTools(provider.info, catalog, target.model)) {
			problems.push(`"${target.model}" does not support tool calling, which the Claude Code engine needs. Pick a tool-capable model.`);
		}
		if (contextWindow < MIN_CONTEXT_TOKENS) {
			problems.push(`"${target.model}" has a ${contextWindow.toLocaleString('en-US')}-token context window; the Claude Code engine needs at least ${MIN_CONTEXT_TOKENS.toLocaleString('en-US')}.`);
		} else if (contextWindow < COMFORTABLE_CONTEXT_TOKENS) {
			warnings.push(`"${target.model}" has a small context window (${contextWindow.toLocaleString('en-US')} tokens), so long tasks will compact often.`);
		}
		warnings.push('This model is reached through a translation layer: Claude-only features (extended thinking, prompt-cache markers, hosted web search) are not used with it.');
	}
	return { ok: problems.length === 0, problems, warnings, contextWindow };
}

/** Harness tools that only work against Anthropic's own API and must be denied for a translated upstream. */
export const ANTHROPIC_ONLY_TOOLS: readonly string[] = ['WebSearch'];

/**
 * Environment that tells the harness the real size of a translated model's window, so it compacts
 * before the model overflows instead of at the Claude-sized threshold it would assume. Nothing for
 * an Anthropic upstream: the harness already knows those windows.
 */
export function compactionEnv(target: EngineTarget, contextWindow: number): Record<string, string> {
	if (upstreamKind(target) === 'anthropic') {
		return {};
	}
	return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.max(MIN_CONTEXT_TOKENS, Math.floor(contextWindow))) };
}
