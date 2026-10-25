// Proves the benchmark itself is sound, with no model involved: every task must FAIL when left
// untouched and PASS once its reference solution is applied. A task that passes untouched
// measures nothing; one the solution cannot pass is unsolvable.
//   node bench/validate.mjs [task-id-filter ...]
import fs from 'node:fs';
import path from 'node:path';
import { applySolution, loadTasks, materialize, runCheck } from './lib/tasks.mjs';

let bad = 0;
for (const task of loadTasks(process.argv.slice(2))) {
	const ws = await materialize(task);
	try {
		const before = await runCheck(task, ws, { answer: '' });
		await applySolution(task, ws.dir);
		// The reference answer stands in for what a model would say; the untouched run says nothing.
		const after = await runCheck(task, ws, { answer: task.referenceAnswer ?? '' });
		const good = before.pass === false && after.pass === true;
		if (!good) { bad++; }
		console.log(`${good ? 'ok  ' : 'FAIL'} ${task.id}  untouched=${before.pass ? 'PASS(!)' : 'fail'}  solved=${after.pass ? 'pass' : 'FAIL  ' + after.notes.join('; ')}`);
		// Each cheat is a plausible shortcut or sloppy fix; the check must reject every one.
		const cheatsDir = path.join(task.dir, 'cheats');
		for (const name of fs.existsSync(cheatsDir) ? fs.readdirSync(cheatsDir) : []) {
			const cheat = await materialize(task);
			try {
				const from = path.join(cheatsDir, name);
				const onOriginal = fs.existsSync(path.join(from, '.base')) && fs.readFileSync(path.join(from, '.base'), 'utf8').trim() === 'original';
				if (!onOriginal) { await applySolution(task, cheat.dir); }
				for (const f of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
					if (!f.isFile() || f.name === '.base') { continue; }
					const rel = path.relative(from, path.join(f.parentPath, f.name));
					fs.mkdirSync(path.dirname(path.join(cheat.dir, rel)), { recursive: true });
					fs.copyFileSync(path.join(from, rel), path.join(cheat.dir, rel));
				}
				const r = await runCheck(task, cheat, { answer: task.referenceAnswer ?? '' });
				if (r.pass) { bad++; }
				console.log(`${r.pass ? 'FAIL' : 'ok  '} ${task.id}  cheat "${name}" ${r.pass ? 'was ACCEPTED' : 'rejected: ' + r.notes.join('; ').slice(0, 90)}`);
			} finally {
				cheat.dispose();
			}
		}
	} finally {
		ws.dispose();
	}
}
console.log(bad ? `\n${bad} task(s) invalid` : '\nall tasks valid');
process.exit(bad ? 1 : 0);
