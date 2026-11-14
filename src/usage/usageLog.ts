/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Token counts for one model request, as the backend reported them. `input` excludes cached
 * tokens: `cacheRead` and `cacheWrite` are counted on their own, so the four never overlap.
 */
export interface TokenUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** One line of the usage log. Deliberately nothing about the prompt, the project or the chat. */
export interface UsageEntry extends TokenUsage {
	/** Local calendar day, `YYYY-MM-DD`. */
	readonly day: string;
	readonly provider: string;
	readonly model: string;
}

/** Totals for one provider and model. */
export interface UsageRow extends TokenUsage {
	readonly provider: string;
	readonly model: string;
	readonly requests: number;
}

/** What the Usage view shows for a period. */
export interface UsageSummary extends TokenUsage {
	readonly requests: number;
	/** Share of prompt tokens served from cache, 0 to 1; `undefined` when there were none. */
	readonly cacheHitRate: number | undefined;
	/** Per provider and model, largest total first. */
	readonly rows: UsageRow[];
}

/** The log's file name inside the app's storage folder. */
export const USAGE_FILE = 'usage.jsonl';

/** How long an entry is kept. The Usage sheet's longest period is 30 days. */
export const USAGE_KEEP_DAYS = 90;

/** The three periods the Usage sheet shows, each a summary of the days it covers. */
export interface UsageReport {
	readonly today: UsageSummary;
	readonly week: UsageSummary;
	readonly month: UsageSummary;
}

/** Reads the log once and summarises today, the last 7 days and the last 30 days. */
export function usageReport(log: UsageLog, now: Date = new Date()): UsageReport {
	const month = log.read(daysAgo(now, 29));
	const since = (days: number) => { const from = daysAgo(now, days); return month.filter(e => e.day >= from); };
	return { today: summarize(since(0)), week: summarize(since(6)), month: summarize(month) };
}

