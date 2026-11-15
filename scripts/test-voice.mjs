// Voice input (src/voice/transcribe.ts): which provider and model are used, what may be sent
// as audio and where, how failures read, and when the microphone permission is granted.
import assert from 'node:assert/strict';
import {
	MAX_AUDIO_BYTES, allowsMicrophone, audioKind, defaultVoiceModel, transcribe, transcriptionUrl, voiceProvider,
} from '../out/voice/transcribe.js';

// The setting: off unless it names one of the three providers.
assert.equal(voiceProvider('openai'), 'openai');
assert.equal(voiceProvider('groq'), 'groq');
assert.equal(voiceProvider('custom'), 'custom');
for (const v of [undefined, null, '', 'off', 'anthropic', 'OpenAI', true, 1]) {
	assert.equal(voiceProvider(v), 'off');
}
assert.equal(defaultVoiceModel('openai'), 'whisper-1');
assert.equal(defaultVoiceModel('groq'), 'whisper-large-v3-turbo');
assert.equal(defaultVoiceModel('custom'), 'whisper-1');

// Only a recorder's own audio containers count as audio.
assert.deepEqual(audioKind('audio/webm;codecs=opus'), { type: 'audio/webm', file: 'speech.webm' });
assert.deepEqual(audioKind('AUDIO/OGG; codecs=opus'), { type: 'audio/ogg', file: 'speech.ogg' });
assert.deepEqual(audioKind('audio/mp4'), { type: 'audio/mp4', file: 'speech.m4a' });
for (const bad of ['', 'video/webm', 'text/plain', 'application/json', 'audio/', 'constructor', undefined, null, 7]) {
	assert.equal(audioKind(bad), undefined, `refuses ${String(bad)}`);
}

assert.equal(transcriptionUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/audio/transcriptions');
assert.equal(transcriptionUrl(' http://localhost:8000/v1// '), 'http://localhost:8000/v1/audio/transcriptions');
for (const bad of ['', 'api.openai.com/v1', 'file:///etc/passwd', 'ftp://x/y', 'javascript:alert(1)', 'https://']) {
	assert.throws(() => transcriptionUrl(bad), /No speech-to-text address/, `refuses ${bad}`);
}

// A good request: one POST, multipart, with the key as a bearer token and the audio as a file.
const audio = new Uint8Array([1, 2, 3, 4]);
{
	const calls = [];
	const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ text: '  hello there  ' }), { status: 200 }); };
	const text = await transcribe({ baseUrl: 'https://api.example.com/v1/', apiKey: 'k-123', model: 'whisper-1', audio, mimeType: 'audio/webm;codecs=opus', fetchImpl });
	assert.equal(text, 'hello there');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.example.com/v1/audio/transcriptions');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.authorization, 'Bearer k-123');
	const form = calls[0].init.body;
	assert.equal(form.get('model'), 'whisper-1');
	const file = form.get('file');
	assert.equal(file.name, 'speech.webm');
	assert.equal(file.type, 'audio/webm');
	assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
	// A server that needs no key gets no authorization header at all.
	await transcribe({ baseUrl: 'http://localhost:9/v1', apiKey: undefined, model: 'm', audio, mimeType: 'audio/ogg', fetchImpl });
	assert.deepEqual(calls[1].init.headers, {});
}

// Nothing is sent for an empty, oversized or non-audio recording.
{
	let sent = 0;
	const fetchImpl = async () => { sent++; return new Response('{}'); };
	const base = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', fetchImpl };
	await assert.rejects(transcribe({ ...base, audio: new Uint8Array(0), mimeType: 'audio/webm' }), /empty/);
	await assert.rejects(transcribe({ ...base, audio: new Uint8Array(MAX_AUDIO_BYTES + 1), mimeType: 'audio/webm' }), /too long/);
	await assert.rejects(transcribe({ ...base, audio, mimeType: 'video/mp4' }), /format/);
	await assert.rejects(transcribe({ ...base, baseUrl: 'file:///x', audio, mimeType: 'audio/webm' }), /No speech-to-text address/);
	assert.equal(sent, 0);
}

// Failures read as something the user can act on, and never carry the key.
{
	const reply = (status, body = '{}') => async () => new Response(body, { status });
	const base = { baseUrl: 'https://x/v1', apiKey: 'sekret-key', model: 'm', audio, mimeType: 'audio/webm' };
	for (const [fetchImpl, pattern] of [
		[reply(401), /HTTP 401.*needs an API key/],
		[reply(404), /HTTP 404.*no speech-to-text endpoint/],
		[reply(500), /HTTP 500/],
		[reply(200, 'not json'), /not a transcript/],
		[reply(200, '{"text":42}'), /not a transcript/],
		[async () => { throw new Error('socket hang up'); }, /Could not reach.*socket hang up/],
	]) {
		await assert.rejects(transcribe({ ...base, fetchImpl }), e => pattern.test(e.message) && !e.message.includes('sekret-key'));
	}
}

// The microphone: the chat view only, audio only, and only with voice input switched on.
const origin = 'stormcoder-asset://app';
const ask = over => allowsMicrophone({ permission: 'media', url: `${origin}/view/chat?theme=dark`, mediaTypes: ['audio'], voiceOn: true, assetOrigin: origin, ...over });
assert.equal(ask({}), true);
assert.equal(ask({ url: `${origin}/view/chat` }), true);
assert.equal(ask({ voiceOn: false }), false, 'off by default');
assert.equal(ask({ mediaTypes: ['audio', 'video'] }), false, 'never the camera');
assert.equal(ask({ mediaTypes: ['video'] }), false);
assert.equal(ask({ mediaTypes: [] }), false);
assert.equal(ask({ mediaTypes: undefined }), false);
for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'display-capture', 'midi', 'openExternal', '']) {
	assert.equal(ask({ permission }), false, `refuses ${permission}`);
}
for (const url of [`${origin}/page/0123456789abcdef`, `${origin}/view/settings`, `${origin}/view/chat-evil`, `${origin}/view/chat/../page/x`, 'https://evil.example/view/chat', `${origin}.evil/view/chat`, '', undefined]) {
	assert.equal(ask({ url }), false, `refuses ${String(url)}`);
}

console.log('test-voice: all assertions passed');
