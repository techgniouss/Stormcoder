/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The git operations behind the Changes view. It shells out to the `git` command line (there is
 * no editor Git extension here) and imports nothing from `vscode`, so it is tested directly.
 *
 * What it will never do, whatever the caller asks: force-push, delete a branch or remote, skip
 * hooks (`--no-verify`), or discard working-tree changes. Paths are checked before they reach git.
 */

/** How long one git command may run before it is killed. Push and pull talk to the network. */
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** The largest diff or file handed to the UI; the rest is cut and flagged. */
const TEXT_CAP = 400_000;
/** Commits listed under "not pushed". */
const UNPUSHED_CAP = 20;
const TREE_CAP = 5000;

/** A problem worth showing the user as it is, with a coarse kind the UI can act on. */
export class GitError extends Error {
	constructor(
		message: string,
		/** `rejected`: remote has newer commits. `identity`: no user.name/email. `hook`: a hook refused. `no-remote`/`detached`/`conflict`/`nothing`: preconditions. */
		readonly kind: 'rejected' | 'identity' | 'hook' | 'no-remote' | 'detached' | 'conflict' | 'nothing' | 'path' | 'failed',
	) {
		super(message);
		this.name = 'GitError';
	}
}

/** One changed path, as the status view lists it. */
export interface RepoFile {
	/** Path relative to the repository root, with forward slashes. */
	readonly path: string;
	/** Where a rename came from. */
	readonly from?: string;
	/** `M`odified, `A`dded (includes untracked), `D`eleted, `R`enamed, `C`onflict. */
	readonly status: 'M' | 'A' | 'D' | 'R' | 'C';
	readonly staged: boolean;
	readonly unstaged: boolean;
	readonly untracked: boolean;
	readonly conflict: boolean;
	/** Lines added and removed across the staged and unstaged changes; null when git does not count them (untracked, binary). */
	readonly added: number | null;
	readonly removed: number | null;
}

/** A commit that exists only locally. */
export interface RepoCommit {
	readonly hash: string;
	readonly subject: string;
}

/** The whole picture the Changes view draws. */
export interface RepoStatus {
	readonly isRepo: boolean;
	/** True when the `git` command itself could not be run. */
	readonly gitMissing?: boolean;
	/** Repository root; every path below is relative to it. */
	readonly root?: string;
	readonly branch?: string;
	readonly detached?: boolean;
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	readonly merging: boolean;
	readonly files: RepoFile[];
	readonly unpushed: RepoCommit[];
	/** The newest commit is local only, so it can be taken back with a soft reset. */
	readonly canUndoCommit: boolean;
	/** The opened folder's path inside the repository ('' when it is the root), for matching paths the chat reports. */
	readonly prefix: string;
}

/** One line of a parsed unified diff. */
export interface DiffRow {
	/** `h`unk header, `c`ontext, `a`dded, `d`eleted. */
	readonly k: 'h' | 'c' | 'a' | 'd';
	readonly o?: number;
	readonly n?: number;
	readonly t: string;
}

/** A file's diff or text, capped for the UI. */
export interface FileDiff {
	readonly rows: DiffRow[];
	readonly binary: boolean;
	readonly truncated: boolean;
}

/** A file's current text. */
export interface FileText {
	readonly text: string;
	readonly binary: boolean;
	readonly truncated: boolean;
}

interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** Runs git and resolves with its output and exit code; rejects only when git cannot be started. */
function run(args: string[], cwd: string, input?: string, timeout = TIMEOUT_MS): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', ['-c', 'color.ui=false', ...args], {
			cwd,
			maxBuffer: MAX_BUFFER,
			windowsHide: true,
			timeout,
			// No prompts: a credential question would hang a window the user cannot see.
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
		}, (err, stdout, stderr) => {
			if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(err);
				return;
			}
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
			resolve({ stdout, stderr, code });
		});
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

