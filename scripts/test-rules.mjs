/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/rules.ts: ruleFiles entries are confined to the workspace folder.
import assert from 'node:assert/strict';
import Module from 'node:module';

const read = [];
const warnings = [];
const vscodeStub = {
	Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
	window: { showWarningMessage: async m => { warnings.push(m); } },
	workspace: {
		workspaceFolders: [{ name: 'repo', uri: { path: '/repo' } }],
		getConfiguration: () => ({ get: k => (k === 'ruleFiles' ? ['AGENTS.md', 'sub/../ok.md', '../secret.md', 'a/../../x.md', '/etc/passwd', 'C:\\x.md'] : undefined) }),
		fs: { async readFile(uri) { read.push(uri.path); return new TextEncoder().encode('rule'); } },
	},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { RulesProvider } = await import(new URL('../out/rules.js', import.meta.url));
const rules = new RulesProvider();
await rules.getRules();
await rules.getRules();
assert.deepStrictEqual(read, ['/repo/AGENTS.md', '/repo/sub/../ok.md', '/repo/AGENTS.md', '/repo/sub/../ok.md']);
assert.equal(warnings.length, 4, 'each escaping entry is reported once');
assert.match(warnings[0], /inside the workspace folder/);
console.log('test-rules: all assertions passed');
