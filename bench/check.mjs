// Runs one task's objective check against a directory somebody else's agent worked in.
//   node bench/check.mjs <task-id> <dir> [--answer "text the agent replied"]
import fs from 'node:fs';
import path from 'node:path';
import { loadTasks, materialize, runCheck } from './lib/tasks.mjs';
const [id, dir, flag, answer] = process.argv.slice(2);
const [task] = loadTasks([id]);
if (!task || !dir) { console.error('usage: node bench/check.mjs <task-id> <dir> [--answer text]'); process.exit(2); }
// The pristine copy is rebuilt so checks that compare against the original still work.
const fresh = await materialize(task);
const result = await runCheck(task, { dir: path.resolve(dir), original: fresh.original }, { answer: flag === '--answer' ? answer : '' });
fresh.dispose();
console.log(result.pass ? 'PASS' : 'FAIL', result.notes.join('; '));
process.exit(result.pass ? 0 : 1);
