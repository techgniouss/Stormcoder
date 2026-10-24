// Derives host/config-defaults.json from the extension manifest the engine was written against.
// The manifest stays the single source of truth for setting names, types and defaults; the app
// ships only the generated JSON.
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../ext-package.reference.json', import.meta.url), 'utf8'));
const cfg = manifest.contributes.configuration;
const groups = Array.isArray(cfg) ? cfg : [cfg];
const defaults = {};
const schema = {};
for (const g of groups) {
	for (const [key, def] of Object.entries(g.properties ?? {})) {
		if (key.startsWith('stormcoder.completions.')) {
			continue; // inline completions need an editor; this app has none
		}
		if ('default' in def) {
			defaults[key] = def.default;
		}
		schema[key] = {
			type: def.type,
			enum: def.enum,
			enumDescriptions: def.enumDescriptions,
			description: def.markdownDescription ?? def.description,
			minimum: def.minimum,
			maximum: def.maximum,
		};
	}
}
fs.writeFileSync(new URL('../host/config-defaults.json', import.meta.url), JSON.stringify({ defaults, schema }, null, '\t'));
console.log(`config: ${Object.keys(defaults).length} defaults, ${Object.keys(schema).length} settings`);

// The command palette lists the engine's commands by their human titles.
const nls = JSON.parse(fs.readFileSync(new URL('../ext-package.nls.reference.json', import.meta.url), 'utf8'));
const resolve = t => typeof t === 'string' && /^%.+%$/.test(t) ? (nls[t.slice(1, -1)] ?? t) : t;
const HIDDEN = new Set([
	'stormcoder.focus', 'stormcoder.openSettings', 'stormcoder.explainSelection', 'stormcoder.fixSelection', 'stormcoder.docSelection',
	'stormcoder.optimizeSelection', 'stormcoder.generateTests', 'stormcoder.editSelection', 'stormcoder.completions.toggle',
	'stormcoder.completions.trigger', 'stormcoder.completions.showStats', 'stormcoder.newChat', 'stormcoder.generateCommitMessage',
	'stormcoder.selectSkill', 'stormcoder.createSkill',
]);
const commandList = (manifest.contributes.commands ?? [])
	.filter(c => !HIDDEN.has(c.command))
	.map(c => ({ id: c.command, title: String(resolve(c.title)).replace(/^Stormcoder:\s*/i, ''), group: 'Command' }));
commandList.push(
	{ id: 'stormcoder.newChat', title: 'New Chat', group: 'Chat' },
	{ id: 'stormcoder.generateCommitMessage', title: 'Write Commit Message for Staged Changes…', group: 'Git' },
	{ id: 'stormcoder.selectSkill', title: 'Choose Active Skills…', group: 'Skills' },
	{ id: 'stormcoder.createSkill', title: 'New Skill…', group: 'Skills' },
);
fs.writeFileSync(new URL('../host/command-list.json', import.meta.url), JSON.stringify(commandList, null, '\t'));
console.log(`commands: ${commandList.length}`);
