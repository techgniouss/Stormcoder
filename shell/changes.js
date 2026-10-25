// The Changes view: what changed in the project, a diff or the file for each, and the git steps
// to get it out (stage, commit, push). It talks to the host through `git.*` commands, which
// answer { ok, value } or { ok: false, error, kind }. Every string from git or the file system
// is written with textContent.
(function () {
	'use strict';
	const api = window.stormcoder;
	const root = document.getElementById('view-changes');
	if (!api || !root) { return; }

	/** @type {any} Latest repository status, or null before the first answer. */
	let st = null;
	/** The latest answer's problem, shown instead of the list (git missing, no folder). */
	let fatal = '';
	let tab = 'changes';
	/** @type {{ path: string, area: string } | null} */
	let sel = null;
	let mode = 'diff';
	let message = '';
	let drafting = false;
	let busy = '';
	/** @type {{ level: string, text: string, detail?: string, action?: { label: string, run: () => void } } | null} */
	let banner = null;
	/** @type {{ title: string, rows: string[][], label: string, danger?: boolean, run: () => void } | null} A question the git bar is asking before it does something it cannot take back. */
	let confirm = null;
	let docked = false;
	/** The stash open in the right-hand pane, as its ref. */
	let stashSel = '';
	/** A chat run is in flight; stashing then would pull files out from under the agent. */
	let running = false;
	/** Paths the agent changed in this session, as the chat reported them. */
	const agentFiles = new Set();
	/** @type {{ files: string[], truncated: boolean } | null} */
	let tree = null;
	let treeSel = '';
	/** Newest request wins when the user clicks faster than git answers. */
	let viewToken = 0;
	let canWrite = false;
	let viewShowing = false;
	/** Whether the open folder is trusted; staging, commit and push are off when it is not. */
	let trusted = true;

	const slot = {};

	/**
	 * @param {string} tag
	 * @param {string} [cls]
	 * @param {string} [text]
	 */
	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text !== undefined) { n.textContent = text; }
		return n;
	}

	/**
	 * @param {string} label
	 * @param {string} cls
	 * @param {() => void} onClick
	 * @param {boolean} [disabled]
	 */
	function button(label, cls, onClick, disabled) {
		const b = el('button', 'btn ' + cls, label);
		b.type = 'button';
		b.disabled = !!disabled;
		b.addEventListener('click', onClick);
		return b;
	}

	/**
	 * Calls a git command; failures resolve as { ok: false } rather than throwing.
	 * @param {string} op
	 * @param {...any} args
	 */
	async function git(op, ...args) {
		try {
			return await api.command('git.' + op, ...args);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'failed' };
		}
	}

	/** The repository-relative form of a path the chat reported (relative to the opened folder). @param {string} p */
	function agentKey(p) { return st && st.prefix ? st.prefix + '/' + p : p; }
	/** @param {string} p */
	function isAgent(p) { return agentFiles.has(p) || (!!st && !!st.prefix && agentFiles.has(p.slice(st.prefix.length + 1))); }

	function baseName(p) { return p.split('/').pop() || p; }
	function dirName(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

	// ------------------------------------------------------------------ data

	/** Re-reads the repository. Cheap enough to call on focus and after every action. */
	async function refresh() {
		const res = await git('status');
		if (!res.ok) {
			st = null;
			fatal = res.error;
		} else {
			st = res.value;
			fatal = '';
			if (st.gitMissing) { fatal = 'Git is not installed or not on the PATH.'; }
		}
		const count = st && st.isRepo ? st.files.length : 0;
		const badge = document.getElementById('changesBadge');
		if (badge) {
			badge.textContent = count > 99 ? '99+' : String(count);
			badge.classList.toggle('hidden', count === 0);
		}
		if (st && st.isRepo) {
			if (stashSel && !st.stashList.some(x => x.ref === stashSel)) { stashSel = ''; }
			const present = sel && st.files.some(f => f.path === sel.path && areaValid(f, sel.area));
			if (!present) { sel = firstSelection(); }
			if (confirm && confirm.title === 'Push to origin?' && st.unpushed.length === 0) { confirm = null; }
		}
		if (viewShowing) { render(); }
	}

	/** @param {any} f @param {string} area */
	function areaValid(f, area) {
		return area === 'staged' ? f.staged : area === 'conflict' ? f.conflict : !!(f.unstaged && !f.conflict);
	}

	function firstSelection() {
		if (!st) { return null; }
		const c = st.files.find(f => f.conflict);
		if (c) { return { path: c.path, area: 'conflict' }; }
		const u = st.files.find(f => f.unstaged);
		if (u) { return { path: u.path, area: 'unstaged' }; }
		const s = st.files.find(f => f.staged);
		return s ? { path: s.path, area: 'staged' } : null;
	}

	/** @param {string} id */
	function fileFor(id) { return st && st.files.find(f => f.path === id); }

	// ------------------------------------------------------------------ rendering

	function build() {
		root.textContent = '';
		const tabs = el('div', 'ch-tabs');
		tabs.setAttribute('role', 'tablist');
		slot.tabs = tabs;
		const body = el('div', 'ch-body');
		slot.list = el('div', 'ch-list');
		const pane = el('div', 'ch-pane');
		slot.head = el('div', 'ch-pane-head');
		slot.code = el('div', 'ch-code');
		slot.code.tabIndex = 0;
		pane.append(slot.head, slot.code);
		body.append(slot.list, pane);
		slot.git = el('div', 'ch-git');
		root.append(tabs, body, slot.git);
	}

	function render() {
		canWrite = !!(st && st.isRepo) && trusted;
		renderTabs();
		if (!st || !st.isRepo) {
			renderNoRepo();
			return;
		}
		slot.list.classList.toggle('ch-tree', tab === 'files');
		if (tab === 'files') {
			renderTree();
			renderFileHead();
			slot.git.classList.add('hidden');
			return;
		}
		slot.git.classList.remove('hidden');
		renderList();
		renderHead();
		renderGit();
		loadView();
	}

	function renderTabs() {
		const t = slot.tabs;
		t.textContent = '';
		const add = (key, label, count) => {
			const b = el('button', 'ch-tab' + (tab === key ? ' on' : ''), label);
			b.type = 'button';
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', String(tab === key));
			if (count) { b.append(el('span', 'ch-pill', String(count))); }
			b.addEventListener('click', () => { tab = key; if (key === 'files' && !tree) { void loadTree(); } render(); });
			t.append(b);
		};
		add('changes', 'Changes', st && st.isRepo ? st.files.length : 0);
		add('files', 'Files', 0);
		t.append(el('span', 'ch-spacer'));
		if (window.innerWidth >= 1000) {
			const dock = button(docked ? 'Undock' : 'Dock beside chat', 'ch-link', () => window.dispatchEvent(new CustomEvent('changes-dock')));
			dock.classList.add('ch-dock');
			t.append(dock);
		}
		if (st && st.isRepo) {
			const sync = !st.branch ? 'detached HEAD' : !st.upstream ? 'not published' : st.ahead || st.behind ? `${st.ahead} ahead, ${st.behind} behind` : 'in sync with origin';
			t.append(el('span', 'ch-branch', st.branch || 'detached'), el('span', 'ch-sync', sync + (st.stashes ? `, ${st.stashes} stash${st.stashes === 1 ? '' : 'es'}` : '')));
		}
	}

	function renderNoRepo() {
		slot.git.classList.add('hidden');
		slot.list.textContent = '';
		slot.head.textContent = '';
		slot.code.textContent = '';
		const box = el('div', 'ch-empty');
		let title = 'No git here';
		let text = 'This folder is not a git repository. You can still read its files; initialising one is left to you.';
		if (fatal && !(st && st.gitMissing)) { title = 'Cannot read the project'; text = fatal; }
		if (st && st.gitMissing) { title = 'Git is missing'; text = 'Install git and restart Stormcoder to use this view.'; }
		box.append(el('strong', '', title), el('span', '', text));
		slot.list.append(box);
		if (tab === 'files' || (st && !st.isRepo && !st.gitMissing)) {
			if (!tree) { void loadTree(); }
			if (tab === 'files') { renderTree(); }
		}
	}

	/** @param {string} title @param {any[]} files @param {string} area @param {string} action @param {() => void} onAll @param {string} [extra] @param {() => void} [onExtra] */
	function group(title, files, area, action, onAll, extra, onExtra) {
		const head = el('div', 'ch-group');
		head.append(el('span', '', `${title} (${files.length})`));
		if (canWrite && (action || extra)) {
			const links = el('span', 'ch-links');
			if (extra && onExtra) { links.append(button(extra, 'ch-link ch-link-danger', onExtra)); }
			if (action) { links.append(button(action, 'ch-link', onAll)); }
			head.append(links);
		}
		slot.list.append(head);
		for (const f of files) { slot.list.append(row(f, area)); }
	}

	/** @param {any} f @param {string} area */
	function row(f, area) {
		const on = !stashSel && sel && sel.path === f.path && sel.area === area;
		const r = el('div', 'ch-row' + (on ? ' on' : ''));
		r.tabIndex = 0;
		r.setAttribute('role', 'button');
		if (area !== 'conflict') {
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.className = 'ch-check';
			box.checked = area === 'staged';
			box.disabled = !canWrite || !!busy;
			box.setAttribute('aria-label', (area === 'staged' ? 'Unstage ' : 'Stage ') + f.path);
			box.addEventListener('click', e => { e.stopPropagation(); void act(area === 'staged' ? 'unstage' : 'stage', [f.path]); });
			r.append(box);
		}
		r.append(el('span', 'ch-st ch-st-' + f.status, f.status));
		const name = el('span', 'ch-name', baseName(f.path));
		name.title = f.path;
		r.append(name);
		if (isAgent(f.path)) { r.append(el('span', 'ch-tag', 'agent')); }
		if (f.conflict) {
			r.append(el('span', 'ch-count ch-del', 'conflict'));
		} else if (f.added !== null || f.removed !== null) {
			if (f.added) { r.append(el('span', 'ch-count ch-add', '+' + f.added)); }
			if (f.removed) { r.append(el('span', 'ch-count ch-del', '−' + f.removed)); }
		}
		const select = () => { sel = { path: f.path, area: area }; stashSel = ''; mode = 'diff'; render(); };
		r.addEventListener('click', select);
		r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
		return r;
	}

	function renderList() {
		slot.list.textContent = '';
		const files = st.files;
		const conflicts = files.filter(f => f.conflict);
		const staged = files.filter(f => f.staged);
		const unstaged = files.filter(f => f.unstaged && !f.conflict);
		if (!files.length) {
			const box = el('div', 'ch-empty');
			box.append(el('strong', '', 'Working tree clean'), el('span', '', st.unpushed.length ? 'Nothing to stage. Your commit is local until you push it.' : 'Nothing has changed since the last commit.'));
			slot.list.append(box);
		}
		if (conflicts.length) { group('Conflicts', conflicts, 'conflict', '', () => { /* none */ }); }
		if (staged.length) { group('Staged', staged, 'staged', 'Unstage all', () => void act('unstage', staged.map(f => f.path))); }
		if (unstaged.length) { group('Not staged', unstaged, 'unstaged', 'Stage all', () => void act('stage', unstaged.map(f => f.path)), 'Discard all', () => askDiscard(unstaged)); }
		if (st.unpushed.length) {
			const head = el('div', 'ch-group');
			head.append(el('span', '', `Not pushed (${st.unpushed.length})`));
			slot.list.append(head);
			for (const c of st.unpushed) {
				const r = el('div', 'ch-commit');
				r.append(el('code', '', c.hash), el('span', '', c.subject));
				slot.list.append(r);
			}
		}
		if (st.stashList.length) {
			const head = el('div', 'ch-group');
			head.append(el('span', '', `Stashes (${st.stashList.length})`));
			slot.list.append(head);
			for (const entry of st.stashList) { slot.list.append(stashRow(entry)); }
		}
	}

	/** @param {any} entry */
	function stashRow(entry) {
		const r = el('div', 'ch-row' + (stashSel === entry.ref ? ' on' : ''));
		r.tabIndex = 0;
		r.setAttribute('role', 'button');
		const name = el('span', 'ch-name', entry.message || entry.ref);
		name.title = entry.ref;
		r.append(name, el('span', 'ch-when', entry.when));
		const open = () => { stashSel = entry.ref; render(); };
		r.addEventListener('click', open);
		r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
		return r;
	}

	function renderHead() {
		slot.head.textContent = '';
		if (stashSel) {
			const entry = st.stashList.find(x => x.ref === stashSel);
			slot.head.append(el('code', 'ch-path', entry ? entry.message : stashSel), el('span', 'ch-spacer'));
			if (canWrite) {
				const off = running || !!busy;
				const tip = running ? 'Wait for the run to finish' : '';
				const mk = (label, cls, fn) => { const b = button(label, cls, fn, off); if (tip) { b.title = tip; } return b; };
				slot.head.append(
					mk('Apply', 'ch-link', () => void act('stashApply', [stashSel])),
					mk('Pop', 'ch-link', () => void act('stashPop', [stashSel])),
					mk('Drop', 'ch-link ch-link-danger', () => askDropStash(stashSel)));
			}
			return;
		}
		if (!sel) { return; }
		const path = el('code', 'ch-path', sel.path);
		const seg = el('div', 'ch-seg');
		seg.setAttribute('role', 'group');
		seg.setAttribute('aria-label', 'View');
		for (const [key, label] of [['diff', 'Diff'], ['file', 'File']]) {
			const b = el('button', mode === key ? 'on' : '', label);
			b.type = 'button';
			b.addEventListener('click', () => { mode = key; renderHead(); loadView(); });
			seg.append(b);
		}
		slot.head.append(path, el('span', 'ch-spacer'));
		const cur = fileFor(sel.path);
		if (canWrite && cur && sel.area === 'unstaged') { slot.head.append(button('Discard', 'ch-link ch-link-danger', () => askDiscard([cur]))); }
		slot.head.append(seg);
	}

	function renderFileHead() {
		slot.head.textContent = '';
		if (treeSel) { slot.head.append(el('code', 'ch-path', treeSel)); }
	}

	/** Fills the code pane for the current selection. */
	async function loadView() {
		const token = ++viewToken;
		const pane = slot.code;
		if (stashSel) {
			const shown = await git('stashShow', stashSel);
			if (token !== viewToken) { return; }
			pane.textContent = '';
			if (!shown.ok) { pane.append(el('div', 'ch-empty', shown.error)); return; }
			if (!shown.value.files.length) { pane.append(el('div', 'ch-empty', 'This stash holds no line changes.')); return; }
			for (const f of shown.value.files) {
				pane.append(el('div', 'ch-filehead', f.path));
				if (f.binary) { pane.append(el('div', 'ch-note', 'Binary file.')); continue; }
				for (const r of f.rows) {
					pane.append(r.k === 'h' ? el('div', 'ch-hunk', r.t) : codeLine(r.k, r.o === undefined ? '' : String(r.o), r.n === undefined ? '' : String(r.n), r.t));
				}
			}
			if (shown.value.truncated) { pane.append(el('div', 'ch-note', 'Showing the first part of a large stash.')); }
			return;
		}
		if (!sel) {
			pane.textContent = '';
			pane.append(el('div', 'ch-empty', 'Select a file to see what changed.'));
			return;
		}
		const f = fileFor(sel.path);
		const wantFile = mode === 'file';
		if (wantFile && f && f.status === 'D') {
			pane.textContent = '';
			pane.append(el('div', 'ch-empty', 'This file was deleted. Switch to Diff to see what it held.'));
			return;
		}
		const res = wantFile
			? await git('file', sel.path)
			: await git('diff', sel.path, sel.area === 'staged' ? 'staged' : f && f.untracked ? 'untracked' : 'unstaged');
		if (token !== viewToken) { return; }
		pane.textContent = '';
		if (!res.ok) { pane.append(el('div', 'ch-empty', res.error)); return; }
		if (wantFile) { drawText(pane, res.value); } else { drawDiff(pane, res.value, sel.area, sel.path); }
	}

	/** @param {HTMLElement} pane @param {any} v */
	function drawText(pane, v) {
		if (v.binary) { pane.append(el('div', 'ch-empty', 'Binary file.')); return; }
		const lines = v.text.split('\n');
		if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
		const frag = document.createDocumentFragment();
		lines.forEach((t, i) => frag.append(codeLine('', String(i + 1), '', t)));
		pane.append(frag);
		if (v.truncated) { pane.append(el('div', 'ch-note', 'Showing the first part of a large file.')); }
	}

	/** @param {HTMLElement} pane @param {any} v @param {string} area @param {string} file */
	function drawDiff(pane, v, area, file) {
		if (v.binary) { pane.append(el('div', 'ch-empty', 'Binary file changed.')); return; }
		if (!v.rows.length) { pane.append(el('div', 'ch-empty', 'No line changes to show (mode change, or an empty file).')); return; }
		const frag = document.createDocumentFragment();
		for (const r of v.rows) {
			if (r.k === 'h') {
				const h = el('div', 'ch-hunk');
				h.append(el('span', '', r.t));
				if (v.hunkable && canWrite && (area === 'staged' || area === 'unstaged')) {
					h.append(button(area === 'staged' ? 'Unstage hunk' : 'Stage hunk', 'ch-link', () => void act('stageHunk', [file, area, r.i, r.t])));
				}
				frag.append(h);
				continue;
			}
			frag.append(codeLine(r.k, r.o === undefined ? '' : String(r.o), r.n === undefined ? '' : String(r.n), r.t));
		}
		pane.append(frag);
		if (v.truncated) { pane.append(el('div', 'ch-note', 'Showing the first part of a large diff.')); }
	}

	/** @param {string} kind @param {string} o @param {string} n @param {string} text */
	function codeLine(kind, o, n, text) {
		const line = el('div', 'ch-ln' + (kind === 'a' ? ' ch-a' : kind === 'd' ? ' ch-d' : ''));
		line.append(el('i', '', o), el('i', '', n), el('b', '', kind === 'a' ? '+' : kind === 'd' ? '−' : ''), el('span', '', text));
		return line;
	}

	// ------------------------------------------------------------------ files tab

	async function loadTree() {
		const res = await git('files');
		tree = res.ok ? res.value : { files: [], truncated: false };
		if (tab === 'files') { render(); }
	}

	function renderTree() {
		slot.list.textContent = '';
		if (!tree) { slot.list.append(el('div', 'ch-empty', 'Reading the project…')); return; }
		const changed = new Map((st && st.isRepo ? st.files : []).map(f => [f.path, f.status]));
		const frag = document.createDocumentFragment();
		const seen = new Set();
		for (const p of tree.files) {
			const parts = p.split('/');
			let acc = '';
			for (let i = 0; i < parts.length - 1; i++) {
				acc += parts[i] + '/';
				if (!seen.has(acc)) { seen.add(acc); frag.append(treeRow(parts[i] + '/', i, '', true)); }
			}
			frag.append(treeRow(parts[parts.length - 1], parts.length - 1, p, false, changed.get(p)));
		}
		slot.list.append(frag);
		if (tree.truncated) { slot.list.append(el('div', 'ch-note', 'Showing the first part of a large project.')); }
	}

	/** @param {string} label @param {number} depth @param {string} path @param {boolean} dir @param {string} [status] */
	function treeRow(label, depth, path, dir, status) {
		const r = el('div', 'ch-row ch-tree-row' + (dir ? ' ch-dir' : '') + (!dir && path === treeSel ? ' on' : ''));
		r.style.paddingLeft = (12 + depth * 14) + 'px';
		r.append(el('span', 'ch-name', label));
		if (status) { r.append(el('span', 'ch-st ch-st-' + status, status)); }
		if (!dir) {
			r.tabIndex = 0;
			r.setAttribute('role', 'button');
			const open = () => { void openTreeFile(path); };
			r.addEventListener('click', open);
			r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
		}
		return r;
	}

	/** @param {string} path */
	async function openTreeFile(path) {
		treeSel = path;
		renderTree();
		renderFileHead();
		const token = ++viewToken;
		const res = await git('file', path);
		if (token !== viewToken) { return; }
		slot.code.textContent = '';
		if (!res.ok) { slot.code.append(el('div', 'ch-empty', res.error)); return; }
		drawText(slot.code, res.value);
	}

	// ------------------------------------------------------------------ git bar

	function renderGit() {
		const g = slot.git;
		g.textContent = '';
		const stagedCount = st.files.filter(f => f.staged).length;
		const hasConflict = st.files.some(f => f.conflict);

		if (!trusted) {
			g.append(note('warn', 'Read-only', 'This folder is not trusted. You can view diffs only.'));
			return;
		}
		if (st.merging) {
			g.append(note('warn', 'Merge in progress', hasConflict ? 'Commit is disabled until the conflicts are resolved.' : 'Commit to finish the merge.'));
		}
		if (banner) {
			const n = note(banner.level, banner.text, banner.detail);
			if (banner.action) { n.append(button(banner.action.label, 'ch-link', banner.action.run)); }
			g.append(n);
		}

		if (confirm) {
			const dlg = el('div', 'ch-confirm');
			dlg.append(el('strong', '', confirm.title));
			const kv = el('div', 'ch-kv');
			for (const [k, v] of confirm.rows) { kv.append(el('i', '', k), el('span', '', v)); }
			dlg.append(kv);
			const row2 = el('div', 'ch-actions');
			const ask = confirm;
			row2.append(el('span', 'ch-spacer'), button('Cancel', '', () => { confirm = null; renderGit(); }), button(ask.label, ask.danger ? 'ch-danger' : 'btn-primary', () => { confirm = null; ask.run(); }));
			dlg.append(row2);
			g.append(dlg);
			return;
		}

		if (stagedCount || message || drafting) {
			const box = document.createElement('textarea');
			box.className = 'ch-msg';
			box.rows = 3;
			box.value = message;
			box.placeholder = drafting ? 'Reading the staged diff…' : 'Commit message (or press Generate)';
			box.disabled = drafting;
			box.setAttribute('aria-label', 'Commit message');
			box.addEventListener('input', () => { message = box.value; commitBtn.disabled = !canCommit(); });
			g.append(box);
		}

		const acts = el('div', 'ch-actions');
		const info = stagedCount ? `${stagedCount} staged` : st.unpushed.length ? `${st.ahead || st.unpushed.length} ahead of ${st.upstream || 'origin'}` : '0 staged';
		acts.append(el('span', 'ch-info', info));
		if (!drafting && st.files.length && !st.merging) {
			const stashBtn = button('Stash', 'ch-link', () => void act('stash', []), running || !!busy);
			if (running) { stashBtn.title = 'Wait for the run to finish'; }
			acts.append(stashBtn);
		}
		acts.append(el('span', 'ch-spacer'));
		if (drafting) {
			acts.append(button('Cancel', '', () => { void git('cancelDraft'); }));
		} else if (stagedCount) {
			acts.append(button(message.trim() ? 'Regenerate' : 'Generate', '', () => void draft(), !!busy));
		}
		commitBtn = button(stagedCount ? `Commit ${stagedCount}` : 'Commit', stagedCount || !st.unpushed.length ? 'btn-primary' : '', () => void doCommit());
		commitBtn.disabled = !canCommit();
		if (st.files.length) { acts.append(commitBtn); }
		if (!st.merging) {
			if (!st.upstream && st.branch) {
				acts.append(button('Publish branch', stagedCount ? '' : 'btn-primary', () => askPush(), !!busy));
			} else if (st.unpushed.length) {
				acts.append(button(`Push ${st.unpushed.length}`, stagedCount ? '' : 'btn-primary', () => askPush(), !!busy));
			}
		}
		g.append(acts);

		const canPr = !!st.upstream && !st.unpushed.length && !!st.branch && !/^(main|master)$/.test(st.branch);
		if (st.canUndoCommit || st.merging || st.behind || canPr) {
			const p = el('div', 'ch-actions');
			if (st.canUndoCommit) { p.append(button('Undo commit', '', () => void act('undoCommit', []), !!busy)); }
			if (st.merging) { p.append(button('Abort merge', 'ch-danger', () => void act('abortMerge', []), !!busy)); }
			p.append(el('span', 'ch-spacer'));
			if (st.behind) { p.append(button('Pull', '', () => void act('pull', []), !!busy)); }
			if (canPr) { p.append(button('Open pull request', '', () => void openPR())); }
			g.append(p);
		}
	}

	/** Asks before a push or publish; the dialog names the target and says force is never used. */
	function askPush() {
		const target = st.upstream || (st.branch ? 'origin/' + st.branch : '');
		confirm = {
			title: 'Push to origin?',
			rows: [['To', target], ['Sends', `${st.unpushed.length} commit${st.unpushed.length === 1 ? '' : 's'}`], ['Force', 'never']],
			label: st.upstream ? 'Confirm push' : 'Confirm publish',
			run: () => void doPush(),
		};
		renderGit();
	}

	/** Asks before throwing away working-tree changes, which cannot be taken back. @param {any[]} files */
	function askDiscard(files) {
		const names = files.map(f => f.path);
		confirm = {
			title: 'Discard changes?',
			rows: [['Files', names.length === 1 ? names[0] : `${names.length} files (${names.slice(0, 2).map(baseName).join(', ')}…)`], ['Effect', 'back to the staged or committed text; new files are deleted'], ['Undo', 'not possible']],
			label: 'Discard',
			danger: true,
			run: () => void act('discard', [names]),
		};
		renderGit();
	}

	/** Asks before a stash is deleted for good. @param {string} ref */
	function askDropStash(ref) {
		const entry = st.stashList.find(x => x.ref === ref);
		confirm = {
			title: 'Drop this stash?',
			rows: [['Stash', entry ? entry.message : ref], ['Saved', entry ? entry.when : ''], ['Undo', 'not possible']],
			label: 'Drop stash',
			danger: true,
			run: () => void act('stashDrop', [ref]),
		};
		renderGit();
	}

	async function openPR() {
		const res = await git('prUrl');
		if (!res.ok) { banner = { level: 'err', text: res.error }; renderGit(); return; }
		window.open(res.value, '_blank', 'noopener');
	}

	/** @type {HTMLButtonElement} */
	let commitBtn;

	function canCommit() {
		if (!st || busy || drafting) { return false; }
		if (st.files.some(f => f.conflict)) { return false; }
		return st.files.some(f => f.staged) && message.trim().length > 0;
	}

	/** @param {string} level @param {string} text @param {string} [detail] */
	function note(level, text, detail) {
		const n = el('div', 'ch-note-box ch-' + level);
		n.setAttribute('role', level === 'err' ? 'alert' : 'status');
		n.append(el('b', '', text));
		if (detail) { n.append(el('span', '', detail)); }
		return n;
	}

	// ------------------------------------------------------------------ actions

	/** Runs a stage/unstage-style call, then re-reads the repository. @param {string} op @param {any[]} args */
	async function act(op, args) {
		if (busy) { return; }
		busy = op;
		banner = null;
		const res = await git(op, ...args);
		busy = '';
		if (!res.ok) { banner = { level: 'err', text: res.error.split('\n')[0], detail: res.error.split('\n').slice(1, 6).join('\n') }; }
		else if (op === 'undoCommit') { banner = { level: 'ok', text: 'Commit undone; its changes are staged again.' }; }
		else if (op === 'pull') { banner = { level: 'ok', text: 'Pulled the latest commits.' }; }
		else if (op === 'stash') { banner = { level: 'ok', text: 'Stashed your changes. Find them under Stashes.' }; }
		else if (op === 'stashApply') { banner = { level: 'ok', text: 'Stash applied. It is still on the list.' }; }
		else if (op === 'stashPop') { banner = { level: 'ok', text: 'Stash applied and removed from the list.' }; stashSel = ''; }
		else if (op === 'stashDrop') { banner = { level: 'ok', text: 'Stash dropped.' }; stashSel = ''; }
		else if (op === 'discard') { banner = { level: 'ok', text: 'Changes discarded.' }; }
		await refresh();
		if (!viewShowing) { return; }
		render();
	}

	async function draft() {
		drafting = true;
		banner = null;
		renderGit();
		const res = await git('draft');
		drafting = false;
		if (res.ok) { message = String(res.value); banner = { level: 'inf', text: 'Message written from the staged diff. Edit it before committing if you like.' }; }
		else if (res.error !== 'Cancelled.') { banner = { level: 'err', text: res.error }; }
		renderGit();
	}

	async function doCommit() {
		if (!canCommit()) { return; }
		busy = 'commit';
		banner = null;
		renderGit();
		const res = await git('commit', message);
		busy = '';
		if (res.ok) {
			message = '';
			banner = { level: 'ok', text: 'Committed ' + res.value.hash };
		} else if (res.kind === 'identity') {
			banner = { level: 'err', text: 'Git needs your name and email', detail: 'Run git config user.name and git config user.email once, then commit.' };
		} else if (res.kind === 'hook') {
			banner = { level: 'err', text: 'Commit blocked by a git hook', detail: res.error.split('\n').slice(0, 8).join('\n') };
		} else {
			banner = { level: 'err', text: res.error.split('\n')[0], detail: res.error.split('\n').slice(1, 8).join('\n') };
		}
		await refresh();
		render();
	}

	async function doPush() {
		const publish = !st.upstream;
		busy = 'push';
		banner = null;
		confirm = null;
		renderGit();
		const res = await git('push', publish);
		busy = '';
		if (res.ok) {
			banner = { level: 'ok', text: 'Pushed to ' + res.value.target };
			if (st.branch && !/^(main|master)$/.test(st.branch)) { banner.action = { label: 'Open pull request', run: () => void openPR() }; }
		} else if (res.kind === 'rejected') {
			banner = { level: 'err', text: 'Push rejected', detail: 'The remote has commits you do not have. Pull first, then push again. Stormcoder never force pushes.' };
		} else {
			banner = { level: 'err', text: res.error.split('\n')[0], detail: res.error.split('\n').slice(1, 8).join('\n') };
		}
		await refresh();
		render();
	}

	// ------------------------------------------------------------------ public

	build();

	window.StormChanges = {
		refresh: refresh,
		/** Called when the view is shown or hidden; `files` are paths to select first. */
		show(files) {
			viewShowing = true;
			if (Array.isArray(files)) { for (const f of files) { agentFiles.add(String(f).replace(/ \(new\)$/, '')); } }
			void refresh().then(() => {
				if (Array.isArray(files) && st && st.isRepo) {
					const first = files.map(f => agentKey(String(f).replace(/ \(new\)$/, ''))).find(p => st.files.some(f => f.path === p));
					if (first) {
						const f = fileFor(first);
						sel = { path: first, area: f.unstaged ? 'unstaged' : 'staged' };
						tab = 'changes';
					}
				}
				render();
			});
			render();
		},
		hide() { viewShowing = false; },
		setRunning(value) { if (running !== value) { running = value; if (viewShowing && st && st.isRepo) { renderHead(); renderGit(); } } },
		setDocked(value) { docked = value; if (viewShowing) { renderTabs(); } },
		setTrusted(value) { if (trusted !== value) { trusted = value; if (viewShowing) { render(); } } },
		/** Remembers which files the agent touched so rows can say so. */
		noteAgentFiles(files) {
			for (const f of files || []) { agentFiles.add(String(f).replace(/ \(new\)$/, '')); }
			if (viewShowing) { render(); }
		},
		forget() { tree = null; st = null; sel = null; message = ''; banner = null; agentFiles.clear(); },
	};
}());
