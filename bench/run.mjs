// Runs the benchmark against a live model (or the scripted oracle) through the real engine.
//
//   node bench/run.mjs --provider anthropic --model claude-sonnet-5 --out results/sonnet.json
//   node bench/run.mjs --provider custom --base-url http://localhost:11434/v1 --model qwen3-coder
//   node bench/run.mjs --provider oracle                       # no model: checks the pipeline itself
//   node bench/run.mjs --provider oracle --oracle idle         # claims success, changes nothing: every task must fail
//
// Keys come from the environment, as the app reads them (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
// Options: --tasks <substring ...>  --repeat N  --approval yolo|auto-edits  --max-steps N
//          --timeout-scale X  --label text  --out file.json
//          --setting key=value ...  set Stormcoder settings for the run, e.g. --setting memory.enabled=false
//          --app-data [dir]  use the keys and provider settings already saved in the Stormcoder app
//                            (default folder for this OS; read-only, signed-in sessions are never touched)
//          --engine <dir>   a different checkout (with dist/ built) to run the tasks against
import fs from 'node:fs';
import path from 'node:path';
import { configuredModel, defaultAppData, inspectApp } from './lib/appkeys.mjs';
import { startEngine } from './lib/engine.mjs';
import { startOracle } from './lib/oracle.mjs';
import { report } from './lib/report.mjs';
import { applySolution, loadTasks, materialize, runCheck } from './lib/tasks.mjs';

const args = parseArgs(process.argv.slice(2));
const provider = args.provider ?? 'anthropic';
const tasks = loadTasks(args.tasks ?? []);
if (!tasks.length) { console.error('no tasks match'); process.exit(2); }
const repeat = Number(args.repeat ?? 1);
const scale = Number(args['timeout-scale'] ?? 1);

// Keys already saved in the app: read from a sanitized copy, by running the engine under Electron.
let app;
if (args['app-data']) {
	const dir = args['app-data'] === true ? defaultAppData() : path.resolve(args['app-data']);
	app = inspectApp(dir);
	if (!app) { console.error(`No Stormcoder app data at ${dir}. Pass --app-data <folder>, or open the app once and save a key.`); process.exit(2); }
	if (provider === 'oracle') { console.error('--app-data has no use with the oracle.'); process.exit(2); }
	if (provider !== 'custom' && !app.apiKeys.includes(provider)) {
		const why = app.signedIn.includes(provider)
			? `${provider} is signed in with a web session in the app. The benchmark never touches sign-in sessions, because refreshing a copy can sign the app out. Save an API key for it in the app, or use another provider.`
			: `The app has no saved key for ${provider}. Providers with a saved API key: ${app.apiKeys.join(', ') || 'none'}.`;
		console.error(why); process.exit(2);
	}
	args.model ??= configuredModel(app, provider);
}

if (!app && provider !== 'oracle' && provider !== 'custom') {
	const envName = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[provider];
	if (envName && !process.env[envName]) { console.error(`${envName} is not set; cannot run against ${provider}.`); process.exit(2); }
}

