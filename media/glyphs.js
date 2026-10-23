// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The little drawings shown beside the agent's "thinking" verb, one set per kind of verb:
 *
 *  - `asgard`: a war hammer, a rune axe, a winged helm and a golden bolt, for the legend-flavoured
 *    lines ("Charging Stormbreaker", "Assembling the Avengers"). Drawn for this app on a 32 grid
 *    with one outline weight, steel and gold gradients, and a single accent rune on each, so they
 *    read as a set and stay legible at 20px on both dark and light themes.
 *  - `storm`: a bolt, code brackets, an orbiting charge and a storm cloud, for the storm-and-code
 *    lines ("Charging the coil", "Tempering the diff"). Line drawings in the theme accent.
 *
 * Gradients live once in a hidden shared <defs> block (inserted at load) so every glyph can
 * reference them without repeating ids; if the block is missing, fills fall back to flat colours.
 * Each class gets its own animation in main.css.
 */
(function () {
	'use strict';

	const PX = 20;
	const OUT = '#1d2437';

	const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>`
		+ '<linearGradient id="sc-steel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f8fd"/><stop offset=".5" stop-color="#b4c3d9"/><stop offset="1" stop-color="#7488a8"/></linearGradient>'
		+ '<linearGradient id="sc-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe493"/><stop offset=".55" stop-color="#e3ae35"/><stop offset="1" stop-color="#a8741a"/></linearGradient>'
		+ '<linearGradient id="sc-wood" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d09459"/><stop offset="1" stop-color="#85552b"/></linearGradient>'
		+ '<linearGradient id="sc-bolt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4b8"/><stop offset=".5" stop-color="#f6bc3a"/><stop offset="1" stop-color="#d9860f"/></linearGradient>'
		+ '</defs></svg>';

	/** Opens a 32-grid glyph. @param {string} cls */
	const open32 = cls => `<svg class="thor-glyph ${cls}" viewBox="0 0 32 32" width="${PX}" height="${PX}" aria-hidden="true">`;
	/** Opens a 24-grid line glyph. @param {string} cls */
	const open24 = cls => `<svg class="storm-glyph ${cls}" viewBox="0 0 24 24" width="${PX}" height="${PX}" aria-hidden="true">`;
	const stroke = `stroke="${OUT}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"`;
	/** The accent rune each metal glyph carries: it follows the theme. */
	const rune = 'style="fill:var(--vscode-charts-blue,#4ea1ff)"';

	const hammer = open32('hammer')
		// Handle, grip bands and pommel
		+ `<rect x="14" y="14" width="4" height="14" rx="1.6" fill="url(#sc-wood)" ${stroke}/>`
		+ `<path d="M14.3 18h3.4M14.3 21h3.4M14.3 24h3.4" stroke="${OUT}" stroke-width="1" opacity=".45" fill="none"/>`
		+ `<circle cx="16" cy="29.2" r="1.9" fill="url(#sc-gold)" ${stroke}/>`
		// Head with side bands and a bolt rune
		+ `<rect x="4.5" y="3.5" width="23" height="11.5" rx="3" fill="url(#sc-steel)" ${stroke}/>`
		+ `<path d="M9 4v10.5M23 4v10.5" stroke="${OUT}" stroke-width="1" opacity=".3" fill="none"/>`
		+ `<path d="M17.1 5.6 13.7 9.9h2.7l-1 3.6 3.8-4.7h-2.8Z" ${rune}/>`
		+ '</svg>';

	const axe = open32('axe')
		// Shaft with a gold cap, a broad bearded blade with a glowing edge, and a back spike
		+ `<rect x="15" y="2.6" width="3.2" height="26.4" rx="1.5" fill="url(#sc-wood)" ${stroke}/>`
		+ `<path d="M15 4.6C10.4 3 6 4.4 3.6 8l2.2 5.8L3.6 19.6C6 23.2 10.4 24.6 15 23Z" fill="url(#sc-steel)" ${stroke}/>`
		+ '<path d="M5.6 9.2C7.4 7.4 9.6 6.6 12 6.6M5.6 18.4c1.8 1.8 4 2.6 6.4 2.6" fill="none" stroke="var(--vscode-charts-blue,#4ea1ff)" stroke-width="1.5" stroke-linecap="round"/>'
		+ `<path d="M18.2 9.4 26.4 8.4l-2.4 5.2 2.4 5.2-8.2-1Z" fill="url(#sc-steel)" ${stroke}/>`
		+ `<rect x="14.6" y="26.6" width="4" height="3.2" rx="1" fill="url(#sc-gold)" ${stroke}/>`
		+ '</svg>';

	const helm = open32('helm')
		// Wings (behind), dome, gold brim, nose guard and a crest ridge
		+ `<path d="M7.3 15.2C4 13.8 2 10.2 2.3 5.6c3.6 1.2 6 3.6 6.9 6.8Z" fill="#f4f7fb" ${stroke}/>`
		+ `<path d="M24.7 15.2c3.3-1.4 5.3-5 5-9.6-3.6 1.2-6 3.6-6.9 6.8Z" fill="#f4f7fb" ${stroke}/>`
		+ `<path d="M4.6 8.4c1.6.8 2.9 2 3.6 3.6M27.4 8.4c-1.6.8-2.9 2-3.6 3.6" stroke="${OUT}" stroke-width="1" opacity=".4" fill="none" stroke-linecap="round"/>`
		+ `<path d="M16 5.6c-5.7 0-9.2 4.1-9.2 9.6v5.6h18.4v-5.6C25.2 9.7 21.7 5.6 16 5.6Z" fill="url(#sc-steel)" ${stroke}/>`
		+ `<path d="M16 5.8v14.4" stroke="${OUT}" stroke-width="1" opacity=".3" fill="none"/>`
		+ `<rect x="5.4" y="19" width="21.2" height="4.4" rx="2.2" fill="url(#sc-gold)" ${stroke}/>`
		+ `<path d="M14.4 23.4h3.2v5.3a1.6 1.6 0 0 1-3.2 0Z" fill="url(#sc-steel)" ${stroke}/>`
		+ `<circle cx="16" cy="21.2" r="1.15" ${rune}/>`
		+ '</svg>';

	const goldbolt = open32('goldbolt')
		+ `<path d="M18.6 2 7.4 17.2h7.1L12.3 30 25 13.4h-7.3Z" fill="url(#sc-bolt)" ${stroke}/>`
		+ '<path d="M17.4 4.6 10.2 14.4h3.4Z" fill="#fff" opacity=".45"/>'
		+ '</svg>';

	const bolt = open24('bolt')
		+ '<path d="M14 2 5 14h6l-1.5 8 9.5-13h-6Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
		+ '</svg>';

	const brackets = open24('brackets')
		+ '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
		+ '<path class="l" d="M8 7 3 12l5 5"/><path class="r" d="m16 7 5 5-5 5"/><path class="s" d="m13.5 5.5-3 13"/>'
		+ '</g></svg>';

	const orbit = open24('orbit')
		+ '<circle cx="12" cy="12" r="2.2" fill="currentColor"/>'
		+ '<g fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(-30 12 12)"/>'
		+ '<ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(30 12 12)"/></g></svg>';

	const cloud = open24('cloud')
		+ '<path d="M7 16a4.2 4.2 0 0 1-.7-8.3 5.6 5.6 0 0 1 10.8 1.3A3.5 3.5 0 0 1 17 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path class="b" d="m12.6 12-2.4 4.4h3l-1.6 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '</svg>';

	const asgard = [hammer, axe, helm, goldbolt];
	const storm = [bolt, brackets, orbit, cloud];

	/** Adds the shared gradient definitions once. */
	function ensureDefs() {
		if (document.getElementById('sc-steel')) { return; }
		const host = document.createElement('div');
		host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
		host.innerHTML = DEFS;
		(document.body || document.documentElement).appendChild(host);
	}
	if (typeof document !== 'undefined') {
		if (document.body) { ensureDefs(); } else { document.addEventListener('DOMContentLoaded', ensureDefs); }
	}

	// @ts-ignore: shared global, like the other media modules
	globalThis.StormGlyphs = { asgard, storm, all: [...asgard, ...storm], ensureDefs };
}());
