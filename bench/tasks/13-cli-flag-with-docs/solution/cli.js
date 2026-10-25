const args = process.argv.slice(2);
const json = args.includes('--json');
const [a, b] = args.filter(x => !x.startsWith('--')).map(Number);
console.log(json ? JSON.stringify({ sum: a + b }) : `sum: ${a + b}`);
