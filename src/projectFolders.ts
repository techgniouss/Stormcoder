/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * The open project's folders, even while a run is scoped to a chat's worktree (see the
 * host's `workspace.runInFolder`). Use this, not `workspace.workspaceFolders`, for what
 * exists only in the project folder because it is not checked in: project memory, rules and
 * skills under `.stormcoder/`, MCP configuration. Everything the agent's tools touch keeps
 * using `workspaceFolders`, which is what confines a worktree chat to its worktree.
 */
export function projectFolders(): readonly vscode.WorkspaceFolder[] | undefined {
	// A host without the scope (the unit tests' stub) has only the one notion of a workspace.
	const ws = vscode.workspace as typeof vscode.workspace & { projectFolders?: vscode.WorkspaceFolder[] };
	return ws.projectFolders ?? ws.workspaceFolders;
}
