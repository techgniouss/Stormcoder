// A scripted stand-in for a model: it writes the files of a task's reference solution, one
// write_file call per file, then reports the reference answer. It exists to prove the harness —
// engine, driver, metrics and checks — works end to end without any model quality involved.
import { startMock } from '../../test/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySolution } from './tasks.mjs';

/** Files that differ between `before` and `after` (relative path -> new content). */
function changedFiles(before, after, rel = '', out = {}) {
	for (const e of fs.readdirSync(path.join(after, rel), { withFileTypes: true })) {
		if (['.git', 'node_modules', 'venv'].includes(e.name)) { continue; }
		const r = path.join(rel, e.name);
		if (e.isDirectory()) { changedFiles(before, after, r, out); continue; }
		const b = path.join(before, r);
		const content = fs.readFileSync(path.join(after, r), 'utf8');
		if (!fs.existsSync(b) || fs.readFileSync(b, 'utf8') !== content) { out[r] = content; }
	}
	return out;
}

export async function startOracle(task, ws, { idle = false } = {}) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-oracle-'));
	fs.cpSync(ws.dir, scratch, { recursive: true });
	await applySolution(task, scratch);
	// An idle oracle changes nothing and says it finished: what a model that only talks looks like.
	const writes = idle ? [] : Object.entries(changedFiles(ws.dir, scratch));
	fs.rmSync(scratch, { recursive: true, force: true });
	const answer = idle ? 'All done, everything is fixed and verified.' : task.referenceAnswer ?? 'Done.';
	const mock = await startMock(req => {
		const done = req.messages.filter(m => m.role === 'tool').length;
		const canWrite = req.tools?.some(t => t.function?.name === 'write_file');
		if (canWrite && done < writes.length) {
			const [file, content] = writes[done];
			return { text: `Writing ${file}.`, tool: { name: 'write_file', args: { path: file, content } } };
		}
		return answer;
	});
	return { port: mock.port, close: () => mock.close() };
}