/** A whole, non-negative count; anything else (missing, NaN, negative, a string) is 0. */
function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The local calendar day of `date` as `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Reads the `usage` object of an OpenAI-style response or stream chunk. `prompt_tokens`
 * there includes the cached ones, so they are taken out of `input`. Returns `undefined`
 * when the chunk carries no usage, which is every chunk but the last.
 */
export function usageFromOpenAI(json: unknown): TokenUsage | undefined {
	const usage = (json as { usage?: unknown } | null | undefined)?.usage;
	if (typeof usage !== 'object' || usage === null) {
		return undefined;
	}
	const u = usage as Record<string, unknown>;
	const details = (typeof u.prompt_tokens_details === 'object' && u.prompt_tokens_details !== null ? u.prompt_tokens_details : {}) as Record<string, unknown>;
	const prompt = count(u.prompt_tokens);
	const cacheRead = Math.min(prompt, count(details.cached_tokens));
	return { input: prompt - cacheRead, output: count(u.completion_tokens), cacheRead, cacheWrite: 0 };
}

/**
 * Collects usage across an Anthropic message stream: `message_start` carries the prompt
 * side, each `message_delta` the running output count. Counts only ever grow, so a repeated
 * or partial event cannot lower a total.
 */
export class AnthropicUsageTally {
	private input = 0;
	private output = 0;
	private cacheRead = 0;
	private cacheWrite = 0;
	private seen = false;

	/** Feeds one stream event (or a whole non-streamed message). */
	note(event: unknown): void {
		const e = event as { usage?: unknown; message?: { usage?: unknown } } | null | undefined;
		const usage = e?.message?.usage ?? e?.usage;
		if (typeof usage !== 'object' || usage === null) {
			return;
		}
		const u = usage as Record<string, unknown>;
		this.seen = true;
		this.input = Math.max(this.input, count(u.input_tokens));
		this.output = Math.max(this.output, count(u.output_tokens));
		this.cacheRead = Math.max(this.cacheRead, count(u.cache_read_input_tokens));
		this.cacheWrite = Math.max(this.cacheWrite, count(u.cache_creation_input_tokens));
	}

	/** What was reported, or `undefined` when the stream said nothing about usage. */
	result(): TokenUsage | undefined {
		return this.seen ? { input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite } : undefined;
	}
}

/** Adds entries up into the totals and the per-model table the Usage view shows. */
export function summarize(entries: readonly UsageEntry[]): UsageSummary {
	const rows = new Map<string, { provider: string; model: string; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }>();
	const total = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const e of entries) {
		const key = `${e.provider}\u0000${e.model}`;
		let row = rows.get(key);
		if (!row) {
			row = { provider: e.provider, model: e.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			rows.set(key, row);
		}
		for (const target of [row, total]) {
			target.requests++;
			target.input += count(e.input);
			target.output += count(e.output);
			target.cacheRead += count(e.cacheRead);
			target.cacheWrite += count(e.cacheWrite);
		}
	}
	const prompt = total.input + total.cacheRead + total.cacheWrite;
	const weight = (r: TokenUsage) => r.input + r.output + r.cacheRead + r.cacheWrite;
	return {
		...total,
		cacheHitRate: prompt > 0 ? total.cacheRead / prompt : undefined,
		rows: [...rows.values()].sort((a, b) => weight(b) - weight(a) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
	};
}

/** Parses one log line; a damaged or foreign line is skipped, never thrown on. */
function parseLine(line: string): UsageEntry | undefined {
	try {
		const v = JSON.parse(line) as Record<string, unknown>;
		if (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || typeof v.provider !== 'string' || typeof v.model !== 'string') {
			return undefined;
		}
		return { day: v.day, provider: v.provider, model: v.model, input: count(v.input), output: count(v.output), cacheRead: count(v.cacheRead), cacheWrite: count(v.cacheWrite) };
	} catch {
		return undefined;
	}
}

/**
 * The append-only usage log: one JSON line per model request that reported token counts.
 * It holds the day, the provider, the model and four numbers, and nothing else.
 */
export class UsageLog {
	constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) { }

	/** Appends one request. A request that reported no tokens at all is not recorded. */
	record(provider: string, model: string, usage: TokenUsage): void {
		const entry: UsageEntry = {
			day: dayOf(this.now()), provider: String(provider), model: String(model),
			input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite),
		};
		if (entry.input + entry.output + entry.cacheRead + entry.cacheWrite === 0) {
			return;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
		} catch {
			// Usage is a convenience; a full disk or a read-only folder must never fail a chat turn.
		}
	}

	/** Every entry on or after `sinceDay` (`YYYY-MM-DD`), oldest first. */
	read(sinceDay: string): UsageEntry[] {
		let text: string;
		try {
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return [];
		}
		const out: UsageEntry[] = [];
		for (const line of text.split('\n')) {
			const entry = line ? parseLine(line) : undefined;
			if (entry && entry.day >= sinceDay) {
				out.push(entry);
			}
		}
		return out;
	}

	/** Drops entries older than `beforeDay`, and any damaged lines with them. */
	prune(beforeDay: string): void {
		let text: string;
		try {
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return;
		}
		const lines = text.split('\n').filter(Boolean);
		const kept = lines.filter(line => {
			const entry = parseLine(line);
			return entry !== undefined && entry.day >= beforeDay;
		});
		if (kept.length === lines.length) {
			return;
		}
		try {
			const tmp = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
			fs.renameSync(tmp, this.file);
		} catch {
			// Leave the log as it was; pruning is tried again on the next start.
		}
	}
}

/** The day `days` before `now`, as `YYYY-MM-DD`. `days` of 0 is today. */
export function daysAgo(now: Date, days: number): string {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
	return dayOf(d);
}

let sink: UsageLog | undefined;

/** Installs (or, with `undefined`, removes) the log that {@link reportUsage} writes to. */
export function setUsageSink(log: UsageLog | undefined): void {
	sink = log;
}

/**
 * Called by a provider once per model request, with what the backend reported. A provider
 * whose backend reports nothing simply never calls this: nothing is estimated.
 */
export function reportUsage(provider: string, model: string, usage: TokenUsage | undefined): void {
	if (usage && sink) {
		sink.record(provider, model, usage);
	}
}
