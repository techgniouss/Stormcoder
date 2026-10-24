// Guided way to run the benchmark: asks for what it needs, runs it, saves and compares results.
//
//   node bench/start.mjs                       # asks questions
//   node bench/start.mjs --provider anthropic --model claude-sonnet-5 --repeat 3 --yes
//
// Flags skip the matching question. --yes makes the run unattended: it asks nothing and uses
// defaults for anything not given (a missing API key is then an error). The API key is read from the
// provider's environment variable, or typed here (hidden) and passed to the run only: it is never
// written to disk. Results go to bench/results/<label>-<timestamp>.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { configuredModel, defaultAppData, inspectApp } from './lib/appkeys.mjs';
import { compare, report } from './lib/report.mjs';
import { loadTasks } from './lib/tasks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const resultsDir = path.join(import.meta.dirname, 'results');

const PROVIDERS = {
	anthropic: { env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5', note: 'Claude' },
	openai: { env: 'OPENAI_API_KEY', model: 'gpt-5', note: 'GPT' },
	gemini: { env: 'GEMINI_API_KEY', model: 'gemini-2.5-pro', note: 'Gemini' },
	groq: { env: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile', note: 'Groq (free tier limits are small)' },
	openrouter: { env: 'OPENROUTER_API_KEY', model: 'anthropic/claude-sonnet-4.5', note: 'any model through OpenRouter' },
	custom: { env: undefined, model: '', note: 'any OpenAI-compatible server (Ollama, vLLM, LM Studio, ...)' },
	oracle: { env: undefined, model: 'oracle', note: 'no model: checks that the benchmark itself works' },
};

const args = parseArgs(process.argv.slice(2));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lines = [];
let closed = false;
rl.on('close', () => { closed = true; });
rl.on('line', l => lines.push(l));

let muted = false;
if (process.stdin.isTTY) {
	// While a key is typed the terminal echo is suppressed by dropping readline's output.
	const write = rl._writeToOutput.bind(rl);
	rl._writeToOutput = text => { if (!muted) { write(text); } };
}

/** Asks a question; resolves with the typed line, or `fallback` when empty. Hidden when `secret`. */
function ask(question, fallback = '', secret = false) {
	// --yes means unattended: take the default (or nothing) rather than wait for a person.
	if (args.yes) { return Promise.resolve(fallback); }
	return new Promise(resolve => {
		process.stdout.write(question + (fallback ? ` [${fallback}]` : '') + ': ');
		muted = secret && !!process.stdin.isTTY;
		const poll = setInterval(() => {
			if (!lines.length && !closed) { return; }
			clearInterval(poll);
			if (muted) { muted = false; process.stdout.write('\n'); }
			resolve((lines.shift() ?? '').trim() || fallback);
		}, 15);
	});
}

console.log('Stormcoder benchmark — 13 tasks run through the real engine.\n');

// Keys and provider settings already saved in the Stormcoder app, if it has been used on this machine.
const appDir = args['app-data'] && args['app-data'] !== true ? path.resolve(args['app-data']) : defaultAppData();
const app = args['no-app-data'] ? undefined : inspectApp(appDir);
if (app?.apiKeys.length) {
	console.log(`Found the Stormcoder app's saved settings (${app.dir}).`);
	console.log(`  Saved API keys:  ${app.apiKeys.join(', ')}`);
	if (app.signedIn.length) { console.log(`  Signed in only:  ${app.signedIn.join(', ')}  (not usable here: refreshing a copy of a sign-in can log the app out)`); }
	console.log('  They are read from a private copy, by the same code the app uses; nothing is changed or written back.\n');
}

const names = Object.keys(PROVIDERS);
let provider = args.provider;
if (!provider) {
	console.log('Providers:\n' + names.map(n => `  ${n.padEnd(11)} ${PROVIDERS[n].note}${app?.apiKeys.includes(n) ? '   [saved key in app]' : ''}`).join('\n'));
	const preferred = app?.apiKeys.includes(app.defaultProvider) ? app.defaultProvider : app?.apiKeys[0];
	provider = await ask('\nProvider', preferred ?? 'anthropic');
}
if (!PROVIDERS[provider]) { fail(`Unknown provider "${provider}". Choose one of: ${names.join(', ')}.`); }
const info = PROVIDERS[provider];

let model = args.model;
// Use the app's saved key when it has one for this provider and no key was given another way.
// Unattended runs (--yes) do so only when asked with --app-data, so a script never reaches into
// the app's data by surprise.
const hasSaved = !!app && provider !== 'oracle' && (provider === 'custom' ? false : app.apiKeys.includes(provider));
const envKeySet = !!info.env && !!process.env[info.env];
let useApp = false;
if (hasSaved && !envKeySet) {
	useApp = args.yes ? !!args['app-data'] : (await ask(`Use the ${provider} key saved in the app? (y/n)`, 'y')).toLowerCase() === 'y';
}
if (!model && useApp) { model = configuredModel(app, provider) ?? info.model; if (!args.yes) { model = await ask('Model id', model); } }
if (!model && provider !== 'oracle') { model = await ask('Model id', info.model); }
if (provider !== 'oracle' && !model) { fail('A model id is required.'); }

let baseUrl = args['base-url'];
if (provider === 'custom' && !baseUrl) { baseUrl = await ask('Base URL (e.g. http://localhost:11434/v1)'); }
if (provider === 'custom' && !baseUrl) { fail('A base URL is required for a custom provider.'); }

const env = { ...process.env };
if (info.env && !env[info.env] && !useApp) {
	const key = await ask(`${info.env} (input is hidden; used for this run only)`, '', true);
	if (!key) { fail(`No API key. Set ${info.env} or type it when asked.`); }
	env[info.env] = key;
} else if (provider === 'custom' && !env.CUSTOM_API_KEY) {
	const key = await ask('API key for the server (blank if none; used for this run only)', '', true);
	if (key) { env.CUSTOM_API_KEY = key; }
}

const repeat = Number(args.repeat ?? await ask('Repeats per task (3 or more gives usable numbers)', provider === 'oracle' ? '1' : '3'));
if (!Number.isInteger(repeat) || repeat < 1) { fail('Repeats must be a whole number of at least 1.'); }
const filter = args.tasks ? [].concat(args.tasks) : [];
const tasks = loadTasks(filter);
if (!tasks.length) { fail('No tasks match that filter.'); }
const label = args.label ?? `${provider}${model && provider !== 'oracle' ? '-' + model.replace(/[^\w.-]+/g, '_') : ''}`;

const total = tasks.length * repeat;
console.log(`\nAbout to run ${tasks.length} task(s) × ${repeat} = ${total} run(s) with ${provider}${model ? ' / ' + model : ''}.`);
if (provider !== 'oracle') {
	console.log('Each run is a full agent session (many model requests), so this takes a while with a hosted model and costs real API credit. Start small with --tasks 01 10 if unsure.');
}
if (!args.yes && (await ask('Start? (y/n)', 'y')).toLowerCase() !== 'y') { console.log('Cancelled.'); process.exit(0); }
rl.close();

// The bundle is what the benchmark drives; build it when it is missing or older than the sources.
const dist = path.join(root, 'dist/dev-host.js');
const newest = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs), 0);
if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < Math.max(newest(path.join(root, 'src')), newest(path.join(root, 'host')))) {
	console.log('\nBuilding the app first…');
	if (spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status !== 0) { fail('Build failed.'); }
}

