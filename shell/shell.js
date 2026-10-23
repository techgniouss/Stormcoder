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
		}
	});

	/** True while any chat tab has a run in flight; drives the run line and the rail dot. */
	function setBusy(busy) {
		$('runLine').classList.toggle('on', busy);
		document.querySelector('.rail-btn[data-view="chat"]').classList.toggle('busy', busy);
	}

	api.onViewMessage(({ view, message }) => {
		if (message && message.type === 'sessions' && Array.isArray(message.sessions)) {
			setBusy(message.sessions.some(x => x && x.streaming));
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
		const el = frames[view];
		try { el.contentWindow.focus(); } catch (e) { /* cross-origin focus is best effort */ }
	}

	const TITLES = { chat: 'Chat', history: 'History', skills: 'Skills', mcp: 'MCP servers', settings: 'Settings' };

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

	function navigate(viewKey) {
		mark(viewKey);
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
		api.command('openvsChat.openSettings');
	}

	api.onNavigate(({ view }) => navigate(view));
	api.onPalette(() => openCommands());
	for (const btn of document.querySelectorAll('.rail-btn[data-view]')) {
		btn.addEventListener('click', () => navigate(btn.dataset.view));
	}
	$('paletteBtn').addEventListener('click', () => openCommands());
	$('projectBtn').addEventListener('click', () => openProjects());
	$('kbdHint').addEventListener('click', () => openCommands());

	function shortcut(key) {
		if (key === 'k') { openCommands(); }
		else if (key === ',') { navigate('settings'); }
		else if (key === '1') { navigate('chat'); }
		else if (key === '2') { navigate('history'); }
		else if (key === '3') { navigate('skills'); }
		else if (key === '4') { navigate('mcp'); }
	}
	window.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && /^[1-4,k]$/i.test(e.key)) {
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
			['Go to Chat', 'chat'], ['Go to History', 'history'], ['Go to Skills', 'skills'],
			['Go to MCP Servers', 'mcp'], ['Go to Settings', 'settings'],
		].map(([label, key]) => ({ label, description: 'Navigate', run: () => navigate(key) }));
		const project = [
			{ label: 'Open Project Folder…', description: 'Project', run: () => api.command('app.openFolder') },
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

	async function openProjects() {
		const items = [
			{ label: 'Open Project Folder…', description: 'Browse', run: () => api.command('app.openFolder') },
			...appState.recent.map(f => ({ label: baseName(f), description: f, run: () => api.command('app.openFolder', f) })),
			...(appState.folder ? [{ label: 'Close Project Folder', description: 'No project', run: () => api.command('app.closeFolder') }] : []),
		];
		const choice = await palette({ mode: 'pick', title: 'Project', placeholder: 'Choose a project folder', items });
		if (typeof choice === 'number') { items[choice].run(); }
	}

	function baseName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || p; }
	function sep() { return appState.platform === 'win32' ? '\\' : '/'; }

	// ------------------------------------------------------------------ dialogs and toasts

	function dialog(req) {
		return new Promise(resolve => {
			const overlay = $('dialog');
			$('dialogText').textContent = req.text;
			const detail = $('dialogDetail');
			detail.textContent = req.detail || '';
			detail.classList.toggle('hidden', !req.detail);
			const box = $('dialogActions');
			box.textContent = '';
			const done = value => { overlay.classList.add('hidden'); document.removeEventListener('keydown', onKey, true); resolve(value); };
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
			function close() {
				overlay.classList.add('hidden');
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
		$('kbdMod').textContent = state.platform === 'darwin' ? '\u2318' : 'Ctrl';
		$('projectName').textContent = state.folder ? baseName(state.folder) : 'No folder open';
		$('projectBtn').title = state.folder || 'Open a project folder so the agent can work on it';
		$('trustPill').classList.toggle('hidden', !state.folder || state.trusted);
		const note = $('storageNote');
		note.classList.toggle('hidden', state.secureStorage !== false);
		note.textContent = 'Keys use file encryption (no OS keychain found)';
		hostCommands = (state.commandList || []).filter(c => state.commands.includes(c.id));
	});

	mark('chat');
	api.ready();
}());
