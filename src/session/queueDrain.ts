/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decides which client's queue drain wins. Every client — the desktop panel and each paired
 * phone — holds the same shared queue and drains it on the same `done`, so with a phone
 * paired a queued follow-up used to be sent twice; and since a send aborts the tab's running
 * request, the second copy killed the run the first had just started and appended the turn
 * twice. One drain is accepted per finished run; any other is refused.
 */
export class QueueDrainGate {
	/** Tabs whose last run has finished and whose queue has not been drained since. */
	private readonly drainable = new Set<string>();

	/** The run each tab is currently on; a `done` from any other run is a superseded straggler. */
	private readonly current = new Map<string, string>();

	/** Records that `runId` is now `sessionId`'s current run (called as a send is admitted). */
	runStarted(sessionId: string, runId: string): void {
		this.current.set(sessionId, runId);
		this.drainable.delete(sessionId);
	}

	/**
	 * Records that `sessionId`'s run finished (its `done` is being posted). Keyed by run: the
	 * trailing `done` of a run that was superseded must not re-arm the drain while the run
	 * that replaced it is still going.
	 */
	runFinished(sessionId: string, runId?: string): void {
		const current = this.current.get(sessionId);
		if (runId && current !== undefined && current !== runId) {
			return;
		}
		this.drainable.add(sessionId);
	}

	/** Forgets a closed tab. */
	sessionClosed(sessionId: string): void {
		this.current.delete(sessionId);
		this.drainable.delete(sessionId);
	}

	/**
	 * Admits a send for `sessionId`, or refuses it. A queue drain is admitted only while the
	 * tab's finished run has not been drained yet; any other send is always admitted. Either
	 * way an admitted send starts a run, so the tab stops being drainable until that run ends.
	 */
	admit(sessionId: string, fromQueue: boolean): boolean {
		if (fromQueue && !this.drainable.has(sessionId)) {
			return false;
		}
		this.drainable.delete(sessionId);
		return true;
	}
}
