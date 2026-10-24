// Loads benchmark tasks and builds the throwaway workspace each run happens in.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const benchRoot = path.resolve(import.meta.dirname, '..');
const tasksDir = path.join(benchRoot, 'tasks');

/** Every task, sorted by id, optionally filtered by id substrings. */
export function loadTasks(filters = []) {
	return fs.readdirSync(tasksDir)
		.filter(id => fs.existsSync(path.join(tasksDir, id, 'task.json')))
		.sort()
		.filter(id => !filters.length || filters.some(f => id.includes(f)))
		.map(id => ({ ...JSON.parse(fs.readFileSync(path.join(tasksDir, id, 'task.json'), 'utf8')), dir: path.join(tasksDir, id) }));
}

/** Copies a directory tree. */
function copy(from, to) {
	fs.cpSync(from, to, { recursive: true });
}

/**
 * A fresh workspace for `task`: its repo files, any generated files, and a git history, so the
 * agent sees an ordinary project. `original` is an untouched copy the check compares against.
 */
export async function materialize(task) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`));
	const dir = path.join(root, 'project');
	fs.mkdirSync(dir, { recursive: true });
	const repo = path.join(task.dir, 'repo');
	if (fs.existsSync(repo)) { copy(repo, dir); }
	if (task.setup) {
		const mod = await import(pathToFileURL(path.join(task.dir, task.setup)).href);
		await mod.default(dir);
	}
	const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
	git('init', '-q');
	git('config', 'user.email', 'bench@example.com');
	git('config', 'user.name', 'bench');
	git('add', '-A');
	git('commit', '-q', '-m', 'initial');
	const original = path.join(root, 'original');
	copy(dir, original);
	return { root, dir, original, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Overlays the task's reference solution onto `dir`. */
export async function applySolution(task, dir) {
	const sol = path.join(task.dir, 'solution');
	if (fs.existsSync(sol)) { copy(sol, dir); }
	// A task whose files are generated at setup supplies its fix as code instead.
	const script = path.join(task.dir, 'solve.mjs');
	if (fs.existsSync(script)) { await (await import(pathToFileURL(script).href)).default(dir); }
}

/** Runs the task's objective check against `dir`. */
export async function runCheck(task, ws, extra = {}) {
	const mod = await import(pathToFileURL(path.join(task.dir, 'check.mjs')).href + `?t=${Date.now()}`);
	try {
		return await mod.default(ws.dir, { original: ws.original, ...extra });
	} catch (err) {
		return { pass: false, notes: [`check crashed: ${err instanceof Error ? err.message : String(err)}`] };
	}
}
