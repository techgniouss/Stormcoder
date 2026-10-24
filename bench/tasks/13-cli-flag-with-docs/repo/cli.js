const [a, b] = process.argv.slice(2).filter(x => !x.startsWith('--')).map(Number);
console.log(`sum: ${a + b}`);
