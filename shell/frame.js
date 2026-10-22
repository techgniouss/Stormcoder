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
			b.textContent = label;
			b.addEventListener('click', () => showArea(id));
			nav.appendChild(b);
		}
		panel.insertBefore(nav, panel.firstChild);
		showArea('providers');
	}

	window.addEventListener('stormcoder-nav', e => {
		const d = e.detail || {};
		if (settingsWindow && d.area) { showArea(d.area); }
		if (!settingsWindow && d.to) {
			const history = document.getElementById('historyPanel');
			const open = history && !history.classList.contains('hidden');
			if (d.to === 'history' && !open) { document.getElementById('historyButton').click(); }
			if (d.to === 'chat' && open) { document.getElementById('closeHistory').click(); }
		}
	});
}());