/** Runs git and returns stdout; throws a {@link GitError} carrying git's own words when it fails. */
async function ok(args: string[], cwd: string, input?: string): Promise<string> {
	const r = await run(args, cwd, input);
	if (r.code !== 0) {
		throw new GitError(`${r.stderr}${r.stdout}`.trim() || `git ${args[0]} failed`, 'failed');
	}
	return r.stdout;
}

/** The repository root containing `cwd`, or undefined when it is not inside one. */
async function repoRoot(cwd: string): Promise<string | undefined> {
	const r = await run(['rev-parse', '--show-toplevel'], cwd);
	return r.code === 0 ? path.resolve(r.stdout.trim()) : undefined;
}

/**
 * Checks a repository-relative path before it reaches git or the file system: no absolute
 * paths, no `..`, nothing inside `.git`, no NUL. Returns it with forward slashes.
 */
export function safeRelPath(rel: string): string {
	if (typeof rel !== 'string' || !rel || rel.includes('\0')) {
		throw new GitError('That path is not valid.', 'path');
	}
	const norm = rel.replace(/\\/g, '/');
	if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
		throw new GitError('Paths must be inside the project.', 'path');
	}
	const parts = norm.split('/');
	if (parts.some(p => p === '..' || p.toLowerCase() === '.git')) {
		throw new GitError('Paths must be inside the project.', 'path');
	}
	return norm;
}

/** Splits `git diff --numstat -z` output into per-path counts (a rename gives two extra NUL fields). */
function parseNumstat(out: string, into: Map<string, { a: number | null; d: number | null }>): void {
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
		if (!m) {
			continue;
		}
		let file = m[3];
		if (file === '') {
			file = parts[i + 2] ?? '';
			i += 2;
		}
		const add = m[1] === '-' ? null : Number(m[1]);
		const del = m[2] === '-' ? null : Number(m[2]);
		const prev = into.get(file);
		into.set(file, { a: add === null || (prev && prev.a === null) ? null : (prev?.a ?? 0) + add, d: del === null || (prev && prev.d === null) ? null : (prev?.d ?? 0) + del });
	}
}

/** Reads the repository state. Never throws for "not a repository" or "git missing"; those are results. */
export async function status(cwd: string): Promise<RepoStatus> {
	const empty: RepoStatus = { isRepo: false, ahead: 0, behind: 0, merging: false, files: [], unpushed: [], canUndoCommit: false, prefix: '' };
	let root: string | undefined;
	try {
		root = await repoRoot(cwd);
	} catch {
		return { ...empty, gitMissing: true };
	}
	if (!root) {
		return empty;
	}
	const [st, unstagedNum, stagedNum, merge] = await Promise.all([
		ok(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root),
		run(['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv'], root),
		run(['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv'], root),
		run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root),
	]);
	const counts = new Map<string, { a: number | null; d: number | null }>();
	parseNumstat(unstagedNum.stdout, counts);
	parseNumstat(stagedNum.stdout, counts);

	let branch: string | undefined;
	let detached = false;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	const files: RepoFile[] = [];
	const records = st.split('\0');
	for (let i = 0; i < records.length; i++) {
		const rec = records[i];
		if (!rec) {
			continue;
		}
		if (rec.startsWith('# branch.head ')) {
			const head = rec.slice('# branch.head '.length);
			detached = head === '(detached)';
			branch = detached ? undefined : head;
		} else if (rec.startsWith('# branch.upstream ')) {
			upstream = rec.slice('# branch.upstream '.length);
		} else if (rec.startsWith('# branch.ab ')) {
			const m = /\+(\d+) -(\d+)/.exec(rec);
			ahead = m ? Number(m[1]) : 0;
			behind = m ? Number(m[2]) : 0;
		} else if (rec.startsWith('1 ') || rec.startsWith('2 ')) {
			const renamed = rec[0] === '2';
			const fields = rec.split(' ');
			const xy = fields[1];
			const file = fields.slice(renamed ? 9 : 8).join(' ');
			const from = renamed ? records[++i] : undefined;
			const index = xy[0];
			const work = xy[1];
			const c = counts.get(file);
			const code = index !== '.' ? index : work;
			files.push({
				path: file,
				from,
				status: code === 'A' ? 'A' : code === 'D' ? 'D' : code === 'R' ? 'R' : 'M',
				staged: index !== '.',
				unstaged: work !== '.',
				untracked: false,
				conflict: false,
				added: c ? c.a : null,
				removed: c ? c.d : null,
			});
		} else if (rec.startsWith('u ')) {
			const file = rec.split(' ').slice(10).join(' ');
			files.push({ path: file, status: 'C', staged: false, unstaged: true, untracked: false, conflict: true, added: null, removed: null });
		} else if (rec.startsWith('? ')) {
			files.push({ path: rec.slice(2), status: 'A', staged: false, unstaged: true, untracked: true, conflict: false, added: null, removed: null });
		}
	}

	const unpushed = await listUnpushed(root, upstream);
	const canUndoCommit = unpushed.length > 0 && (await run(['rev-parse', '-q', '--verify', 'HEAD~1'], root)).code === 0 && merge.code !== 0;
	let prefix = '';
	try {
		prefix = path.relative(fs.realpathSync(root), fs.realpathSync(cwd)).split(path.sep).join('/');
	} catch {
		prefix = '';
	}
	return { isRepo: true, root, branch, detached, upstream, ahead, behind, merging: merge.code === 0, files, unpushed, canUndoCommit, prefix: prefix.startsWith('..') ? '' : prefix };
}

