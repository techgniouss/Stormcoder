/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** A named instruction pack that can be activated to steer the assistant for a task. */
export interface Skill {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly source: 'built-in' | 'settings' | 'file';
}

/**
 * Built-in skills shipped by default. Their instructions are the upstream `SKILL.md`
 * contents, bundled verbatim under `skills/<file>` (see README for sources/attribution).
 * Any of them can be overridden via the `stormcoder.skills` setting or a project
 * `.stormcoder/skills/<id>.md` file.
 */
const BUILTIN_SKILLS: Array<{ id: string; name: string; description: string; file: string }> = [
	{
		id: 'caveman',
		name: 'Caveman',
		description: 'Compress memory/CLAUDE.md into terse "caveman" shorthand to save tokens (JuliusBrussee/caveman).',
		file: 'caveman.md',
	},
	{
		id: 'impeccable',
		name: 'Impeccable',
		description: 'A design language that makes the assistant better at frontend UI/UX: review, polish, redesign, audit (pbakaus/impeccable).',
		file: 'impeccable.md',
	},
	{
		id: 'uiux-pro-max',
		name: 'UI UX PRO MAX',
		description: 'Design intelligence: UI styles, color palettes, font pairings, UX guidelines and chart types across stacks (nextlevelbuilder).',
		file: 'uiux-pro-max.md',
	},
	{
		id: 'agent-browser',
		name: 'Agent Browser',
		description: 'Browser-automation workflow for agents via the agent-browser CLI: navigate, click, fill, extract, screenshot (vercel-labs).',
		file: 'agent-browser.md',
	},
];

/** Where workspace skills live. The pre-rename folder is still read (listed first, so `.stormcoder` wins on an id clash). */
const SKILLS_DIRS = ['.openvs/skills', '.stormcoder/skills'];

/**
 * Resolves the available skills, merging built-ins (bundled `SKILL.md` content) with
 * user-defined ones from the `stormcoder.skills` setting and `.stormcoder/skills/*.md` files
 * (later sources win on id).
 */
export class SkillRegistry {
	constructor(private readonly extensionUri?: vscode.Uri) { }

	/** All skills, keyed by id with later sources overriding earlier ones. */
	async list(): Promise<Skill[]> {
		const byId = new Map<string, Skill>();

		for (const builtin of BUILTIN_SKILLS) {
			byId.set(builtin.id, {
				id: builtin.id,
				name: builtin.name,
				description: builtin.description,
				instructions: await this.readBuiltin(builtin.file),
				source: 'built-in',
			});
		}

		const fromSettings = vscode.workspace.getConfiguration('stormcoder').get<Array<Partial<Skill>>>('skills') ?? [];
		for (const raw of fromSettings) {
			if (raw && raw.id) {
				byId.set(raw.id, {
					id: raw.id,
					name: raw.name ?? raw.id,
					description: raw.description ?? '',
					instructions: raw.instructions ?? '',
					source: 'settings',
				});
			}
		}

		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root) {
			for (const dir of SKILLS_DIRS) {
				for (const skill of await this.readSkillFiles(root, dir)) {
					byId.set(skill.id, skill);
				}
			}
		}

