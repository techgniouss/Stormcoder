// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Popover menus and tooltips, shared by the shell page and both chat frames.
 *
 * `StormMenu.open({ anchor, items })` shows one anchored menu at a time: arrow-key navigation,
 * type-to-search, hover highlight, an animated open and close, and edge-aware placement (it flips
 * above or below and is kept inside the window). Text is only ever written with textContent, so
 * labels from the engine (model names, file paths) cannot inject markup.
 *
 * `StormMenu.tooltips()` swaps the browser's plain `title` tooltips for styled ones.
 */
(function () {
	'use strict';

	const SVG_NS = 'http://www.w3.org/2000/svg';
	const OPEN_MS = 180;
	const CLOSE_MS = 120;

	/**
	 * @typedef {{
	 *   type?: 'item' | 'sep' | 'header',
	 *   label?: string, detail?: string, badges?: string[], shortcut?: string[],
	 *   icon?: string, checked?: boolean, disabled?: boolean, danger?: boolean,
	 *   onSelect?: () => void,
	 * }} MenuItem
	 * @typedef {{
	 *   anchor: Element | { x: number, y: number },
	 *   items: MenuItem[],
	 *   placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'point',
	 *   searchable?: boolean, searchPlaceholder?: string, minWidth?: number, maxWidth?: number,
	 *   ariaLabel?: string, className?: string, onClose?: () => void,
	 * }} MenuOptions
	 */

	/** @type {{ close: (instant?: boolean) => void } | null} */
	let current = null;

	/**
	 * @param {string} name
	 * @param {Record<string, string>} [attrs]
	 */
	function svg(name, attrs) {
		const el = document.createElementNS(SVG_NS, name);
		for (const [k, v] of Object.entries(attrs || {})) { el.setAttribute(k, v); }
		return el;
	}

	/** @param {string} path 16px outline icon path data */
	function iconEl(path) {
		const s = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', class: 'sc-ico' });
		const p = svg('path', { d: path });
		s.appendChild(p);
		return s;
	}

	/** Writes `text` into `el`, wrapping each query word it contains in <mark>. */
	function markMatches(el, text, query) {
		const words = query.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		if (!words.length) { el.textContent = text; return; }
		const re = new RegExp('(' + words.join('|') + ')', 'ig');
		let last = 0;
		for (const m of text.matchAll(re)) {
			const index = m.index || 0;
			if (index > last) { el.appendChild(document.createTextNode(text.slice(last, index))); }
			const mark = document.createElement('mark');
			mark.textContent = m[0];
			el.appendChild(mark);
			last = index + m[0].length;
		}
		if (last < text.length) { el.appendChild(document.createTextNode(text.slice(last))); }
	}

	/** @param {MenuOptions} opts */
	function open(opts) {
		if (current) { current.close(true); }
		const items = opts.items;
		const root = document.createElement('div');
		root.className = 'sc-menu' + (opts.className ? ' ' + opts.className : '');
		root.setAttribute('role', 'menu');
		if (opts.ariaLabel) { root.setAttribute('aria-label', opts.ariaLabel); }
		root.tabIndex = -1;
		if (opts.minWidth) { root.style.minWidth = opts.minWidth + 'px'; }
		if (opts.maxWidth) { root.style.maxWidth = opts.maxWidth + 'px'; }

		/** @type {HTMLInputElement | null} */
		let search = null;
		if (opts.searchable) {
			const wrap = document.createElement('div');
			wrap.className = 'sc-menu-search';
			wrap.appendChild(iconEl('M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11 11l3 3'));
			search = document.createElement('input');
			search.type = 'text';
			search.placeholder = opts.searchPlaceholder || 'Search…';
			search.autocomplete = 'off';
			search.spellcheck = false;
			search.setAttribute('aria-label', opts.searchPlaceholder || 'Search');
			wrap.appendChild(search);
			root.appendChild(wrap);
		}
		const list = document.createElement('div');
		list.className = 'sc-menu-list';
		root.appendChild(list);

		/** Indexes (into `items`) currently shown and selectable, in order. */
		let selectable = [];
		let active = -1;
		/** @type {HTMLElement[]} */
		let nodes = [];

		function render() {
			const q = search ? search.value.trim().toLowerCase() : '';
			list.textContent = '';
			nodes = [];
			selectable = [];
			let pendingHeader = null;
			let shown = 0;
			items.forEach((it, index) => {
				const kind = it.type || 'item';
				if (kind === 'sep') {
					if (!q && shown) { const hr = document.createElement('div'); hr.className = 'sc-sep'; hr.setAttribute('role', 'separator'); list.appendChild(hr); }
					return;
				}
				if (kind === 'header') {
					pendingHeader = it;
					return;
				}
				if (q) {
					const hay = ((it.label || '') + ' ' + (it.detail || '') + ' ' + (it.badges || []).join(' ')).toLowerCase();
					if (!q.split(/\s+/).every(w => hay.includes(w))) { return; }
				}
				if (pendingHeader) {
					const h = document.createElement('div');
					h.className = 'sc-head';
					h.textContent = pendingHeader.label || '';
					list.appendChild(h);
					pendingHeader = null;
				}
				const row = document.createElement('div');
				row.className = 'sc-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '');
				row.setAttribute('role', opts.searchable || it.checked !== undefined ? 'menuitemradio' : 'menuitem');
				if (it.checked !== undefined) { row.setAttribute('aria-checked', String(!!it.checked)); }
				if (it.disabled) { row.setAttribute('aria-disabled', 'true'); }
				row.id = 'sc-i-' + index;
				row.style.setProperty('--i', String(Math.min(shown, 12)));
				if (it.icon) { row.appendChild(iconEl(it.icon)); } else { const sp = document.createElement('span'); sp.className = 'sc-ico-gap'; row.appendChild(sp); }
				const text = document.createElement('span');
				text.className = 'sc-text';
				const label = document.createElement('span');
				label.className = 'sc-label';
				markMatches(label, it.label || '', q);
				text.appendChild(label);
				if (it.detail) {
					const d = document.createElement('span');
					d.className = 'sc-detail';
					d.textContent = it.detail;
					text.appendChild(d);
				}
				row.appendChild(text);
				for (const b of it.badges || []) {
					const badge = document.createElement('span');
					badge.className = 'sc-badge';
					badge.textContent = b;
					row.appendChild(badge);
				}
				if (it.shortcut && it.shortcut.length) {
					const keys = document.createElement('span');
					keys.className = 'sc-keys';
					for (const k of it.shortcut) { const kb = document.createElement('kbd'); kb.textContent = k; keys.appendChild(kb); }
					row.appendChild(keys);
				}
				if (it.checked) {
					const c = svg('svg', { viewBox: '0 0 16 16', class: 'sc-check', 'aria-hidden': 'true' });
					c.appendChild(svg('path', { d: 'M3.5 8.5l3 3 6-7' }));
					row.appendChild(c);
				}
				row.addEventListener('mousemove', () => { if (!it.disabled) { setActive(nodes.indexOf(row)); } });
				row.addEventListener('click', () => choose(index));
				list.appendChild(row);
				nodes.push(row);
				selectable.push(index);
				shown++;
			});
			if (!shown) {
				const empty = document.createElement('div');
				empty.className = 'sc-empty';
				empty.textContent = 'Nothing matches';
				list.appendChild(empty);
			}
			const firstChecked = selectable.findIndex(i => items[i].checked);
			setActive(q ? selectable.findIndex(i => !items[i].disabled) : (firstChecked >= 0 ? firstChecked : selectable.findIndex(i => !items[i].disabled)), !q);
		}

		/** @param {number} n @param {boolean} [scroll] */
		function setActive(n, scroll) {
			active = n;
			nodes.forEach((el, i) => el.classList.toggle('active', i === n));
			const el = nodes[n];
			const owner = search || root;
			if (el) {
				owner.setAttribute('aria-activedescendant', el.id);
				if (scroll !== false) { el.scrollIntoView({ block: 'nearest' }); }
			}
		}

		/** @param {number} dir */
		function move(dir) {
			if (!selectable.length) { return; }
			let n = active;
			for (let i = 0; i < selectable.length; i++) {
				n = (n + dir + selectable.length) % selectable.length;
				if (!items[selectable[n]].disabled) { setActive(n); return; }
			}
		}

		/** @param {number} index */
		function choose(index) {
			const it = items[index];
			if (!it || it.disabled) { return; }
			close();
			if (it.onSelect) { it.onSelect(); }
		}

		let closed = false;
		const anchorEl = opts.anchor instanceof Element ? opts.anchor : null;

		/** @param {boolean} [instant] */
		function close(instant) {
			if (closed) { return; }
			closed = true;
			if (current && current.close === close) { current = null; }
			document.removeEventListener('mousedown', onOutside, true);
			document.removeEventListener('keydown', onKey, true);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('resize', onBlur);
			document.removeEventListener('scroll', onScroll, true);
			root.classList.remove('open');
			if (anchorEl) { anchorEl.setAttribute('aria-expanded', 'false'); }
			const done = () => { root.remove(); };
			if (instant) { done(); } else { root.classList.add('closing'); setTimeout(done, CLOSE_MS); }
			if (opts.onClose) { opts.onClose(); }
			if (!instant && anchorEl && document.activeElement === document.body) { try { /** @type {HTMLElement} */ (anchorEl).focus({ preventScroll: true }); } catch (e) { /* element gone */ } }
		}

		/** @param {MouseEvent} e */
		function onOutside(e) { if (!root.contains(/** @type {Node} */ (e.target))) { close(); } }
		function onBlur() { close(true); }
		/** @param {Event} e */
		function onScroll(e) { if (!root.contains(/** @type {Node} */ (e.target))) { close(true); } }
		/** @param {KeyboardEvent} e */
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
			if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
			if (e.key === 'Home') { e.preventDefault(); setActive(selectable.findIndex(i => !items[i].disabled)); return; }
			if (e.key === 'End') { e.preventDefault(); setActive(selectable.length - 1); return; }
			if (e.key === 'Enter' || (e.key === ' ' && !search)) { e.preventDefault(); if (active >= 0) { choose(selectable[active]); } return; }
			if (e.key === 'Tab') { close(); return; }
			if (!search && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
				// Type-ahead: jump to the next item whose label starts with the typed letter.
				const start = active + 1;
				for (let i = 0; i < selectable.length; i++) {
					const n = (start + i) % selectable.length;
					if ((items[selectable[n]].label || '').toLowerCase().startsWith(e.key.toLowerCase())) { setActive(n); break; }
				}
			}
		}

		if (search) { search.addEventListener('input', render); }
		document.body.appendChild(root);
		render();
		position(root, opts);
		document.addEventListener('mousedown', onOutside, true);
		document.addEventListener('keydown', onKey, true);
		window.addEventListener('blur', onBlur);
		window.addEventListener('resize', onBlur);
		document.addEventListener('scroll', onScroll, true);
		if (anchorEl) { anchorEl.setAttribute('aria-haspopup', 'menu'); anchorEl.setAttribute('aria-expanded', 'true'); }
		requestAnimationFrame(() => { root.classList.add('open'); });
		(search || root).focus({ preventScroll: true });
		current = { close };
		return { close, el: root };
	}

	/**
	 * Places the menu next to its anchor: below by default, flipped above when there is no room,
	 * and kept at least 8px inside the window. Sets the transform origin so it grows from the anchor.
	 * @param {HTMLElement} root @param {MenuOptions} opts
	 */
	function position(root, opts) {
		const margin = 8;
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		const a = opts.anchor instanceof Element ? opts.anchor.getBoundingClientRect() : new DOMRect(opts.anchor.x, opts.anchor.y, 0, 0);
		// Layout size, not getBoundingClientRect: the menu is mid-way through a scale transition here.
		const box = { width: root.offsetWidth, height: root.offsetHeight };
		const place = opts.placement || (opts.anchor instanceof Element ? 'bottom-start' : 'point');
		const gap = 6;
		let top;
		let left;
		let vertical = 'bottom';
		if (place === 'right-start') {
			left = a.right + gap;
			top = a.top;
		} else {
			const wantTop = place.startsWith('top');
			const roomBelow = vh - a.bottom - margin;
			const roomAbove = a.top - margin;
			vertical = wantTop ? (roomAbove >= box.height || roomAbove > roomBelow ? 'top' : 'bottom') : (roomBelow >= box.height || roomBelow >= roomAbove ? 'bottom' : 'top');
			top = vertical === 'bottom' ? a.bottom + (place === 'point' ? 0 : gap) : a.top - box.height - (place === 'point' ? 0 : gap);
			left = place.endsWith('end') ? a.right - box.width : a.left;
		}
		if (left + box.width > vw - margin) { left = vw - margin - box.width; }
		if (left < margin) { left = margin; }
		if (top + box.height > vh - margin) { top = Math.max(margin, vh - margin - box.height); }
		if (top < margin) { top = margin; }
		// The list scrolls when the window is shorter than the menu.
		const list = /** @type {HTMLElement} */ (root.querySelector('.sc-menu-list'));
		if (list) { list.style.maxHeight = Math.max(120, vh - top - margin - (root.querySelector('.sc-menu-search') ? 48 : 12)) + 'px'; }
		root.style.left = Math.round(left) + 'px';
		root.style.top = Math.round(top) + 'px';
		root.style.setProperty('--origin', (vertical === 'bottom' ? 'top ' : 'bottom ') + (place.endsWith('end') ? 'right' : 'left'));
		root.dataset.side = vertical;
	}

	// ------------------------------------------------------------------ tooltips

	/**
	 * Styled tooltips for anything with a `title` or `data-tip`. The title is moved to data-tip on
	 * first hover so the browser's own tooltip never appears alongside ours.
	 */
	function tooltips() {
		/** @type {HTMLElement | null} */
		let tip = null;
		let timer = 0;
		let lastShown = 0;

		function hide() {
			clearTimeout(timer);
			if (tip) {
				const t = tip;
				tip = null;
				t.classList.remove('open');
				setTimeout(() => t.remove(), 100);
			}
		}

		/** @param {HTMLElement} el @param {string} text */
		function show(el, text) {
			hide();
			const t = document.createElement('div');
			t.className = 'sc-tip';
			t.setAttribute('role', 'tooltip');
			t.textContent = text;
			document.body.appendChild(t);
			const a = el.getBoundingClientRect();
			const w = t.offsetWidth;
			const h = t.offsetHeight;
			const vw = document.documentElement.clientWidth;
			if (el.dataset.tipSide === 'right') {
				// Beside the control, vertically centred: for the rail down the window's left edge.
				t.style.left = Math.round(a.right + 10) + 'px';
				t.style.top = Math.round(a.top + a.height / 2 - h / 2) + 'px';
				t.dataset.side = 'right';
			} else {
				const above = a.top - h - 10 >= 6;
				const left = Math.min(Math.max(6, a.left + a.width / 2 - w / 2), vw - w - 6);
				t.style.left = Math.round(left) + 'px';
				t.style.top = Math.round(above ? a.top - h - 8 : a.bottom + 8) + 'px';
				t.dataset.side = above ? 'top' : 'bottom';
			}
			requestAnimationFrame(() => t.classList.add('open'));
			tip = t;
			lastShown = Date.now();
		}

		document.addEventListener('mouseover', e => {
			const target = e.target instanceof Element ? e.target : null;
			const el = /** @type {HTMLElement | null} */ (target && target.closest('[title], [data-tip]'));
			if (!el || el.closest('.sc-menu')) { return; }
			const title = el.getAttribute('title');
			if (title) {
				el.dataset.tip = title;
				el.removeAttribute('title');
				if (!el.getAttribute('aria-label') && !(el.textContent || '').trim()) { el.setAttribute('aria-label', title); }
			}
			const text = el.dataset.tip;
			if (!text) { return; }
			clearTimeout(timer);
			// Moving between neighbouring controls shows the next tip at once instead of re-waiting.
			timer = window.setTimeout(() => show(el, text), Date.now() - lastShown < 350 ? 40 : 450);
		}, true);
		document.addEventListener('mouseout', e => {
			const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
			if (t && !t.contains(/** @type {Node | null} */ (e.relatedTarget))) { hide(); }
		}, true);
		for (const type of ['mousedown', 'keydown', 'wheel']) { window.addEventListener(type, hide, true); }
		// Window blur only (blur does not bubble): an element losing focus, such as a closing menu, must not cancel the next hover.
		window.addEventListener('blur', hide);
	}

	// @ts-ignore: shared global, like the other media modules
	globalThis.StormMenu = { open, tooltips, close: () => { if (current) { current.close(true); } } };
}());