async function listUnpushed(root: string, upstream: string | undefined): Promise<RepoCommit[]> {
	const range = upstream ? [`${upstream}..HEAD`] : ['HEAD', '--not', '--remotes'];
	const r = await run(['log', ...range, `--max-count=${UNPUSHED_CAP}`, '--format=%h%x00%s'], root);
	if (r.code !== 0) {
		return [];
	}
	return r.stdout.split('\n').filter(Boolean).map(line => {
		const [hash, subject] = line.split('\0');
		return { hash, subject: subject ?? '' };
	});
}

/** Parses a unified diff into rows; everything before the first hunk header is dropped. */
export function parseUnifiedDiff(text: string): FileDiff {
	if (/^Binary files .* differ$/m.test(text) || /^GIT binary patch/m.test(text)) {
		return { rows: [], binary: true, truncated: false };
	}
	let truncated = false;
	if (text.length > TEXT_CAP) {
		text = text.slice(0, TEXT_CAP);
		truncated = true;
	}
	const rows: DiffRow[] = [];
	let o = 0;
	let n = 0;
	let inHunk = false;
	for (const line of text.split('\n')) {
		const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (h) {
			o = Number(h[1]);
			n = Number(h[2]);
			inHunk = true;
			rows.push({ k: 'h', t: line });
		} else if (!inHunk || line.startsWith('\\')) {
			continue;
		} else if (line.startsWith('+')) {
			rows.push({ k: 'a', n: n++, t: line.slice(1) });
		} else if (line.startsWith('-')) {
			rows.push({ k: 'd', o: o++, t: line.slice(1) });
		} else if (line.startsWith(' ')) {
			rows.push({ k: 'c', o: o++, n: n++, t: line.slice(1) });
		}
	}
	return { rows, binary: false, truncated };
}

/** True when `abs` is a symbolic link, which the viewer refuses (it could point outside the project). */
function isSymlink(abs: string): boolean {
	try {
		return fs.lstatSync(abs).isSymbolicLink();
	} catch {
		return false;
	}
}

