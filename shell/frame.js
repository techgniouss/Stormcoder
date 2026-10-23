// Loaded last inside the chat and settings frames. Adds what the desktop shell needs on top of
// the unchanged chat UI: one settings area at a time (with a left navigation), and the rail's
// requests to show History or switch area.
(function () {
	'use strict';
	const settingsWindow = document.body.classList.contains('settings-window');
	const AREAS = [
		['providers', 'Providers'], ['general', 'General'], ['permissions', 'Agent permissions'],
		['skills', 'Skills'], ['mcp', 'MCP servers'], ['auto', 'Auto routing'], ['remote', 'Remote control'],
	];
	/** 16px outline icons, one per settings area. */
	const AREA_ICONS = {
		providers: '<path d="M3 5.5h10M3 10.5h10"/><circle cx="6" cy="5.5" r="1.6"/><circle cx="10.5" cy="10.5" r="1.6"/>',
		general: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
		permissions: '<path d="M8 1.8l5 1.8v4c0 3-2.1 5.1-5 6.6C5.1 12.7 3 10.6 3 7.6v-4z"/><path d="M5.8 8l1.6 1.6L10.4 6.6"/>',
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
