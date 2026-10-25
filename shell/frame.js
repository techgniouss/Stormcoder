// Loaded last inside the chat and settings frames. Adds what the desktop shell needs on top of
// the unchanged chat UI: one settings area at a time (with a left navigation), and the rail's
// requests to show History or switch area.
(function () {
	'use strict';
	const settingsWindow = document.body.classList.contains('settings-window');
	const AREAS = [
		['providers', 'Providers'], ['general', 'General'], ['permissions', 'Agent permissions'], ['memory', 'Memory'],
		['skills', 'Skills'], ['mcp', 'MCP servers'], ['auto', 'Auto routing'], ['remote', 'Remote control'],
	];
	/** 16px outline icons, one per settings area. */
	const AREA_ICONS = {
		providers: '<path d="M3 5.5h10M3 10.5h10"/><circle cx="6" cy="5.5" r="1.6"/><circle cx="10.5" cy="10.5" r="1.6"/>',
		general: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
		permissions: '<path d="M8 1.8l5 1.8v4c0 3-2.1 5.1-5 6.6C5.1 12.7 3 10.6 3 7.6v-4z"/><path d="M5.8 8l1.6 1.6L10.4 6.6"/>',
		memory: '<path d="M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z"/><path d="M3 4.5v3.5c0 1.1 2.2 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.2 2 5 2s5-.9 5-2V8"/>',
		skills: '<path d="M3.5 2.5h7l2 2v9h-9z"/><path d="M5.5 7h5M5.5 9.5h5"/>',
		mcp: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2"/>',
		auto: '<path d="M2.5 8h3l2-4 2 8 2-4h2"/>',
		remote: '<rect x="5" y="1.8" width="6" height="12.4" rx="1.4"/><path d="M7.2 12h1.6"/>',
	};

	function showArea(id) {
		const known = AREAS.some(a => a[0] === id) ? id : 'providers';
		for (const el of document.querySelectorAll('#settingsPanel .area')) {
			el.classList.toggle('active', el.dataset.area === known);
		}
		for (const b of document.querySelectorAll('.area-nav button')) {
			if (b.dataset.area === known) { b.setAttribute('aria-current', 'true'); } else { b.removeAttribute('aria-current'); }
		}
		const panel = document.getElementById('settingsPanel');
		if (panel) { panel.scrollTop = 0; }
	}

	if (settingsWindow) {
		const panel = document.getElementById('settingsPanel');
		const nav = document.createElement('nav');
		nav.className = 'area-nav';
		nav.setAttribute('aria-label', 'Settings');
		const title = document.createElement('h1');
		title.textContent = 'Settings';
		nav.appendChild(title);
		for (const [id, label] of AREAS) {
			const b = document.createElement('button');
			b.dataset.area = id;
			b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' + AREA_ICONS[id] + '</svg>';
			b.appendChild(document.createTextNode(label));
			b.addEventListener('click', () => showArea(id));
			nav.appendChild(b);
		}
		panel.insertBefore(nav, panel.firstChild);
		showArea('providers');
	}

	/**
	 * Replaces the visible mode dropdown with a segmented control. The real <select> stays in the
	 * page (hidden): the chat UI reads and writes it, so each segment sets it and fires 'change',
	 * and a hook on its value keeps the segments in step when the UI changes the mode itself.
	 */
	function buildModeSwitch() {
		const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('modeSelect'));
		if (!sel || sel.dataset.seg) { return; }
		sel.dataset.seg = '1';
		const seg = document.createElement('div');
		seg.className = 'seg';
		seg.setAttribute('role', 'radiogroup');
		seg.setAttribute('aria-label', 'Chat mode');
		const thumb = document.createElement('span');
		thumb.className = 'seg-thumb';
		seg.appendChild(thumb);
		const buttons = [];
		for (const opt of Array.from(sel.options)) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'seg-btn';
			b.dataset.value = opt.value;
			b.textContent = opt.textContent;
			b.setAttribute('role', 'radio');
			b.addEventListener('click', () => {
				sel.value = opt.value;
				sel.dispatchEvent(new Event('change', { bubbles: true }));
			});
			seg.appendChild(b);
			buttons.push(b);
		}
		sel.parentNode.insertBefore(seg, sel);
		sel.classList.add('seg-source');
		const sync = () => {
			for (const b of buttons) {
				const on = b.dataset.value === sel.value;
				b.setAttribute('aria-checked', String(on));
				b.classList.toggle('on', on);
				if (on) {
					thumb.style.setProperty('--x', b.offsetLeft + 'px');
					thumb.style.setProperty('--w', b.offsetWidth + 'px');
					thumb.classList.add('ready');
				}
			}
		};
		const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
		Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(sel); }, set(v) { desc.set.call(sel, v); sync(); } });
		sel.addEventListener('change', sync);
		window.addEventListener('resize', sync);
		if (document.fonts && document.fonts.ready) { document.fonts.ready.then(sync); }
		sync();
	}
	if (!settingsWindow) { buildModeSwitch(); }

	/**
	 * Replaces a native <select> with a styled button that opens a popover menu. The select stays
	 * in the page, hidden, as the source of truth: the chat UI fills it and reads it, so choosing an
	 * item sets its value and fires 'change', and a watcher keeps the button's label, visibility
	 * and tooltip in step with whatever the UI does to the select.
	 * @param {HTMLSelectElement} sel
	 */
	function buildPicker(sel) {
		if (sel.dataset.picker || !window.StormMenu) { return; }
		sel.dataset.picker = '1';
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'picker ' + sel.className.replace(/\bhidden\b/, '').trim();
		btn.id = sel.id + 'Button';
		btn.setAttribute('aria-haspopup', 'menu');
		btn.setAttribute('aria-expanded', 'false');
		const text = document.createElement('span');
		text.className = 'picker-label';
		btn.appendChild(text);
		const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		chev.setAttribute('viewBox', '0 0 16 16');
		chev.setAttribute('class', 'picker-chev');
		chev.setAttribute('aria-hidden', 'true');
		const cp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		cp.setAttribute('d', 'M4 6.5l4 4 4-4');
		chev.appendChild(cp);
		btn.appendChild(chev);
		sel.parentNode.insertBefore(btn, sel);
		sel.classList.add('seg-source');

		/** "name  · tools  · free" becomes a label plus badges. */
		const split = raw => {
			const parts = String(raw).split(/\s+·\s+/).map(x => x.trim()).filter(Boolean);
			return { label: parts[0] || '', badges: parts.slice(1) };
		};
		const sync = () => {
			const opt = sel.options[sel.selectedIndex];
			text.textContent = opt ? split(opt.textContent).label : '';
			btn.disabled = sel.disabled;
			btn.classList.toggle('hidden', sel.classList.contains('hidden'));
			const title = sel.getAttribute('title') || sel.dataset.tip;
			if (title) { btn.dataset.tip = title; btn.removeAttribute('title'); sel.removeAttribute('title'); sel.dataset.tip = title; }
		};
		/** One-line explanations for options whose label alone does not say what they do. */
		const DETAILS = {
			always: 'Asks before every file write and command',
			'auto-edits': 'Edits files freely, asks before running commands',
			yolo: 'Never asks. Hard guardrails still apply',
		};
		const items = () => {
			/** @type {any[]} */
			const out = [];
			const addOption = o => {
				const parts = split(o.textContent);
				out.push({ label: parts.label, badges: parts.badges, detail: sel.id === 'approvalSelect' ? DETAILS[o.value] : undefined, checked: o.selected, disabled: o.disabled, onSelect: () => {
					sel.value = o.value;
					sel.dispatchEvent(new Event('change', { bubbles: true }));
					sync();
				} });
			};
			for (const child of Array.from(sel.children)) {
				if (child.tagName === 'OPTGROUP') {
					out.push({ type: 'header', label: child.getAttribute('label') || '' });
					for (const o of Array.from(child.children)) { addOption(o); }
				} else if (child.tagName === 'OPTION') {
					addOption(child);
				}
			}
			return out;
		};
		const openMenu = () => {
			const list = items();
			window.StormMenu.open({
				anchor: btn, placement: 'top-start', items: list, ariaLabel: btn.dataset.tip || 'Choose',
				searchable: list.filter(i => i.type !== 'header').length > 7, searchPlaceholder: 'Search…', minWidth: Math.max(220, btn.offsetWidth), maxWidth: 420,
			});
		};
		btn.addEventListener('click', openMenu);
		btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); } });
		const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
		Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(sel); }, set(v) { desc.set.call(sel, v); sync(); } });
		new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled', 'title'] });
		sel.addEventListener('change', sync);
		sync();
	}
	if (!settingsWindow) {
		for (const id of ['providerSelect', 'modelSelect', 'approvalSelect']) {
			const el = /** @type {HTMLSelectElement | null} */ (document.getElementById(id));
			if (el) { buildPicker(el); }
		}
	}
	if (window.StormMenu) { window.StormMenu.tooltips(); }

	// ------------------------------------------------------------------ message actions

	const COPY_ICON = 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7';
	const CHECK_ICON = 'M3.5 8.5l3 3 6-7';
	/** @param {string} d */
	function actionIcon(d) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
		return svg;
	}

	/** @param {string} text */
	async function copyText(text) {
		try { await navigator.clipboard.writeText(text); return true; } catch (e) {
			// Clipboard permission can be refused in a frame; fall back to a selection copy.
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
			document.body.appendChild(ta);
			ta.select();
			let ok = false;
			try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
			ta.remove();
			return ok;
		}
	}

	/** Adds a hover copy button to each message that does not have one. */
	function decorateMessages() {
		for (const msg of document.querySelectorAll('#messages > .message')) {
			if (msg.querySelector(':scope > .msg-actions') || msg.classList.contains('info')) { continue; }
			const bar = document.createElement('div');
			bar.className = 'msg-actions';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'msg-copy';
			btn.title = 'Copy message';
			btn.setAttribute('aria-label', 'Copy message');
			btn.appendChild(actionIcon(COPY_ICON));
			btn.addEventListener('click', async () => {
				const body = msg.querySelector('.body');
				if (!body) { return; }
				if (await copyText(/** @type {HTMLElement} */ (body).innerText.trim())) {
					btn.classList.add('done');
					btn.replaceChildren(actionIcon(CHECK_ICON));
					btn.dataset.tip = 'Copied';
					setTimeout(() => { btn.classList.remove('done'); btn.replaceChildren(actionIcon(COPY_ICON)); btn.dataset.tip = 'Copy message'; }, 1400);
				}
			});
			bar.appendChild(btn);
			msg.appendChild(bar);
		}
	}
	const messagesEl = document.getElementById('messages');
	if (!settingsWindow && messagesEl) {
		new MutationObserver(decorateMessages).observe(messagesEl, { childList: true });
		decorateMessages();
	}

	// ------------------------------------------------------------------ context menus

	const CTX = {
		copy: COPY_ICON, plus: 'M8 3v10M3 8h10', close: 'M4 4l8 8M12 4l-8 8', all: 'M3 3h10v10H3zM5.5 6h5M5.5 8h5M5.5 10h3',
	};

	/**
	 * Right-click menus for what the browser has no sensible menu for: messages, code blocks and
	 * chat tabs. Text fields are left alone, so the app's native Cut/Copy/Paste menu serves them.
	 */
	document.addEventListener('contextmenu', e => {
		if (!window.StormMenu || !(e.target instanceof Element)) { return; }
		const t = e.target;
		if (t.closest('input, textarea, select, [contenteditable="true"], .sc-menu')) { return; }
		const selection = String(window.getSelection() || '').trim();
		/** @type {any[]} */
		const items = [];
		const tab = /** @type {HTMLElement | null} */ (t.closest('.chat-tab'));
		const pre = t.closest('pre');
		const msg = t.closest('.message');
		if (tab) {
			items.push({ label: 'New chat', icon: CTX.plus, onSelect: () => { const add = document.querySelector('.tab-add'); if (add) { /** @type {HTMLElement} */ (add).click(); } } });
			items.push({ label: 'Close chat', icon: CTX.close, onSelect: () => { const x = tab.querySelector('.tab-close'); if (x) { /** @type {HTMLElement} */ (x).click(); } } });
		} else {
			if (selection) { items.push({ label: 'Copy selection', icon: CTX.copy, shortcut: ['Ctrl', 'C'], onSelect: () => { void copyText(selection); } }); }
			if (pre) {
				const code = pre.querySelector('code');
				items.push({ label: 'Copy code', icon: CTX.copy, onSelect: () => { void copyText(code ? code.textContent || '' : ''); } });
			}
			if (msg) {
				const body = msg.querySelector('.body');
				items.push({ label: 'Copy message', icon: CTX.copy, onSelect: () => { if (body) { void copyText(/** @type {HTMLElement} */ (body).innerText.trim()); } } });
			}
			if (msg || pre) {
				items.push({ type: 'sep' });
				items.push({ label: 'Select all', icon: CTX.all, shortcut: ['Ctrl', 'A'], onSelect: () => { const r = document.createRange(); r.selectNodeContents(messagesEl || document.body); const sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(r); } } });
			}
		}
		if (!items.length) { return; }
		e.preventDefault();
		window.StormMenu.open({ anchor: { x: e.clientX, y: e.clientY }, placement: 'point', items, minWidth: 190, ariaLabel: 'Actions' });
	});



	window.addEventListener('stormcoder-nav', e => {
		const d = e.detail || {};
		if (d.theme) { document.documentElement.dataset.theme = d.theme; }
		if (settingsWindow && d.area) { showArea(d.area); }
		if (!settingsWindow && d.to) {
			const history = document.getElementById('historyPanel');
			const open = history && !history.classList.contains('hidden');
			if (d.to === 'history' && !open) { document.getElementById('historyButton').click(); }
			if (d.to === 'chat' && open) { document.getElementById('closeHistory').click(); }
		}
	});
}());