/** The diff of one file: `staged` (index vs HEAD), `unstaged` (working tree vs index) or `untracked` (whole file as added). */
export async function diff(cwd: string, rel: string, area: 'staged' | 'unstaged' | 'untracked'): Promise<FileDiff> {
	const root = await repoRoot(cwd);
	if (!root) {
		throw new GitError('This folder is not a git repository.', 'failed');
	}
	const file = safeRelPath(rel);
	const common = ['--no-color', '--no-ext-diff', '--no-textconv', '-U3'];
	let r: RunResult;
	if (area === 'untracked') {
		if (isSymlink(path.join(root, file))) {
			return { rows: [], binary: false, truncated: false };
		}
		// `--no-index` exits 1 when the files differ, which is the normal case here.
		r = await run(['diff', '--no-index', ...common, '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], root);
	} else {
		r = await run(['diff', ...(area === 'staged' ? ['--cached'] : []), ...common, '--', file], root);
	}
	return parseUnifiedDiff(r.stdout);
}

/** The current text of a file in the project, for the Files tab. Refuses links, folders and anything outside the repository. */
export async function fileText(cwd: string, rel: string): Promise<FileText> {
	const root = (await repoRoot(cwd)) ?? path.resolve(cwd);
	const file = safeRelPath(rel);
	const abs = path.join(root, file);
	if (isSymlink(abs)) {
		throw new GitError('Links are not opened here.', 'path');
	}
	const real = fs.realpathSync(abs);
	if (!real.startsWith(fs.realpathSync(root) + path.sep)) {
		throw new GitError('Paths must be inside the project.', 'path');
	}
	const stat = fs.statSync(real);
	if (!stat.isFile()) {
		throw new GitError('That is not a file.', 'path');
	}
	const fd = fs.openSync(real, 'r');
	try {
		const buf = Buffer.alloc(Math.min(stat.size, TEXT_CAP));
		fs.readSync(fd, buf, 0, buf.length, 0);
		if (buf.includes(0)) {
			return { text: '', binary: true, truncated: false };
		}
		return { text: buf.toString('utf8'), binary: false, truncated: stat.size > TEXT_CAP };
	} finally {
		fs.closeSync(fd);
	}
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.stormcoder']);

/** Every file in the project (tracked and untracked, minus ignored ones), relative paths, capped. */
export async function listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean }> {
	let root: string | undefined;
	try {
		root = await repoRoot(cwd);
	} catch {
		root = undefined;
	}
	let files: string[];
	if (root) {
		const out = await ok(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
		files = [...new Set(out.split('\0').filter(Boolean))].sort();
	} else {
		files = [];
		const walk = (dir: string, prefix: string): void => {
			if (files.length > TREE_CAP) {
				return;
			}
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
					walk(path.join(dir, e.name), `${prefix}${e.name}/`);
				} else if (e.isFile()) {
					files.push(`${prefix}${e.name}`);
				}
			}
		};
		walk(cwd, '');
		files.sort();
	}
	return { files: files.slice(0, TREE_CAP), truncated: files.length > TREE_CAP };
}

/** Stages the given paths (including deletions). */
export async function stage(cwd: string, paths: string[]): Promise<void> {
	const root = await requireRoot(cwd);
	await ok(['add', '-A', '--', ...paths.map(safeRelPath)], root);
}

/** Takes the given paths out of the index; the working tree is untouched. */
export async function unstage(cwd: string, paths: string[]): Promise<void> {
	const root = await requireRoot(cwd);
	await ok(['reset', '-q', '--', ...paths.map(safeRelPath)], root);
}

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) {
		throw new GitError('This folder is not a git repository.', 'failed');
	}
	return root;
}

/** Classifies a failed commit or push from git's own words. */
function classify(output: string, fallback: GitError['kind']): GitError['kind'] {
	if (/tell me who you are|empty ident name|unable to auto-detect email/i.test(output)) {
		return 'identity';
	}
	if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(output)) {
		return 'rejected';
	}
	return fallback;
}

