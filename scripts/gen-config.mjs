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
		if (key.startsWith('openvsChat.completions.')) {
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
	'openvsChat.focus', 'openvsChat.openSettings', 'openvsChat.explainSelection', 'openvsChat.fixSelection', 'openvsChat.docSelection',
	'openvsChat.optimizeSelection', 'openvsChat.generateTests', 'openvsChat.editSelection', 'openvsChat.completions.toggle',
	'openvsChat.completions.trigger', 'openvsChat.completions.showStats', 'openvsChat.generateCommitMessage', 'openvsChat.newChat',
	'openvsChat.selectSkill', 'openvsChat.createSkill',
]);
const commandList = (manifest.contributes.commands ?? [])
	.filter(c => !HIDDEN.has(c.command))
	.map(c => ({ id: c.command, title: String(resolve(c.title)).replace(/^OpenVS Thor:\s*/i, ''), group: 'Command' }));
commandList.push(
	{ id: 'openvsChat.newChat', title: 'New Chat', group: 'Chat' },
	{ id: 'openvsChat.selectSkill', title: 'Choose Active Skills…', group: 'Skills' },
	{ id: 'openvsChat.createSkill', title: 'New Skill…', group: 'Skills' },
);
fs.writeFileSync(new URL('../host/command-list.json', import.meta.url), JSON.stringify(commandList, null, '\t'));
console.log(`commands: ${commandList.length}`);
