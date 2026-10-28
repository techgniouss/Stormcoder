// The desktop shell: navigation rail, command palette, prompts, toasts and the file editor.
// The chat UI itself lives in two frames (chat and settings) whose messages this page relays
// between them and the host process.
(function () {
	'use strict';
	const api = window.stormcoder;
	const ORIGIN = location.origin;
	const $ = id => document.getElementById(id);

	/** 'dark' or 'light'; the choice is remembered, and the first run follows the system. */
	let theme = 'dark';
	try { theme = localStorage.getItem('sc-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (e) { /* storage unavailable */ }
	document.documentElement.dataset.theme = theme;

	const frames = { chat: $('view-chat'), settings: $('view-settings') };
	const frameReady = { chat: false, settings: false };
	/** Which rail destination is showing; `skills`/`mcp` are areas of the settings frame. */
	let current = 'chat';
	/** Area to select once the settings frame has finished loading. */
	let pendingArea = null;
	let appState = { folder: null, recent: [], trusted: false, userDataDir: '', commands: [] };
	/** @type {Array<{id: string, title: string}>} */
	let hostCommands = [];

	// ------------------------------------------------------------------ frames

	function frameUrl(view) { return ORIGIN + '/view/' + view + '?t=' + Date.now() + '&theme=' + theme; }

	function postToFrame(view, message) {
		const w = frames[view].contentWindow;
		if (w) { w.postMessage({ mj: 'toView', message: message }, ORIGIN); }
	}

	function navFrame(view, detail) {
		const w = frames[view].contentWindow;
		if (w) { w.postMessage(Object.assign({ mj: 'nav' }, detail), ORIGIN); }
	}

	for (const view of Object.keys(frames)) {
		frames[view].addEventListener('load', () => {
			if (!frames[view].src || frames[view].src === 'about:blank') { return; }
			frameReady[view] = true;
			navFrame(view, { theme: theme });
			if (view === 'settings' && pendingArea) {
				navFrame('settings', { area: pendingArea });
				pendingArea = null;
			}
		});
	}

	window.addEventListener('message', e => {
		const d = e.data;
		if (!d || typeof d.mj !== 'string') { return; }
		if (d.mj === 'toHost' && frames[d.view]) {
			if (e.source !== frames[d.view].contentWindow) { return; }
			api.sendToView(d.view, d.message);
		} else if (d.mj === 'key') {
			shortcut(d.key);
		} else if (d.mj === 'openChanges' && e.source === frames.chat.contentWindow) {
			navigate('changes', Array.isArray(d.files) ? d.files.map(String) : undefined);
		}
	});

	/** Changes view shown beside the chat instead of replacing it (a remembered choice, wide windows only). */
	let docked = false;
	try { docked = localStorage.getItem('sc-dock') === '1'; } catch (e) { /* storage unavailable */ }
	/** The docked panel is open next to the chat. */
	let panelOpen = false;
	const canDock = () => docked && window.innerWidth >= 1000;
	let wasBusy = false;
	/** The folder the Changes view last read, so a switch clears it. */
	let lastFolder = null;
	/** True while any chat tab has a run in flight; drives the run line and the rail dot. */
	function setBusy(busy) {
		// A run that just ended may have changed files: refresh the Changes badge and view.
		if (wasBusy && !busy) { StormChanges.refresh(); }
		StormChanges.setRunning(busy);
		wasBusy = busy;
		$('runLine').classList.toggle('on', busy);
		document.querySelector('.rail-btn[data-view="chat"]').classList.toggle('busy', busy);
	}

	api.onViewMessage(({ view, message }) => {
		if (message && message.type === 'sessions' && Array.isArray(message.sessions)) {
			setBusy(message.sessions.some(x => x && x.streaming));
		}
		if (message && message.type === 'checkpoint' && Array.isArray(message.files)) {
			StormChanges.noteAgentFiles(message.files);
			// An empty list means the run was undone; either way the files on disk just changed.
			StormChanges.refresh();
		}
		if (frames[view]) { postToFrame(view, message); }
	});
	api.onViewReload(({ view }) => {
		if (!frames[view]) { return; }
		frameReady[view] = false;
		frames[view].src = frameUrl(view);
	});

	function setTheme(next) {
		theme = next === 'light' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		try { localStorage.setItem('sc-theme', theme); } catch (e) { /* storage unavailable */ }
		for (const view of Object.keys(frames)) { navFrame(view, { theme: theme }); }
	}
	window.__setTheme = setTheme;
	$('themeBtn').addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : 'light'));

	// ------------------------------------------------------------------ navigation

	function showFrame(view) {
		for (const [name, el] of Object.entries(frames)) { el.classList.toggle('hidden', name !== view); }
		if (!(canDock() && panelOpen && view === 'chat')) {
			$('view-changes').classList.add('hidden');
			$('views').classList.remove('split');
			StormChanges.hide();
		}
		const el = frames[view];
		try { el.contentWindow.focus(); } catch (e) { /* cross-origin focus is best effort */ }
	}

	const TITLES = { chat: 'Chat', history: 'History', changes: 'Changes', skills: 'Skills', mcp: 'MCP servers', settings: 'Settings' };

	/** Slides the single accent indicator to the active rail button. */
	function placeIndicator() {
		const btn = document.querySelector('.rail-btn[aria-current="page"]');
		const ind = document.querySelector('.rail-ind');
		if (!btn || !ind) { return; }
		const rail = document.getElementById('rail').getBoundingClientRect();
		const box = btn.getBoundingClientRect();
		ind.style.transform = 'translateY(' + Math.round(box.top - rail.top + (box.height - 20) / 2) + 'px)';
		ind.classList.add('on');
	}
	window.addEventListener('resize', placeIndicator);

	function mark(viewKey) {
		const changed = current !== viewKey;
		current = viewKey;
		const title = $('viewTitle');
		if (changed || !title.textContent) {
			title.textContent = TITLES[viewKey] || 'Chat';
			title.classList.remove('swap');
			void title.offsetWidth;
			title.classList.add('swap');
		}
		for (const btn of document.querySelectorAll('.rail-btn[data-view]')) {
			if (btn.dataset.view === viewKey) { btn.setAttribute('aria-current', 'page'); }
			else { btn.removeAttribute('aria-current'); }
		}
		placeIndicator();
	}

	/** @param {string} viewKey @param {string[]} [files] Paths for the Changes view to select first. */
	function navigate(viewKey, files) {
		const prev = current;
		mark(viewKey);
		if (viewKey === 'changes') {
			if (canDock()) {
				// Docked: the panel opens beside the chat; the rail button toggles it.
				if (panelOpen && !files && prev === 'changes') { panelOpen = false; navigate('chat'); return; }
				panelOpen = true;
				showFrame('chat');
				navFrame('chat', { to: 'chat' });
				$('views').classList.add('split');
				$('view-changes').classList.remove('hidden');
				StormChanges.show(files);
				return;
			}
			panelOpen = false;
			$('views').classList.remove('split');
			for (const el of Object.values(frames)) { el.classList.add('hidden'); }
			$('view-changes').classList.remove('hidden');
			StormChanges.show(files);
			return;
		}
		if (viewKey !== 'chat') { panelOpen = false; }
		if (viewKey === 'chat' || viewKey === 'history') {
			showFrame('chat');
			navFrame('chat', { to: viewKey });
			return;
		}
		const area = viewKey === 'settings' ? 'providers' : viewKey;
		if (frameReady.settings) {
			navFrame('settings', { area: area });
		} else {
			pendingArea = area;
		}
		showFrame('settings');
		// Idempotent on the host: reveals the panel if it exists, builds it otherwise.
		api.command('stormcoder.openSettings');
	}

	api.onNavigate(({ view }) => navigate(view));
	StormChanges.setDocked(docked);
	window.addEventListener('changes-dock', () => {
		docked = !docked;
		try { localStorage.setItem('sc-dock', docked ? '1' : '0'); } catch (e) { /* storage unavailable */ }
		StormChanges.setDocked(docked);
		if (!docked) { panelOpen = false; }
		if (current === 'changes' || panelOpen) { navigate('changes'); }
	});
	// A window narrowed below the dock width falls back to the full-width view.
	window.addEventListener('resize', () => { if (panelOpen && !canDock()) { panelOpen = false; navigate('changes'); } });
	api.onPalette(() => openCommands());
	for (const btn of document.querySelectorAll('.rail-btn[data-view]')) {
		btn.addEventListener('click', () => navigate(btn.dataset.view));
	}
	$('paletteBtn').addEventListener('click', () => openCommands());
	$('projectBtn').addEventListener('click', () => openProjectMenu());
	$('kbdHint').addEventListener('click', () => openCommands());

	function shortcut(key) {
		if (key === 'k') { openCommands(); }
		else if (key === ',') { navigate('settings'); }
		else if (key === '1') { navigate('chat'); }
		else if (key === '2') { navigate('history'); }
		else if (key === '3') { navigate('skills'); }
		else if (key === '4') { navigate('mcp'); }
		else if (key === '5') { navigate('changes'); }
		else if (key === '?') { openShortcuts(); }
	}
	window.addEventListener('keydown', e => {
		const t = e.target;
		const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
		if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); shortcut('?'); return; }
		if ((e.ctrlKey || e.metaKey) && /^[1-5,k]$/i.test(e.key)) {
			e.preventDefault();
			shortcut(e.key.toLowerCase());
		}
	});

	// ------------------------------------------------------------------ palette

	let paletteBusy = Promise.resolve();

	/** Fills the palette footer with key hints: [[key, what it does], ...]. */
	function setFoot(foot, hints) {
		foot.textContent = '';
		for (const [key, what] of hints) {
			const item = document.createElement('span');
			const k = document.createElement('kbd');
			k.textContent = key;
			item.append(k, ' ' + what);
			foot.appendChild(item);
		}
	}

	/**
	 * One list-and-filter surface serves the command palette and every host prompt (text
	 * input, single and multiple pick). Prompts queue, so two arriving together answer in turn.
	 */
	function palette(opts) {
		const run = () => new Promise(resolve => {
			const overlay = $('palette');
			const input = $('paletteInput');
			const list = $('paletteList');
			const title = $('paletteTitle');
			const prompt = $('palettePrompt');
			const foot = $('paletteFoot');
			const items = opts.items || [];
			const picked = new Set(items.map((it, i) => it.picked ? i : -1).filter(i => i >= 0));
			let shown = [];
			let selected = 0;

			title.textContent = opts.title || '';
			title.classList.toggle('hidden', !opts.title);
			prompt.textContent = opts.prompt || '';
			prompt.classList.toggle('hidden', !opts.prompt);
			input.type = opts.password ? 'password' : 'text';
			input.placeholder = opts.placeholder || '';
			input.value = opts.value || '';
			list.classList.toggle('hidden', opts.mode === 'input');
			setFoot(foot, opts.mode === 'input' ? [['Enter', 'confirm'], ['Esc', 'cancel']]
				: opts.many ? [['Space', 'toggle'], ['Enter', 'confirm'], ['Esc', 'cancel']] : [['\u2191\u2193', 'move'], ['Enter', 'choose'], ['Esc', 'close']]);

			function matches(it, q) {
				if (!q) { return true; }
				const hay = (it.label + ' ' + (it.description || '') + ' ' + (it.detail || '')).toLowerCase();
				return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
			}

			function render() {
				const q = opts.mode === 'input' ? '' : input.value.trim();
				shown = items.map((it, i) => ({ it, i })).filter(x => matches(x.it, q));
				if (selected >= shown.length) { selected = Math.max(0, shown.length - 1); }
				list.textContent = '';
				if (!shown.length && opts.mode !== 'input') {
					const li = document.createElement('li');
					li.className = 'empty';
					li.textContent = 'Nothing matches';
					list.appendChild(li);
					return;
				}
				shown.forEach((x, n) => {
					const li = document.createElement('li');
					li.setAttribute('role', 'option');
					li.setAttribute('aria-selected', String(n === selected));
					if (opts.many) {
						const c = document.createElement('span');
						c.className = 'check' + (picked.has(x.i) ? ' on' : '');
						li.appendChild(c);
					}
					const label = document.createElement('span');
					label.className = 'label';
					highlight(label, x.it.label.replace(/\$\([a-z-]+\)\s*/g, ''), q);
					li.appendChild(label);
					if (x.it.description) {
						const d = document.createElement('span');
						d.className = 'desc';
						d.textContent = x.it.description.replace(/\$\([a-z-]+\)\s*/g, '');
						li.appendChild(d);
					}
					if (x.it.detail) {
						const d = document.createElement('span');
						d.className = 'detail';
						d.textContent = x.it.detail;
						label.appendChild(d);
					}
					li.addEventListener('mousemove', () => { if (selected !== n) { selected = n; markSelected(); } });
					li.addEventListener('click', () => choose(n));
					list.appendChild(li);
				});
			}

			/** Writes `text` into `el`, wrapping each query word it contains in <mark> (no innerHTML). */
			function highlight(el, text, query) {
				const words = query.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
				if (!words.length) { el.textContent = text; return; }
				const re = new RegExp('(' + words.join('|') + ')', 'ig');
				let last = 0;
				for (const m of text.matchAll(re)) {
					if (m.index > last) { el.appendChild(document.createTextNode(text.slice(last, m.index))); }
					const mark = document.createElement('mark');
					mark.textContent = m[0];
					el.appendChild(mark);
					last = m.index + m[0].length;
				}
				if (last < text.length) { el.appendChild(document.createTextNode(text.slice(last))); }
			}

			function markSelected() {
				[...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === selected)));
				const el = list.children[selected];
				if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
			}

			function finish(value) {
				overlay.classList.add('hidden');
				input.removeEventListener('keydown', onKey);
				input.removeEventListener('input', onInput);
				overlay.removeEventListener('mousedown', onBackdrop);
				resolve(value);
			}

			function choose(n) {
				const x = shown[n];
				if (!x) { return; }
				if (opts.many) {
					if (picked.has(x.i)) { picked.delete(x.i); } else { picked.add(x.i); }
					render();
				} else {
					finish(x.i);
				}
			}

			function onKey(e) {
				if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
				else if (e.key === 'Enter') {
					e.preventDefault();
					if (opts.mode === 'input') { finish(input.value); }
					else if (opts.many) { finish([...picked].sort((a, b) => a - b)); }
					else { choose(selected); }
				} else if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(shown.length - 1, selected + 1); markSelected(); }
				else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); markSelected(); }
				else if (e.key === ' ' && opts.many && !input.value) { e.preventDefault(); choose(selected); }
			}
			function onInput() { selected = 0; render(); }
			function onBackdrop(e) { if (e.target === overlay) { finish(undefined); } }

			input.addEventListener('keydown', onKey);
			input.addEventListener('input', onInput);
			overlay.addEventListener('mousedown', onBackdrop);
			overlay.classList.remove('hidden');
			render();
			input.focus();
			input.select();
		});
		const next = paletteBusy.then(run, run);
		paletteBusy = next.catch(() => undefined);
		return next;
	}

	function commandItems() {
		const nav = [
			['Go to Chat', 'chat'], ['Go to History', 'history'], ['Go to Changes', 'changes'], ['Go to Skills', 'skills'],
			['Go to MCP Servers', 'mcp'], ['Go to Settings', 'settings'],
		].map(([label, key]) => ({ label, description: 'Navigate', run: () => navigate(key) }));
		const project = [
			{ label: 'Open Project Folder…', description: 'Project', run: () => api.command('app.openFolder') },
			{ label: 'Keyboard Shortcuts', description: 'Help', run: () => openShortcuts() },
			...(update.status === 'ready' ? [{ label: 'Install Update and Restart', description: 'App', run: () => api.command('app.installUpdate') }] : []),
			{ label: 'Check for Updates', description: 'App', run: () => api.command('app.checkUpdates') },
			{ label: 'Toggle Light / Dark Theme', description: 'View', run: () => setTheme(theme === 'light' ? 'dark' : 'light') },
			...(appState.folder ? [{ label: 'Close Project Folder', description: 'Project', run: () => api.command('app.closeFolder') }] : []),
			...appState.recent.filter(f => f !== appState.folder).map(f => ({ label: 'Open ' + baseName(f), description: f, run: () => api.command('app.openFolder', f) })),
			...(appState.userDataDir ? [{ label: 'Edit settings.json', description: 'Settings', run: () => openEditor(appState.userDataDir + sep() + 'settings.json') }] : []),
		];
		const known = new Set(nav.map(n => n.label));
		const host = hostCommands.filter(c => !known.has(c.title)).map(c => ({ label: c.title, description: c.group || 'Command', run: () => api.command(c.id) }));
		return [...nav, ...project, ...host];
	}

	async function openCommands() {
		const items = commandItems();
		const choice = await palette({ mode: 'pick', placeholder: 'Type a command', items });
		if (typeof choice === 'number') { items[choice].run(); }
	}

	function baseName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || p; }
	function sep() { return appState.platform === 'win32' ? '\\' : '/'; }


	// ------------------------------------------------------------------ menus

	/** 16px outline icon paths for menu rows. */
	const IC = {
		changes: 'M5 2.5v7M5 12.5a1.5 1.5 0 1 0 0 .01zM11 3.5a1.5 1.5 0 1 0 0 .01zM11 5v1.5a2.5 2.5 0 0 1-2.5 2.5H5',
		chat: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z', plus: 'M8 3v10M3 8h10', folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
		history: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2.2 1.4', skills: 'M3.5 2.5h7l2 2v9h-9zM5.5 7h5M5.5 9.5h5',
		mcp: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2', settings: 'M2.5 4.5h6M11.5 4.5h2M2.5 8h2M7.5 8h6M2.5 11.5h7M12.5 11.5h1',
		palette: 'M5.5 3.5a2 2 0 1 0-2 2h9a2 2 0 1 0-2-2v9a2 2 0 1 0 2-2h-9a2 2 0 1 0 2 2z', keys: 'M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6',
		sun: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6',
		moon: 'M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6z', refresh: 'M13.5 2.5v4h-4M13.2 6.5A5.5 5.5 0 1 0 14 8',
		logs: 'M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3', link: 'M6 3.5H3.5v9h9V10M9 2.5h4.5V7M13.5 2.5L7.5 8.5',
		zoomIn: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11 11l3 3M5 7h4M7 5v4', power: 'M8 2v6M4.8 4.4a5 5 0 1 0 6.4 0', close: 'M4 4l8 8M12 4l-8 8',
	};
	const MOD = () => appState.platform === 'darwin' ? '⌘' : 'Ctrl';

	/** The app menu: opened from the brand mark, so Windows and Linux (menu bar hidden) have a way in. */
	function openAppMenu() {
		const mod = MOD();
		const recent = appState.recent.filter(f => f !== appState.folder).slice(0, 4);
		const items = [
			{ label: 'New chat', icon: IC.plus, shortcut: [mod, 'N'], onSelect: () => api.command('stormcoder.newChat') },
			{ label: 'Open project folder…', icon: IC.folder, shortcut: [mod, 'O'], onSelect: () => api.command('app.openFolder') },
			...(recent.length ? [{ type: 'header', label: 'Recent projects' }, ...recent.map(f => ({ label: baseName(f), detail: f, icon: IC.folder, onSelect: () => api.command('app.openFolder', f) }))] : []),
			{ type: 'sep' },
			{ label: 'Chat', icon: IC.chat, shortcut: [mod, '1'], onSelect: () => navigate('chat') },
			{ label: 'History', icon: IC.history, shortcut: [mod, '2'], onSelect: () => navigate('history') },
			{ label: 'Changes', icon: IC.changes, shortcut: [mod, '5'], onSelect: () => navigate('changes') },
			{ label: 'Skills', icon: IC.skills, shortcut: [mod, '3'], onSelect: () => navigate('skills') },
			{ label: 'MCP servers', icon: IC.mcp, shortcut: [mod, '4'], onSelect: () => navigate('mcp') },
			{ label: 'Settings', icon: IC.settings, shortcut: [mod, ','], onSelect: () => navigate('settings') },
			{ type: 'sep' },
			{ label: 'Command palette', icon: IC.palette, shortcut: [mod, 'K'], onSelect: () => openCommands() },
			{ label: 'Keyboard shortcuts', icon: IC.keys, shortcut: ['?'], onSelect: () => openShortcuts() },
			{ label: theme === 'light' ? 'Dark theme' : 'Light theme', icon: theme === 'light' ? IC.moon : IC.sun, onSelect: () => setTheme(theme === 'light' ? 'dark' : 'light') },
			{ label: 'Zoom in', icon: IC.zoomIn, onSelect: () => api.command('app.zoomIn') },
			{ label: 'Reset zoom', icon: IC.refresh, onSelect: () => api.command('app.zoomReset') },
			{ type: 'sep' },
			updateMenuItem(),
			{ label: 'Open logs folder', icon: IC.logs, onSelect: () => api.command('app.openLogs') },
			{ label: 'Stormcoder on GitHub', icon: IC.link, onSelect: () => api.command('app.openGitHub') },
			{ type: 'sep' },
			{ label: 'Quit', icon: IC.power, danger: true, onSelect: () => api.command('app.quit') },
		];
		StormMenu.open({ anchor: $('markBtn'), placement: 'right-start', items, minWidth: 280, ariaLabel: 'Stormcoder menu' });
	}

	/** The project switcher: a popover under the project chip instead of a full palette. */
	function openProjectMenu() {
		const others = appState.recent.filter(f => f !== appState.folder);
		const items = [
			...(appState.folder ? [{ type: 'header', label: 'Current project' }, { label: baseName(appState.folder), detail: appState.folder, icon: IC.folder, checked: true, onSelect: () => undefined }] : []),
			...(others.length ? [{ type: 'header', label: 'Recent' }, ...others.map(f => ({ label: baseName(f), detail: f, icon: IC.folder, onSelect: () => api.command('app.openFolder', f) }))] : []),
			{ type: 'sep' },
			{ label: 'Open project folder…', icon: IC.plus, shortcut: [MOD(), 'O'], onSelect: () => api.command('app.openFolder') },
			...(appState.folder ? [{ label: 'Close project', icon: IC.close, onSelect: () => api.command('app.closeFolder') }] : []),
		];
		StormMenu.open({ anchor: $('projectBtn'), placement: 'bottom-start', items, minWidth: 320, ariaLabel: 'Project' });
	}

	$('markBtn').addEventListener('click', openAppMenu);

	// ------------------------------------------------------------------ shortcuts sheet

	function shortcutGroups() {
		const m = MOD();
		return [
			['Go to', [['Chat', [m, '1']], ['History', [m, '2']], ['Skills', [m, '3']], ['MCP servers', [m, '4']], ['Changes', [m, '5']], ['Settings', [m, ',']], ['Command palette', [m, 'K']]]],
			['Chat', [['Send', ['Enter']], ['New line', ['Shift', 'Enter']], ['Slash commands', ['/']], ['New chat', [m, 'N']], ['Open project', [m, 'O']]]],
			['Menus', [['Move', ['↑', '↓']], ['Choose', ['Enter']], ['Close', ['Esc']], ['Search a list', ['type']]]],
		];
	}

	function openShortcuts() {
		const body = $('keysBody');
		body.textContent = '';
		for (const [title, rows] of shortcutGroups()) {
			const group = document.createElement('section');
			const h = document.createElement('h3');
			h.textContent = title;
			group.appendChild(h);
			for (const [label, keys] of rows) {
				const row = document.createElement('div');
				row.className = 'keys-row';
				const l = document.createElement('span');
				l.textContent = label;
				const k = document.createElement('span');
				k.className = 'keys-k';
				for (const key of keys) { const kb = document.createElement('kbd'); kb.textContent = key; k.appendChild(kb); }
				row.append(l, k);
				group.appendChild(row);
			}
			body.appendChild(group);
		}
		const overlay = $('keys');
		overlay.classList.remove('hidden');
		const release = trapFocus(overlay);
		const close = () => { overlay.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); overlay.removeEventListener('mousedown', onDown); release(); };
		const onKey = e => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); close(); } };
		const onDown = e => { if (e.target === overlay) { close(); } };
		document.addEventListener('keydown', onKey, true);
		overlay.addEventListener('mousedown', onDown);
		$('keysClose').onclick = close;
		$('keysClose').focus();
	}

	// ------------------------------------------------------------------ dialogs and toasts

	/**
	 * Keeps Tab inside a modal and hands focus back to whatever opened it. Returns a release
	 * function that removes the trap and restores that focus.
	 * @param {HTMLElement} overlay
	 */
	function trapFocus(overlay) {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		/** @param {KeyboardEvent} e */
		const onTab = e => {
			if (e.key !== 'Tab') { return; }
			const items = Array.from(overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]'))
				.filter(el => el instanceof HTMLElement && !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.offsetParent !== null);
			if (!items.length) { e.preventDefault(); return; }
			const first = /** @type {HTMLElement} */ (items[0]);
			const last = /** @type {HTMLElement} */ (items[items.length - 1]);
			const cur = document.activeElement;
			if (!overlay.contains(cur)) { e.preventDefault(); first.focus(); }
			else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
		};
		document.addEventListener('keydown', onTab, true);
		return () => {
			document.removeEventListener('keydown', onTab, true);
			if (opener && opener.isConnected && !overlay.contains(opener)) { opener.focus(); }
		};
	}

	/** Cancels the dialog currently on screen, if any, so a newer one never strands its promise. */
	let cancelPendingDialog = null;

	function dialog(req) {
		if (cancelPendingDialog) { cancelPendingDialog(); }
		return new Promise(resolve => {
			const overlay = $('dialog');
			$('dialogText').textContent = req.text;
			const detail = $('dialogDetail');
			detail.textContent = req.detail || '';
			detail.classList.toggle('hidden', !req.detail);
			const box = $('dialogActions');
			box.textContent = '';
			const release = trapFocus(overlay);
			const done = value => {
				if (cancelPendingDialog === cancel_) { cancelPendingDialog = null; }
				overlay.classList.add('hidden');
				document.removeEventListener('keydown', onKey, true);
				release();
				resolve(value);
			};
			const cancel_ = () => done(undefined);
			cancelPendingDialog = cancel_;
			const actions = req.actions.length ? req.actions : ['OK'];
			actions.forEach((label, n) => {
				const b = document.createElement('button');
				b.className = 'btn' + (n === 0 ? ' btn-primary' : '');
				b.textContent = label;
				b.addEventListener('click', () => done(req.actions.length ? label : undefined));
				box.appendChild(b);
			});
			if (req.actions.length) {
				const cancel = document.createElement('button');
				cancel.className = 'btn';
				cancel.textContent = 'Cancel';
				cancel.addEventListener('click', () => done(undefined));
				box.appendChild(cancel);
			}
			function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(undefined); } }
			document.addEventListener('keydown', onKey, true);
			overlay.classList.remove('hidden');
			const first = box.querySelector('button');
			if (first) { first.focus(); }
		});
	}

	function toast(req) {
		return new Promise(resolve => {
			const el = document.createElement('div');
			el.className = 'toast ' + req.level;
			el.setAttribute('role', req.level === 'error' ? 'alert' : 'status');
			const head = document.createElement('div');
			head.className = 'toast-head';
			const dot = document.createElement('span');
			dot.className = 'dot';
			const kind = document.createElement('span');
			kind.textContent = req.level === 'error' ? 'Error' : req.level === 'warn' ? 'Warning' : 'Notice';
			const x = document.createElement('button');
			x.className = 'toast-x';
			x.setAttribute('aria-label', 'Dismiss');
			x.textContent = '×';
			head.append(dot, kind, x);
			const p = document.createElement('p');
			p.textContent = req.text;
			el.append(head, p);
			let timer;
			const done = value => { clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 180); resolve(value); };
			if (req.actions.length) {
				const row = document.createElement('div');
				row.className = 'toast-actions';
				req.actions.forEach((label, n) => {
					const b = document.createElement('button');
					b.className = 'btn' + (n === 0 ? ' btn-primary' : '');
					b.textContent = label;
					b.addEventListener('click', () => done(label));
					row.appendChild(b);
				});
				el.appendChild(row);
			}
			x.addEventListener('click', () => done(undefined));
			$('toasts').appendChild(el);
			const ms = req.actions.length ? 45000 : req.level === 'info' ? 6000 : 12000;
			timer = setTimeout(() => done(undefined), ms);
			el.addEventListener('mouseenter', () => clearTimeout(timer));
		});
	}

	// ------------------------------------------------------------------ editor

	function openEditor(file) {
		return new Promise(async resolve => {
			const overlay = $('editor');
			const text = $('editorText');
			const note = $('editorNote');
			const save = $('editorSave');
			const readOnly = /\.log$/i.test(file);
			$('editorPath').textContent = file;
			note.textContent = '';
			note.className = 'editor-note';
			let original = '';
			try { original = await api.readFile(file); } catch (err) { original = ''; note.textContent = String(err.message || err); note.classList.add('bad'); }
			text.value = original;
			text.readOnly = readOnly;
			save.classList.toggle('hidden', readOnly);
			function validate() {
				if (!/\.json$/i.test(file)) { save.disabled = false; return true; }
				try { if (text.value.trim()) { JSON.parse(text.value); } note.textContent = ''; note.className = 'editor-note'; save.disabled = false; return true; }
				catch (err) { note.textContent = 'Invalid JSON: ' + err.message; note.className = 'editor-note bad'; save.disabled = true; return false; }
			}
			async function doSave() {
				if (!validate()) { return; }
				try { await api.writeFile(file, text.value); original = text.value; note.textContent = 'Saved'; }
				catch (err) { note.textContent = String(err.message || err); note.classList.add('bad'); }
			}
			let releaseTrap = null;
			function close() {
				overlay.classList.add('hidden');
				if (releaseTrap) { releaseTrap(); }
				save.removeEventListener('click', doSave);
				$('editorClose').removeEventListener('click', close);
				text.removeEventListener('input', validate);
				document.removeEventListener('keydown', onKey, true);
				resolve(undefined);
			}
			function onKey(e) {
				if (e.key === 'Escape') { e.stopPropagation(); close(); }
				else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
			}
			save.addEventListener('click', doSave);
			$('editorClose').addEventListener('click', close);
			text.addEventListener('input', validate);
			document.addEventListener('keydown', onKey, true);
			overlay.classList.remove('hidden');
			releaseTrap = trapFocus(overlay);
			validate();
			text.focus();
		});
	}

	// ------------------------------------------------------------------ host requests and events

	api.onRequest(async ({ id, req }) => {
		let value;
		try {
			switch (req.kind) {
				case 'message': value = req.modal ? await dialog(req) : await toast(req); break;
				case 'input': value = await palette({ mode: 'input', title: req.title, prompt: req.prompt, placeholder: req.placeholder, value: req.value, password: req.password }); break;
				case 'pick': value = await palette({ mode: 'pick', title: req.title, placeholder: req.placeholder, many: req.many, items: req.items }); break;
				case 'openDialog': value = await api.openDialog(req); break;
				case 'edit': value = await openEditor(req.path); break;
				default: value = undefined;
			}
		} catch (err) {
			console.error('request failed', err);
		}
		api.respond(id, value);
	});

	const progress = new Map();
	const status = new Map();
	function renderScope() {
		const label = $('progressLabel');
		const active = [...progress.values()];
		$('progressBar').classList.toggle('hidden', !active.length);
		label.classList.toggle('hidden', !active.length);
		label.textContent = active.length ? (active[active.length - 1].message || active[active.length - 1].title || 'Working…') : '';
		const box = $('statusItems');
		box.textContent = '';
		for (const s of status.values()) {
			if (!s.visible) { continue; }
			const span = document.createElement('span');
			span.textContent = s.text;
			if (s.tooltip) { span.title = s.tooltip; }
			box.appendChild(span);
		}
	}

	api.onEvent(ev => {
		if (ev.kind === 'progress') {
			if (ev.done) { progress.delete(ev.id); } else { progress.set(ev.id, ev); }
			renderScope();
		} else if (ev.kind === 'status') {
			status.set(ev.id, ev);
			renderScope();
		} else if (ev.kind === 'focus') {
			if (ev.view === 'settings') { if (current === 'chat' || current === 'history') { mark('settings'); } showFrame('settings'); }
			else { mark('chat'); showFrame('chat'); }
		}
	});

	api.onState(state => {
		appState = state;
		const mac = state.platform === 'darwin';
		$('kbdMod').textContent = mac ? '\u2318' : 'Ctrl';
		if (mac) {
			// Shortcut hints in tooltips say Command, not Ctrl.
			for (const el of document.querySelectorAll('#rail [title], #rail [data-tip]')) {
				for (const attr of ['title', 'data-tip']) { const v = el.getAttribute(attr); if (v) { el.setAttribute(attr, v.replace(/Ctrl\+/g, '\u2318')); } }
			}
		}
		$('projectName').textContent = state.folder ? baseName(state.folder) : 'No folder open';
		$('projectBtn').title = state.folder || 'Open a project folder so the agent can work on it';
		$('trustPill').classList.toggle('hidden', !state.folder || state.trusted);
		StormChanges.setTrusted(!!state.trusted);
		if (state.folder !== lastFolder) {
			lastFolder = state.folder;
			StormChanges.forget();
			if (state.folder) { StormChanges.refresh(); }
		}
		const note = $('storageNote');
		note.classList.toggle('hidden', state.secureStorage !== false);
		note.textContent = 'Keys use file encryption (no OS keychain found)';
		hostCommands = (state.commandList || []).filter(c => state.commands.includes(c.id));
	});


	// ------------------------------------------------------------------ updates

	/** @type {{ status: string, current: string, version?: string, percent?: number, releaseUrl?: string, error?: string, manual: boolean, seq: number }} */
	let update = { status: 'idle', current: '', manual: false, seq: 0 };
	const announced = new Set();

	/** The one app-menu row for updates: it says what is happening and does the useful thing. */
	function updateMenuItem() {
		const v = update.version || '';
		switch (update.status) {
			case 'ready': return { label: 'Restart to install ' + v, detail: 'Downloaded', icon: IC.refresh, onSelect: () => api.command('app.installUpdate') };
			case 'available': return { label: 'Download ' + v + ' from GitHub', icon: IC.link, onSelect: () => api.command('app.openRelease') };
			case 'downloading': return { label: 'Downloading ' + v + (update.percent ? ' \u00b7 ' + update.percent + '%' : ''), icon: IC.refresh, disabled: true, onSelect: () => undefined };
			case 'checking': return { label: 'Checking for updates\u2026', icon: IC.refresh, disabled: true, onSelect: () => undefined };
			default: return { label: 'Check for updates\u2026', detail: update.current ? 'v' + update.current : '', icon: IC.refresh, onSelect: () => api.command('app.checkUpdates') };
		}
	}

	function renderUpdate() {
		const pill = $('updatePill');
		const v = update.version || '';
		const text = update.status === 'ready' ? 'Restart to update'
			: update.status === 'available' ? 'Update ' + v + ' available'
				: update.status === 'downloading' ? 'Downloading ' + v + (update.percent ? ' \u00b7 ' + update.percent + '%' : '')
					: update.status === 'checking' && update.manual ? 'Checking for updates\u2026' : '';
		pill.classList.toggle('hidden', !text);
		pill.textContent = text;
		pill.dataset.status = update.status;
		$('updateDot').classList.toggle('hidden', update.status !== 'ready' && update.status !== 'available');
	}

	function openUpdateMenu() {
		const v = update.version || '';
		const items = [];
		if (update.status === 'ready') { items.push({ label: 'Restart and install ' + v, icon: IC.refresh, onSelect: () => api.command('app.installUpdate') }); }
		if (update.status === 'available') { items.push({ label: 'Download ' + v + ' from GitHub', icon: IC.link, onSelect: () => api.command('app.openRelease') }); }
		if (update.status === 'downloading') { items.push({ label: 'Downloading in the background\u2026', disabled: true, onSelect: () => undefined }); }
		if (update.releaseUrl) { items.push({ label: 'What\u2019s new', icon: IC.link, onSelect: () => api.command('app.openRelease') }); }
		if (update.status === 'ready') { items.push({ type: 'sep' }, { label: 'Later \u2014 installs when you quit', onSelect: () => undefined }); }
		StormMenu.open({ anchor: $('updatePill'), placement: 'bottom-end', items, minWidth: 260, ariaLabel: 'Update' });
	}

	/** Tells the person what a check found: always after a manual one, and once when a download finishes by itself. */
	function announceUpdate() {
		const v = update.version || '';
		const once = key => { if (announced.has(key)) { return false; } announced.add(key); return true; };
		if (update.status === 'ready' && once('ready:' + v)) {
			void toast({ level: 'info', text: 'Stormcoder ' + v + ' is ready to install.', actions: ['Restart to update', 'Later'] })
				.then(choice => { if (choice === 'Restart to update') { void api.command('app.installUpdate'); } });
		} else if (update.status === 'available' && update.manual && once('available:' + v + ':' + update.seq)) {
			void toast({ level: 'info', text: 'Stormcoder ' + v + ' is available. This install cannot update itself, so download it from GitHub.', actions: ['Open release page', 'Later'] })
				.then(choice => { if (choice === 'Open release page') { void api.command('app.openRelease'); } });
		} else if (update.manual && update.status === 'uptodate') {
			void toast({ level: 'info', text: 'You are on the latest version (' + update.current + ').', actions: [] });
		} else if (update.manual && update.status === 'error') {
			void toast({ level: 'error', text: 'Could not check for updates: ' + (update.error || 'unknown error'), actions: [] });
		}
	}

	if (api.onUpdate) {
		api.onUpdate(state => {
			const fresh = state.seq !== update.seq;
			update = state;
			renderUpdate();
			if (fresh) { announceUpdate(); }
		});
		void api.command('app.updateState').then(state => { if (state) { update = state; renderUpdate(); } }, () => undefined);
		$('updatePill').addEventListener('click', openUpdateMenu);
	}

	// Tooltips for the rail sit beside it.
	for (const el of document.querySelectorAll('#rail .rail-btn, #rail .rail-mark')) { el.dataset.tipSide = 'right'; }
	StormMenu.tooltips();

	// Edits made outside the app show up when the window comes back.
	window.addEventListener('focus', () => { if (appState.folder) { StormChanges.refresh(); } });

	mark('chat');
	api.ready();
}());
