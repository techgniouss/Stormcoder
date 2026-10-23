/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/skills.ts's workspace skill discovery. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-skills.mjs
//
// Skills are usually published as `<id>/SKILL.md` with `name:`/`description:` frontmatter.
// Only `<id>.md` files with a `> quote` description used to be understood, so a skill copied
// in from upstream appeared with no description, or not at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

const FILE = 1;
const DIRECTORY = 2;
// The real bundled file, as the folded (`description: >`) case models actually meet.
const caveman = fs.readFileSync(new URL('../skills/caveman.md', import.meta.url), 'utf8');
const files = {
	'/repo/.openvs/skills/plain.md': '# Plain Skill\n> Says what it does.\n\nBody.',
	'/repo/.openvs/skills/quoted.md': '---\r\nname: "Quoted Name"\r\ndescription: \'single line\'\r\n---\r\n# A Heading\r\n> not this\r\n',
	'/repo/.openvs/skills/compress/SKILL.md': caveman,
	'/repo/.openvs/skills/UPPER.MD': '---\nname: Upper\ndescription: first part\n  second part\n---\nbody',
	'/repo/.openvs/skills/README.md': '# Readme\n> not a skill',
	'/repo/.openvs/skills/linked.md': '# Linked\n> via symlink',
	'/repo/.openvs/skills/bad.md': '---\nname: Bad\ndescription: "unclosed\n---\nbody',
};
const dirs = {
	'/repo/.openvs/skills': [['plain.md', FILE], ['quoted.md', FILE], ['compress', DIRECTORY], ['empty', DIRECTORY], ['notes.txt', FILE], ['UPPER.MD', FILE], ['README.md', FILE], ['linked.md', 0], ['bad.md', FILE]],
};
const vscodeStub = {
	FileType: { Unknown: 0, File: FILE, Directory: DIRECTORY, SymbolicLink: 64 },
	Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
	workspace: {
		workspaceFolders: [{ uri: { path: '/repo' } }],
		getConfiguration: () => ({ get: () => [] }),
		fs: {
			async stat() { return { type: FILE | 64 }; },
			async readFile(uri) {
				if (!(uri.path in files)) { throw new Error(`ENOENT ${uri.path}`); }
				return new TextEncoder().encode(files[uri.path]);
			},
			async readDirectory(uri) {
				if (!(uri.path in dirs)) { throw new Error(`ENOENT ${uri.path}`); }
				return dirs[uri.path];
			},
		},
	},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { SkillRegistry } = await import(new URL('../out/skills.js', import.meta.url));

const found = (await new SkillRegistry().list())
	.filter(s => s.source === 'file')
	.map(s => ({ id: s.id, name: s.name, description: s.description.slice(0, 60) }));
assert.deepStrictEqual(found, [
	{ id: 'plain', name: 'Plain Skill', description: 'Says what it does.' },
	{ id: 'quoted', name: 'Quoted Name', description: 'single line' },
	{ id: 'compress', name: 'caveman-compress', description: 'Compress natural language memory files (CLAUDE.md, todos, pr' },
	{ id: 'UPPER', name: 'Upper', description: 'first part second part' },
	{ id: 'linked', name: 'Linked', description: 'via symlink' },
	{ id: 'bad', name: 'Bad', description: '"unclosed' },
]);

console.log('test-skills: all assertions passed');