fs.mkdirSync(resultsDir, { recursive: true });
const previous = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).map(f => path.join(resultsDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const out = path.join(resultsDir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
const runArgs = ['bench/run.mjs', '--provider', provider, '--repeat', String(repeat), '--label', label, '--out', out];
if (model && provider !== 'oracle') { runArgs.push('--model', model); }
if (baseUrl) { runArgs.push('--base-url', baseUrl); }
if (filter.length) { runArgs.push('--tasks', ...filter); }
if (useApp) { runArgs.push('--app-data', app.dir); }
for (const k of ['approval', 'max-steps', 'timeout-scale', 'engine', 'oracle']) { if (args[k]) { runArgs.push(`--${k}`, String(args[k])); } }
console.log(`\nRunning… (results will be saved to ${path.relative(root, out)})\n`);
const run = spawnSync(process.execPath, runArgs, { cwd: root, env, stdio: 'inherit' });
if (run.status !== 0 || !fs.existsSync(out)) { process.exit(run.status || 1); }

// A natural comparison is with the run just before this one.
const last = previous.find(f => f !== out);
if (last && !args['no-compare']) {
	try {
		console.log('\n' + compare(JSON.parse(fs.readFileSync(last, 'utf8')), JSON.parse(fs.readFileSync(out, 'utf8'))));
		console.log(`\n(A = ${path.relative(root, last)}, B = this run)`);
	} catch { /* an unreadable older file is not worth stopping for */ }
}
console.log(`\nSaved ${path.relative(root, out)}. Compare any two runs with: node bench/compare.mjs <a.json> <b.json>`);

function fail(message) {
	console.error(`\n${message}`);
	process.exit(2);
}

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) { continue; }
		const key = argv[i].slice(2);
		const values = [];
		while (argv[i + 1] && !argv[i + 1].startsWith('--')) { values.push(argv[++i]); }
		o[key] = key === 'tasks' ? values : (values[0] ?? true);
	}
	return o;
}