const runs = [];
// A rejected key or an unknown model fails every task the same way; running the other twelve
// would only produce twelve identical errors, so the first one ends the benchmark.
const AUTH_OR_MODEL_ERROR = /\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}api.?key|incorrect api key|authentication|permission denied|model.{0,30}(not found|does not exist|not available)|no api key/i;
let aborted;
for (const task of tasks) {
	if (aborted) { break; }
	for (let n = 1; n <= repeat && !aborted; n++) {
		process.stdout.write(`${task.id} #${n} ... `);
		const ws = await materialize(task);
		let oracle;
		let engine;
		try {
			const settings = { 'stormcoder.guardrails.approval': args.approval ?? 'yolo', 'stormcoder.agent.maxSteps': Number(args['max-steps'] ?? 60), 'stormcoder.agent.maxRunMinutes': 0 };
			for (const pair of [].concat(args.setting ?? [])) {
				const eq = String(pair).indexOf('=');
				if (eq < 1) { throw new Error(`--setting needs key=value, got "${pair}"`); }
				const key = String(pair).slice(0, eq);
				const raw = String(pair).slice(eq + 1);
				let value = raw;
				try { value = JSON.parse(raw); } catch { /* a plain string */ }
				settings[key.startsWith('stormcoder.') ? key : `stormcoder.${key}`] = value;
			}
			let model = args.model;
			if (provider === 'oracle') {
				oracle = await startOracle(task, ws, { idle: args.oracle === 'idle' });
				Object.assign(settings, { 'stormcoder.defaultProvider': 'custom', 'stormcoder.custom.baseUrl': `http://127.0.0.1:${oracle.port}/v1`, 'stormcoder.custom.model': 'oracle' });
				model = 'oracle';
			} else if (provider === 'custom') {
				Object.assign(settings, { 'stormcoder.defaultProvider': 'custom', 'stormcoder.custom.baseUrl': args['base-url'], 'stormcoder.custom.model': model });
			} else {
				settings['stormcoder.defaultProvider'] = provider;
			}
			engine = await startEngine({ project: ws.dir, settings, app, engineRoot: args.engine ? path.resolve(args.engine) : undefined });
			const turns = [];
			for (const text of task.prompts) {
				turns.push(await engine.send({ sessionId: 'bench', mode: task.mode, provider: provider === 'oracle' ? 'custom' : provider, model, text, timeoutMs: (task.timeoutSec ?? 300) * 1000 * scale }));
			}
			const answer = turns.at(-1).text;
			const check = await runCheck(task, ws, { answer });
			const sum = f => turns.reduce((a, t) => a + t[f], 0);
			const merged = {};
			turns.forEach(t => Object.entries(t.tools).forEach(([k, v]) => { merged[k] = (merged[k] ?? 0) + v; }));
			runs.push({
				task: task.id, category: task.category, attempt: n, pass: check.pass, notes: check.notes,
				steps: sum('steps'), toolCalls: sum('toolCalls'), toolErrors: sum('toolErrors'), asked: sum('asked'),
				estInputTokens: sum('estInputTokens'), requests: sum('requests'), ms: sum('ms'),
				timedOut: turns.some(t => t.timedOut), errors: turns.flatMap(t => t.errors), tools: merged,
				perPrompt: turns.map(t => ({ steps: t.steps, toolCalls: t.toolCalls, estInputTokens: t.estInputTokens, ms: t.ms })),
				answer: answer.slice(0, 600),
			});
			const r = runs.at(-1);
			const fatal = r.errors.find(e => AUTH_OR_MODEL_ERROR.test(e));
			if (fatal && !r.pass) { aborted = fatal; }
			console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.steps} steps  ${r.toolCalls} tools  ${(r.ms / 1000).toFixed(0)}s${r.pass ? '' : '  ' + r.notes.join('; ').slice(0, 140)}`);
		} catch (err) {
			runs.push({ task: task.id, category: task.category, attempt: n, pass: false, notes: [`harness error: ${err instanceof Error ? err.message : String(err)}`], steps: 0, toolCalls: 0, toolErrors: 0, asked: 0, estInputTokens: 0, requests: 0, ms: 0, timedOut: false, errors: [], tools: {}, perPrompt: [], answer: '' });
			console.log(`ERROR ${runs.at(-1).notes[0].slice(0, 160)}`);
		} finally {
			await engine?.stop();
			oracle?.close();
			ws.dispose();
		}
	}
}

if (aborted) {
	console.error(`\nStopped early: ${aborted}\nCheck the API key and model name, then run again. No results file was written.`);
	process.exit(3);
}

const meta = { keys: app ? `app (${app.dir})` : 'environment', label: args.label ?? `${provider}${args.model ? ':' + args.model : ''}`, provider, model: args.model ?? null, approval: args.approval ?? 'yolo', repeat, date: new Date().toISOString() };
console.log('\n' + report(meta, runs));
if (args.out) {
	fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
	fs.writeFileSync(args.out, JSON.stringify({ meta, runs }, null, 2));
	console.log(`\nwrote ${args.out}`);
}
process.exit(0);

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) { continue; }
		const key = argv[i].slice(2);
		const values = [];
		while (argv[i + 1] && !argv[i + 1].startsWith('--')) { values.push(argv[++i]); }
		out[key] = key === 'tasks' || key === 'setting' ? values : (values[0] ?? true);
	}
	return out;
}
