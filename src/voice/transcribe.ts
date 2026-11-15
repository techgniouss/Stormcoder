/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input: turning a recording from the composer's microphone button into text, through a
 * speech-to-text endpoint of a provider the user already holds a key for. Nothing here keeps
 * the audio: it is sent once and dropped. This module has no dependency on the app, so the
 * rules about what may be sent, and where, can be tested on their own.
 */

/** Which provider transcribes. `off` (the default) means the microphone is never asked for. */
export type VoiceProvider = 'off' | 'openai' | 'groq' | 'custom';

/** The largest recording that is sent: about ten minutes of speech as the browser encodes it. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** How long one transcription request may take. */
export const TRANSCRIBE_TIMEOUT_MS = 90_000;

/** Reads `stormcoder.voice.provider`; anything unrecognised is `off`. */
export function voiceProvider(value: unknown): VoiceProvider {
	return value === 'openai' || value === 'groq' || value === 'custom' ? value : 'off';
}

/** The speech-to-text model used when `stormcoder.voice.model` is empty. */
export function defaultVoiceModel(provider: VoiceProvider): string {
	return provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
}

/**
 * The file name and content type a recording is uploaded under, from the type the browser's
 * recorder reported (`audio/webm;codecs=opus`). `undefined` for anything that is not one of
 * the audio containers a recorder produces, so nothing else can be sent as "audio".
 */
export function audioKind(mimeType: unknown): { readonly type: string; readonly file: string } | undefined {
	const type = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
	const ext: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };
	return Object.prototype.hasOwnProperty.call(ext, type) ? { type, file: `speech.${ext[type]}` } : undefined;
}

/** The transcription endpoint under an OpenAI-style base URL. Throws unless it is http(s). */
export function transcriptionUrl(baseUrl: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/[^\s/]/i.test(base)) {
		throw new Error('No speech-to-text address is configured for this provider.');
	}
	return `${base}/audio/transcriptions`;
}

/** What {@link transcribe} needs. `fetchImpl` exists so tests can stand in for the network. */
export interface TranscribeRequest {
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly model: string;
	readonly audio: Uint8Array;
	readonly mimeType: string;
	readonly signal?: AbortSignal;
	readonly fetchImpl?: typeof fetch;
}

/**
 * Sends one recording to the provider's speech-to-text endpoint and returns the text.
 * Throws an `Error` whose message can be shown to the user as it is; it never includes the
 * key or the audio.
 */
export async function transcribe(request: TranscribeRequest): Promise<string> {
	const kind = audioKind(request.mimeType);
	if (!kind) {
		throw new Error('That recording is in a format that cannot be transcribed.');
	}
	if (request.audio.byteLength === 0) {
		throw new Error('The recording was empty.');
	}
	if (request.audio.byteLength > MAX_AUDIO_BYTES) {
		throw new Error(`The recording is too long to transcribe (the limit is ${MAX_AUDIO_BYTES / (1024 * 1024)} MB). Record a shorter one.`);
	}
	const url = transcriptionUrl(request.baseUrl);
	const form = new FormData();
	form.append('model', request.model);
	form.append('response_format', 'json');
	form.append('file', new Blob([new Uint8Array(request.audio)], { type: kind.type }), kind.file);
	const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await (request.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {},
			body: form,
			signal,
		});
	} catch (err) {
		throw new Error(timeout.aborted ? 'Transcription took too long and was stopped.' : `Could not reach the speech-to-text service: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		const hint = response.status === 401 || response.status === 403
			? ' Voice input needs an API key for this provider; a subscription sign-in does not cover speech-to-text.'
			: response.status === 404 ? ' This provider has no speech-to-text endpoint at that address.' : '';
		throw new Error(`Transcription failed (HTTP ${response.status}).${hint}`);
	}
	let text: unknown;
	try {
		text = ((await response.json()) as { text?: unknown }).text;
	} catch {
		text = undefined;
	}
	if (typeof text !== 'string') {
		throw new Error('The speech-to-text service answered with something that is not a transcript.');
	}
	return text.trim();
}

/**
 * Whether a permission request may be granted. The app refuses every permission; the one
 * exception is the microphone, for the chat view alone, audio only, and only while voice
 * input is switched on. A page the agent wrote (`/page/…`), the settings view and anything
 * that is not the app's own origin are refused, as is any request that includes video.
 */
export function allowsMicrophone(request: { permission: string; url: string | undefined; mediaTypes: readonly string[] | undefined; voiceOn: boolean; assetOrigin: string }): boolean {
	if (!request.voiceOn || request.permission !== 'media') {
		return false;
	}
	const types = request.mediaTypes ?? [];
	if (types.length === 0 || types.some(t => t !== 'audio')) {
		return false;
	}
	const url = request.url ?? '';
	return url === `${request.assetOrigin}/view/chat` || url.startsWith(`${request.assetOrigin}/view/chat?`);
}
