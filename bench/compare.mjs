// node bench/compare.mjs results/a.json results/b.json
import fs from 'node:fs';
import { compare } from './lib/report.mjs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
console.log(compare(a, b));
