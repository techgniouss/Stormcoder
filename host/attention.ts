/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Why a chat wants the user back at the window. */
export type AttentionKind = 'approval' | 'question' | 'done';

/** `stormcoder.notifications`: nothing, only what blocks a run, or a finished run as well. */
export type AttentionLevel = 'off' | 'attention' | 'all';

/** Reads the setting; anything unrecognised means the default, `attention`. */
export function attentionLevel(value: unknown): AttentionLevel {
	return value === 'off' || value === 'all' ? value : 'attention';
}

/**
 * Decides whether a message on its way to the chat view is worth a desktop notification.
 * Only the message's `type` is read: the rest of it (a command, a path, a question) is never
 * needed and must never reach a notification.
 */
export function attentionFor(message: unknown, level: AttentionLevel): AttentionKind | undefined {
	if (level === 'off' || typeof message !== 'object' || message === null) {
		return undefined;
	}
	const type = (message as { type?: unknown }).type;
	if (type === 'approvalRequest') {
		return 'approval';
	}
	if (type === 'askRequest') {
		return 'question';
	}
	if (type === 'done' && level === 'all') {
		return 'done';
	}
	return undefined;
}

/**
 * The notification's body. A fixed string per kind, because a notification is shown on the
 * lock screen and kept in the operating system's history.
 */
export function attentionText(kind: AttentionKind): string {
	switch (kind) {
		case 'approval': return 'A chat needs your approval.';
		case 'question': return 'A chat has a question for you.';
		case 'done': return 'A run finished.';
	}
}

/** Lets one notification per kind through per window, so a burst of approvals is one alert. */
export class AttentionThrottle {
	private readonly last = new Map<AttentionKind, number>();

	constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) { }

	/** True when a notification of this kind may be shown now; records it when so. */
	allow(kind: AttentionKind): boolean {
		const at = this.now();
		const previous = this.last.get(kind);
		if (previous !== undefined && at - previous < this.windowMs) {
			return false;
		}
		this.last.set(kind, at);
		return true;
	}
}