		return [...byId.values()];
	}

	async get(id: string): Promise<Skill | undefined> {
		return (await this.list()).find(s => s.id === id);
	}

	private async readBuiltin(file: string): Promise<string> {
		if (!this.extensionUri) {
			return '';
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'skills', file));
			return new TextDecoder().decode(bytes).trim();
		} catch {
			return '';
		}
	}

	private async readSkillFiles(root: vscode.Uri, folder: string): Promise<Skill[]> {
		const dir = vscode.Uri.joinPath(root, folder);
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return [];
		}
		const skills: Skill[] = [];
		for (const [name, listedType] of entries) {
			// A symlink (or anything the listing could not classify) is followed to what it
			// points at, so a skill linked in from elsewhere is found like any other.
			const type = await this.resolveType(vscode.Uri.joinPath(dir, name), listedType);
			// `<id>.md`, or the layout skills are usually published in: `<id>/SKILL.md`.
			let file: vscode.Uri;
			let id: string;
			if (type === vscode.FileType.File && /\.md$/i.test(name)) {
				if (/^readme\.md$/i.test(name)) {
					continue; // documentation for the folder, not a skill
				}
				file = vscode.Uri.joinPath(dir, name);
				id = name.replace(/\.md$/i, '');
			} else if (type === vscode.FileType.Directory) {
				file = vscode.Uri.joinPath(dir, name, 'SKILL.md');
				id = name;
			} else {
				continue;
			}
			try {
				const bytes = await vscode.workspace.fs.readFile(file);
				skills.push(parseSkillMarkdown(id, new TextDecoder().decode(bytes)));
			} catch {
				// ignore unreadable files, and directories without a SKILL.md
			}
		}
		return skills;
	}

	/** The real type of a directory entry: symlinks and unclassified entries are resolved with `stat`. */
	private async resolveType(uri: vscode.Uri, listed: vscode.FileType): Promise<vscode.FileType> {
		if (listed !== vscode.FileType.Unknown && !(listed & vscode.FileType.SymbolicLink)) {
			return listed;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			return stat.type & ~vscode.FileType.SymbolicLink;
		} catch {
			return vscode.FileType.Unknown; // a dangling link
		}
	}
}

/**
 * Parses a skill markdown file. The standard `SKILL.md` frontmatter (`name:` / `description:`)
 * wins; otherwise the first `# Heading` is the name and the first `> quote` the description.
 * Reading only the latter gave every skill published in the standard format an empty
 * description (its body rarely opens with a quote) and whatever heading came first as a name.
 */
function parseSkillMarkdown(id: string, text: string): Skill {
	const lines = text.split(/\r?\n/);
	const meta = frontmatter(lines);
	const body = meta ? lines.slice(meta.end + 1) : lines;
	const heading = body.find(l => /^#\s+/.test(l));
	const quote = body.find(l => /^>\s+/.test(l));
	return {
		id,
		name: meta?.fields.get('name') || (heading ? heading.replace(/^#\s+/, '').trim() : id),
		description: meta?.fields.get('description') || (quote ? quote.replace(/^>\s+/, '').trim() : ''),
		instructions: text.trim(),
		source: 'file',
	};
}

/**
 * Reads the top-level scalar fields of a leading `---` frontmatter block: plain, quoted, and
 * folded/literal (`>` / `|`) values, which is every form skill files use for name/description.
 * Not a YAML parser — nested structures are skipped, not interpreted.
 */
function frontmatter(lines: readonly string[]): { fields: Map<string, string>; end: number } | undefined {
	if (lines[0]?.trim() !== '---') {
		return undefined;
	}
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	if (end < 0) {
		return undefined;
	}
	const fields = new Map<string, string>();
	for (let i = 1; i < end; i++) {
		const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
		if (!match) {
			continue;
		}
		let value = match[2].trim();
		// Indented lines that follow belong to this field: the body of a `>` / `|` block, or
		// the continuation of a plain or quoted scalar wrapped over several lines.
		const continuation: string[] = [];
		let last = i;
		while (last + 1 < end && (/^\s+\S/.test(lines[last + 1]) || !lines[last + 1].trim())) {
			continuation.push(lines[++last].trim());
		}
		const folded = (first: string): string => [first, ...continuation].filter(Boolean).join(' ');
		if (/^[>|][+-]?$/.test(value)) {
			value = folded('');
			i = last;
		} else if (/^["']/.test(value)) {
			const quote = value[0];
			const whole = folded(value);
			const close = closingQuote(whole, quote);
			if (close > 0) {
				value = whole.slice(1, close);
				value = quote === '"' ? value.replace(/\\(["\\])/g, '$1') : value.replace(/''/g, '\'');
				i = last;
			}
			// A quote that never closes is kept as written rather than guessed at.
		} else if (value) {
			value = folded(value);
			i = last;
		}
		fields.set(match[1], value);
	}
	return { fields, end };
}

/** Index of the quote closing the quoted scalar that opens `text`, or -1 when it never closes. */
function closingQuote(text: string, quote: string): number {
	for (let k = 1; k < text.length; k++) {
		if (quote === '"' && text[k] === '\\') {
			k++;
		} else if (text[k] === quote) {
			if (quote === '\'' && text[k + 1] === '\'') {
				k++;
			} else {
				return k;
			}
		}
	}
	return -1;
}