/** True when the repository has a hook that can veto a commit. A hook's output is its own words, so the failure is recognised by the hook existing, not by the text. */
async function hasCommitHook(root: string): Promise<boolean> {
	const r = await run(['rev-parse', '--git-path', 'hooks'], root);
	if (r.code !== 0) {
		return false;
	}
	const dir = path.resolve(root, r.stdout.trim());
	return ['pre-commit', 'prepare-commit-msg', 'commit-msg'].some(name => fs.existsSync(path.join(dir, name)));
}

/** Commits what is staged with `message`. Hooks run; they are never skipped. */
export async function commit(cwd: string, message: string): Promise<{ hash: string }> {
	const root = await requireRoot(cwd);
	const text = message.trim();
	if (!text) {
		throw new GitError('Write a commit message first.', 'nothing');
	}
	const st = await status(root);
	if (st.merging && st.files.some(f => f.conflict)) {
		throw new GitError('Resolve the conflicts before committing.', 'conflict');
	}
	if (!st.files.some(f => f.staged)) {
		throw new GitError('Nothing is staged.', 'nothing');
	}
	const r = await run(['commit', '-F', '-'], root, text + '\n');
	if (r.code !== 0) {
		const output = `${r.stderr}${r.stdout}`.trim();
		const kind = classify(output, 'failed');
		throw new GitError(output || 'git commit failed', kind === 'failed' && await hasCommitHook(root) ? 'hook' : kind);
	}
	return { hash: (await ok(['rev-parse', '--short', 'HEAD'], root)).trim() };
}

/**
 * Pushes the current branch with a plain `git push`, or with `publish` creates its upstream on
 * `origin` (or the only remote). Has no way to force.
 */
export async function push(cwd: string, publish: boolean): Promise<{ target: string }> {
	const root = await requireRoot(cwd);
	const st = await status(root);
	if (!st.branch) {
		throw new GitError('Check out a branch before pushing.', 'detached');
	}
	let args: string[];
	let target: string;
	if (st.upstream) {
		args = ['push'];
		target = st.upstream;
	} else if (publish) {
		const remotes = (await ok(['remote'], root)).split('\n').filter(Boolean);
		const remote = remotes.includes('origin') ? 'origin' : remotes[0];
		if (!remote) {
			throw new GitError('This repository has no remote to push to.', 'no-remote');
		}
		args = ['push', '--set-upstream', remote, st.branch];
		target = `${remote}/${st.branch}`;
	} else {
		throw new GitError('This branch is not on a remote yet. Publish it first.', 'no-remote');
	}
	const r = await run(args, root);
	if (r.code !== 0) {
		const output = `${r.stderr}${r.stdout}`.trim();
		throw new GitError(output || 'git push failed', classify(output, 'failed'));
	}
	return { target };
}

/** Brings in the upstream's commits, only when that is a fast-forward (no merge commit, no rebase). */
export async function pull(cwd: string): Promise<void> {
	const root = await requireRoot(cwd);
	const r = await run(['pull', '--ff-only'], root);
	if (r.code !== 0) {
		throw new GitError(`${r.stderr}${r.stdout}`.trim() || 'git pull failed', 'failed');
	}
}

/** Takes back the newest commit, keeping its changes staged. Only for a commit that is not pushed yet. */
export async function undoCommit(cwd: string): Promise<void> {
	const root = await requireRoot(cwd);
	const st = await status(root);
	if (!st.canUndoCommit) {
		throw new GitError('The newest commit is already pushed or is the first one, so it cannot be undone here.', 'nothing');
	}
	await ok(['reset', '--soft', 'HEAD~1'], root);
}

/** Abandons a merge in progress. */
export async function abortMerge(cwd: string): Promise<void> {
	const root = await requireRoot(cwd);
	await ok(['merge', '--abort'], root);
}

/** The staged diff as text, for drafting a commit message. */
export async function stagedDiff(cwd: string): Promise<string> {
	const root = await requireRoot(cwd);
	return ok(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv'], root);
}
