/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A provider and one of its models: what a request from the engine is ultimately served by. */
export interface EngineTarget {
	readonly providerId: string;
	readonly model: string;
}

/**
 * Where one chat session's engine requests go: its main model, and the cheaper model the harness
 * uses for background work (titles, summaries, command-prefix checks, `haiku`-class sub-agents).
 */
export interface SessionRoute {
	readonly main: EngineTarget;
	readonly fast: EngineTarget;
}

/** The model names the engine is told to use for a translated upstream. They do not look like any real model. */
export const MAIN_ALIAS = 'stormcoder-main';
export const FAST_ALIAS = 'stormcoder-fast';

/** Whether a provider speaks the Messages API natively, so requests to it are forwarded unchanged. */
export function isAnthropicTarget(target: EngineTarget): boolean {
	return target.providerId === 'anthropic';
}

/** A resolved request model. */
export interface ResolvedModel {
	readonly target: EngineTarget;
	/** True when the model name in the request differs from the target's real one and must be replaced. */
	readonly rewrite: boolean;
}

/**
 * Maps the model name in an engine request to a target.
 *
 * Exact names first (the aliases, then the real ids the engine was told to use), then by family: the
 * harness has a few hard-wired model names of its own, and `haiku` means "the cheap one". Anything
 * else is refused (`undefined`) rather than guessed, so a name nobody mapped can never be served by
 * a model the user did not choose, or bill one they did not expect.
 */
export function resolveTarget(requested: string, route: SessionRoute): ResolvedModel | undefined {
	const name = requested.trim().replace(/\[[^\]]*\]$/, '');
	const exact = (target: EngineTarget, alias: string): boolean => name === alias || name === target.model;
	if (exact(route.main, MAIN_ALIAS)) {
		return { target: route.main, rewrite: name !== route.main.model };
	}
	if (exact(route.fast, FAST_ALIAS)) {
		return { target: route.fast, rewrite: name !== route.fast.model };
	}
	if (/haiku/i.test(name)) {
		return { target: route.fast, rewrite: true };
	}
	if (/sonnet|opus|fable|mythos/i.test(name)) {
		return { target: route.main, rewrite: true };
	}
	return undefined;
}

/**
 * The model names the engine process is told to use. A Messages-native target keeps its real id, so
 * the forwarded request needs no change at all; anything else gets an alias, which the gateway
 * resolves.
 */
export function engineModelEnv(route: SessionRoute): Record<string, string> {
	const main = isAnthropicTarget(route.main) ? route.main.model : MAIN_ALIAS;
	const fast = isAnthropicTarget(route.fast) ? route.fast.model : FAST_ALIAS;
	return {
		ANTHROPIC_MODEL: main,
		ANTHROPIC_DEFAULT_SONNET_MODEL: main,
		ANTHROPIC_DEFAULT_OPUS_MODEL: main,
		CLAUDE_CODE_SUBAGENT_MODEL: main,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
		ANTHROPIC_SMALL_FAST_MODEL: fast,
	};
}
