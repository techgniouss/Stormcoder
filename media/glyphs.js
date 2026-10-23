// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The drawings shown beside the agent's "thinking" verb, one set per kind of verb:
 *
 *  - `asgard`: a war hammer, a lightning axe, a winged helm and a golden bolt.
 *  - `storm`: a thundercloud, a star, a ringed planet, glowing code brackets and a plasma bolt.
 *  - `villain` and `spiderman`: Doctor Doom's mask and an Infinity-style gauntlet; a spider, a web and a
 *    masked face, each for its own lines.
 *  - `doom`: a skull, a falling meteor, a black hole, an hourglass and a cracking planet, for the
 *    doomsday lines ("Counting down to doomsday", "Feeding the black hole").
 *
 * They are drawn as lit objects rather than icons: every one sits on a 64 grid, is shaded with
 * shared gradients (brushed steel with a hard horizon reflection, gold, grained wood, bone, rock,
 * lava, glass), carries a specular edge and a dark contact outline, and has a glowing element that
 * its animation drives (rune, edge, ember eyes, lava, sand). The gradients live once in a hidden
 * <defs> block inserted at load, so a glyph never repeats an id; where the block is missing the
 * fills fall back to nothing but the outlines stay legible. No clipPath or per-glyph id is used,
 * because the same glyph is on screen more than once (status strip and tool card).
 */
(function () {
	'use strict';

	const PX = 26;
	const OUT = '#141a29';

	/** One <stop>. @param {number} o @param {string} c @param {number} [a] */
	const stop = (o, c, a) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`;
	/** A linear gradient. @param {string} id @param {string} dir x1,y1,x2,y2 @param {string} stops */
	const lin = (id, dir, stops) => {
		const [x1, y1, x2, y2] = dir.split(',');
		return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
	};
	/** A radial gradient. @param {string} id @param {string} at cx,cy,r @param {string} stops */
	const rad = (id, at, stops) => {
		const [cx, cy, r] = at.split(',');
		return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops}</radialGradient>`;
	};

	const DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
		// Metals: a hard horizon in the steel is what makes it read as polished rather than grey.
		+ lin('sc-steel-v', '0,0,0,1', stop(0, '#ffffff') + stop(0.2, '#dbe4f0') + stop(0.48, '#8d9fba') + stop(0.5, '#6d7f9c') + stop(0.78, '#a7b6cc') + stop(1, '#566680'))
		+ lin('sc-steel-h', '0,0,1,0', stop(0, '#45546d') + stop(0.28, '#e8eef6') + stop(0.5, '#9fb0c8') + stop(1, '#3f4d66'))
		+ lin('sc-gold-h', '0,0,1,0', stop(0, '#7a4a0c') + stop(0.28, '#ffeaa6') + stop(0.55, '#e0a52c') + stop(1, '#7f500f'))
		+ lin('sc-gold-v', '0,0,0,1', stop(0, '#fff0b8') + stop(0.45, '#e8b238') + stop(0.55, '#b8801c') + stop(1, '#f1c653'))
		+ lin('sc-wood-h', '0,0,1,0', stop(0, '#4d2c12') + stop(0.3, '#c18a52') + stop(0.58, '#8c5a2b') + stop(1, '#43250e'))
		// Light and heat
		+ lin('sc-bolt', '0,0,0,1', stop(0, '#fffbe6') + stop(0.4, '#ffd54a') + stop(1, '#ee8a0c'))
		+ rad('sc-halo', '.5,.5,.5', stop(0, '#4a9bff', 0.35) + stop(1, '#2f7bff', 0))
		+ rad('sc-glow', '.5,.5,.5', stop(0, '#ffd75e', 0.55) + stop(1, '#ffb020', 0))
		+ lin('sc-rune', '0,0,0,1', stop(0, '#d6f4ff') + stop(1, '#2f8bff'))
		+ lin('sc-wing', '0,0,1,0', stop(0, '#ffffff') + stop(0.6, '#dfe7f1') + stop(1, '#9fb0c6'))
		// Doom
		+ rad('sc-bone', '.4,.3,.85', stop(0, '#fffbef') + stop(0.55, '#e3d8bf') + stop(1, '#8c806a'))
		+ rad('sc-ember', '.5,.5,.5', stop(0, '#fff6c2') + stop(0.35, '#ff9a22') + stop(1, '#b52008'))
		+ rad('sc-rock', '.35,.3,.9', stop(0, '#c9ab97') + stop(0.5, '#7b5e4d') + stop(1, '#241814'))
		+ lin('sc-flame', '.3,.8,1,.1', stop(0, '#fff6c0') + stop(0.25, '#ffb02a') + stop(0.6, '#e8470d') + stop(1, '#a31a08', 0))
		+ rad('sc-disk', '.5,.5,.5', stop(0.42, '#000000', 0) + stop(0.5, '#fff2c4') + stop(0.62, '#ffa31f') + stop(0.82, '#c4300a', 0.85) + stop(1, '#7a1604', 0))
		+ lin('sc-glass', '1,0,0,1', stop(0, '#ffffff', 0.5) + stop(0.4, '#cfe3f4', 0.14) + stop(1, '#9fc2e0', 0.3))
		+ lin('sc-sand', '0,0,0,1', stop(0, '#ff8a52') + stop(1, '#b3200a'))
		+ rad('sc-planet', '.35,.3,.95', stop(0, '#a98774') + stop(0.55, '#5a3f33') + stop(1, '#1d1210'))
		+ lin('sc-lava', '0,0,1,1', stop(0, '#fff2a8') + stop(0.5, '#ff9020') + stop(1, '#e03a0a'))
		// Storm
		+ lin('sc-cloud', '0,0,0,1', stop(0, '#e9eff8') + stop(0.55, '#8d9cb8') + stop(1, '#3d4a66'))
		+ rad('sc-star', '.5,.5,.5', stop(0, '#ffffff') + stop(0.4, '#fff1a6') + stop(1, '#ffb02a'))
		+ lin('sc-tube', '0,0,0,1', stop(0, '#bff0ff') + stop(0.5, '#3fa4ff') + stop(1, '#2a56e0'))
		+ lin('sc-ring', '0,0,1,0', stop(0, '#9c7a55') + stop(0.5, '#f1d9a8') + stop(1, '#8a6a47'))
		+ rad('sc-gas', '.35,.3,.95', stop(0, '#ffe2b0') + stop(0.5, '#d4813a') + stop(1, '#4a2112'))
		// Characters
		+ lin('sc-hood', '0,0,0,1', stop(0, '#3f8a54') + stop(0.5, '#245c38') + stop(1, '#0d2415'))
		+ rad('sc-suit', '.4,.3,.9', stop(0, '#ff5a52') + stop(0.55, '#d3141f') + stop(1, '#6e0610'))
		+ rad('sc-ink', '.4,.3,.9', stop(0, '#4a4f60') + stop(0.5, '#1b1e29') + stop(1, '#06070b'))
		+ lin('sc-web', '0,0,1,1', stop(0, '#ffffff') + stop(1, '#aebbd0'))
		+ '</defs></svg>';

	/**
	 * Opens a glyph.
	 * @param {'thor' | 'storm' | 'doom' | 'hero'} kind
	 * @param {string} cls
	 */
	const open = (kind, cls) => `<svg class="${kind}-glyph ${cls}" viewBox="0 0 64 64" width="${PX}" height="${PX}" aria-hidden="true">`;
	/** Mirrors drawing across the vertical centre line. @param {string} body */
	const mirror = body => `<g transform="translate(64 0) scale(-1 1)">${body}</g>`;
	const line = `stroke="${OUT}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"`;
	/** A thin dark engraving. @param {string} d @param {number} [o] */
	const cut = (d, o = 0.5) => `<path d="${d}" fill="none" stroke="${OUT}" stroke-opacity="${o}" stroke-width="1.2" stroke-linecap="round"/>`;
	/** A thin specular line. @param {string} d @param {number} [o] */
	const spec = (d, o = 0.8) => `<path d="${d}" fill="none" stroke="#fff" stroke-opacity="${o}" stroke-width="1.5" stroke-linecap="round"/>`;

	// ---- Asgard -------------------------------------------------------------------------------

	const hammer = open('thor', 'hammer')
		// Handle with leather wrap, gold collar and a strapped pommel
		+ `<rect x="28" y="32" width="8" height="24" rx="1.5" fill="url(#sc-wood-h)" ${line}/>`
		+ cut('M28 38l8-3M28 43l8-3M28 48l8-3M28 53l8-3', 0.55)
		+ spec('M30 36v18', 0.35)
		+ `<path d="M27 55h10l1.6 3.4a3.4 3.4 0 0 1-3.2 4.6h-7a3.4 3.4 0 0 1-3.2-4.6Z" fill="url(#sc-gold-h)" ${line}/>`
		+ `<path d="M37 57c6 0 7 4 3.5 6.5" fill="none" stroke="#5a3513" stroke-width="1.8" stroke-linecap="round"/>`
		+ `<rect x="25.5" y="31" width="13" height="5" rx="1.6" fill="url(#sc-gold-h)" ${line}/>`
		// Head: chamfered block, darker end caps, polished top, glowing rune between engraved bands
		+ `<path d="M4 13l6-7h44l6 7v14l-6 7H10l-6-7Z" fill="url(#sc-steel-v)" ${line}/>`
		+ `<path d="M4 13l6-7h7v28h-7l-6-7Z" fill="url(#sc-steel-h)" opacity=".85"/>`
		+ mirror('<path d="M4 13l6-7h7v28h-7l-6-7Z" fill="url(#sc-steel-h)" opacity=".85"/>')
		+ cut('M17 6v28M47 6v28', 0.6)
		+ cut('M21 12h22M21 28h22', 0.35)
		+ spec('M11 8.2h42', 0.9)
		+ spec('M6 14l4-4.4', 0.7)
		+ '<g class="rune"><path d="M35 10 24 22h6l-3 9 13-14h-7Z" fill="url(#sc-rune)" stroke="#0b3a8a" stroke-width=".8" stroke-linejoin="round"/></g>'
		+ '</svg>';

	const axe = open('thor', 'axe')
		// Shaft and grip
		+ `<rect x="29" y="4" width="6" height="56" rx="2" fill="url(#sc-wood-h)" ${line}/>`
		+ cut('M29 40l6-2.4M29 45l6-2.4M29 50l6-2.4M29 55l6-2.4', 0.55)
		+ `<path d="M32 0.5 36 6H28Z" fill="url(#sc-steel-v)" ${line}/>`
		+ `<rect x="28" y="57" width="8" height="5" rx="1.6" fill="url(#sc-gold-h)" ${line}/>`
		// Great bearded blade (left) with an engraved fuller and a charged edge
		+ `<path d="M29 9C20 3 9 5 3 14l5 8-5 9c6 8 18 10 26 5Z" fill="url(#sc-steel-v)" ${line}/>`
		+ cut('M26 14C20 10 13 11 9 16M26 31C20 33 13 32 9 28', 0.5)
		+ spec('M27 11C21 7 13 8 8 13', 0.9)
		+ '<g class="edge"><path d="M3.8 14.5 8.4 22 3.8 30.6" fill="none" stroke="#9be3ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M3.8 14.5 8.4 22 3.8 30.6" fill="none" stroke="#fff" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round"/></g>'
		// Back blade
		+ `<path d="M35.5 14 53 8.5 48.5 21 53 33.5 35.5 29Z" fill="url(#sc-steel-h)" ${line}/>`
		+ cut('M39 17l9-3M39 26l9 3', 0.45)
		+ spec('M37 15.2 50 11', 0.7)
		// Gold socket
		+ `<rect x="26.5" y="22" width="11" height="7" rx="2" fill="url(#sc-gold-h)" ${line}/>`
		+ '<path class="spark" d="M2 8l4 3-3 2 5 3" fill="none" stroke="#cfeeff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '</svg>';

	/** One half of the winged helm's wing: three overlapping feathers, nearest the head last. */
	const wing = ''
		+ `<path d="M18 36C9 37 3 32 1.5 23c6 2 11 5 15.5 9Z" fill="url(#sc-wing)" ${line}/>`
		+ `<path d="M18 31C8 30 2 24 1 14c6 2.4 11.5 6 16 12Z" fill="url(#sc-wing)" ${line}/>`
		+ `<path d="M18 26C10 23 5 16 4 5c6 2.6 11 7 14.5 14Z" fill="url(#sc-wing)" ${line}/>`
		+ cut('M16 24C12 17 9 12 6 8M15.5 29C11 23 7 19 3.5 16.5M15.5 34C11 31 7 28 4 26', 0.35);

	const helm = open('thor', 'helm')
		+ wing + mirror(wing)
		// Dome, shaded on its right, with a gold crest and brow band
		+ `<path d="M32 10C21 10 15 19 15 29v10h34V29C49 19 43 10 32 10Z" fill="url(#sc-steel-v)" ${line}/>`
		+ '<path d="M32 10C43 10 49 19 49 29v10H32Z" fill="#0f1626" opacity=".22"/>'
		+ `<path d="M29.5 10h5l1.5 30h-8Z" fill="url(#sc-gold-h)" ${line}/>`
		+ spec('M20 24C22 17 26 13.5 30 12.4', 0.85)
		+ `<path d="M13 37.5c6 2 32 2 38 0v6.5c-6 2-32 2-38 0Z" fill="url(#sc-gold-v)" ${line}/>`
		+ '<circle cx="32" cy="41" r="2.4" fill="url(#sc-rune)" stroke="#0b3a8a" stroke-width=".7"/>'
		+ '<circle cx="19.5" cy="41" r="1.1" fill="#7a4a0c"/><circle cx="44.5" cy="41" r="1.1" fill="#7a4a0c"/>'
		// Nose guard
		+ `<path d="M28.6 44.5h6.8V57c0 3.2-6.8 3.2-6.8 0Z" fill="url(#sc-steel-h)" ${line}/>`
		+ '</svg>';

	const goldbolt = open('thor', 'goldbolt')
		+ '<circle cx="32" cy="32" r="30" fill="url(#sc-glow)"/>'
		+ `<path d="M39 2 14 36h14l-6 26L52 24H36Z" fill="url(#sc-bolt)" stroke="#8a4a00" stroke-width="1.2" stroke-linejoin="round"/>`
		+ '<path d="M37 9 21 31h12l-4 17 17-21H33Z" fill="#fffbe6" opacity=".78"/>'
		+ '<path d="M12 18l6 3M50 40l-6-3M15 50l5-4" stroke="#ffe27a" stroke-width="1.6" stroke-linecap="round"/>'
		+ '</svg>';

	// ---- Storm --------------------------------------------------------------------------------

	const cloud = open('storm', 'cloud')
		+ `<path d="M15 44A11 11 0 0 1 16 22 15 15 0 0 1 45 18a12 12 0 0 1 3 26Z" fill="url(#sc-cloud)" ${line}/>`
		+ '<path d="M16 22A15 15 0 0 1 36 11" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.8" stroke-linecap="round"/>'
		+ '<path d="M15 44h33a12 12 0 0 0 3-6c-10 6-26 6-36 6Z" fill="#1c2640" opacity=".28"/>'
		+ '<g class="b"><path d="M35 38 25 52h8l-4 11 14-17h-8l4-8Z" fill="url(#sc-bolt)" stroke="#8a4a00" stroke-width="1" stroke-linejoin="round"/></g>'
		+ '<path d="M16 50l-2 6M44 52l-2 6" stroke="#8fc4ff" stroke-width="1.8" stroke-linecap="round"/>'
		+ '</svg>';

	const star = open('storm', 'star')
		+ '<circle cx="32" cy="32" r="24" fill="url(#sc-glow)"/>'
		+ '<g class="rays"><path d="M32 2 35.6 28.4 62 32 35.6 35.6 32 62 28.4 35.6 2 32 28.4 28.4Z" fill="url(#sc-star)" stroke="#b86d00" stroke-width="1" stroke-linejoin="round"/>'
		+ '<path d="M32 13 33.8 30.2 51 32 33.8 33.8 32 51 30.2 33.8 13 32 30.2 30.2Z" fill="#fff" opacity=".85" transform="rotate(45 32 32)"/></g>'
		+ '<circle cx="32" cy="32" r="5" fill="#fff"/>'
		+ '</svg>';

	const planet = open('storm', 'planet')
		+ '<g transform="rotate(-20 32 32)"><path d="M2 32A30 9 0 0 1 62 32" fill="none" stroke="#2a1a10" stroke-width="5.4" stroke-linecap="round"/>'
		+ '<path d="M2 32A30 9 0 0 1 62 32" fill="none" stroke="url(#sc-ring)" stroke-width="3.6" stroke-linecap="round"/></g>'
		+ `<circle cx="32" cy="32" r="16" fill="url(#sc-gas)" ${line}/>`
		+ '<path d="M17.2 26H46.8M16 33H48M17.6 39H46.4" stroke="#7a3a1a" stroke-opacity=".38" stroke-width="2.6"/>'
		+ '<path d="M32 16a16 16 0 0 1 0 32 12 16 0 0 0 0-32Z" fill="#120a08" opacity=".38"/>'
		+ '<g transform="rotate(-20 32 32)"><path d="M2 32A30 9 0 0 0 62 32" fill="none" stroke="#2a1a10" stroke-width="5.4" stroke-linecap="round"/>'
		+ '<path d="M2 32A30 9 0 0 0 62 32" fill="none" stroke="url(#sc-ring)" stroke-width="3.6" stroke-linecap="round"/></g>'
		+ '</svg>';

	/** One bracket as a lit glass tube: dark body, bright core, specular line. @param {string} d */
	const tube = d => `<path d="${d}" fill="none" stroke="#08203f" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`
		+ `<path d="${d}" fill="none" stroke="url(#sc-tube)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
		+ `<path d="${d}" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(-1 -1.4)"/>`;
	const brackets = open('storm', 'brackets')
		+ `<g class="l">${tube('M22 16 7 32l15 16')}</g>`
		+ `<g class="r">${tube('M42 16 57 32 42 48')}</g>`
		+ `<g class="s">${tube('M36 12 28 52')}</g>`
		+ '</svg>';

	const plasma = open('storm', 'plasma')
		+ '<circle cx="32" cy="32" r="30" fill="url(#sc-halo)"/>'
		+ '<g class="arc"><path d="M38 2 26 24l11 4-14 18 9 2-8 14" fill="none" stroke="#3a8cff" stroke-opacity=".4" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M38 2 26 24l11 4-14 18 9 2-8 14" fill="none" stroke="#8ccfff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M38 2 26 24l11 4-14 18 9 2-8 14" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M37 28l12 6-4 8M26 24 14 20l2-8" fill="none" stroke="#bfe6ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>'
		+ '</svg>';

	// ---- Doom ---------------------------------------------------------------------------------

	const skull = open('doom', 'skull')
		+ `<path d="M32 4C17 4 8 14 8 27c0 8 4 14 10 17v9c0 3 2 5 5 5h18c3 0 5-2 5-5v-9c6-3 10-9 10-17C56 14 47 4 32 4Z" fill="url(#sc-bone)" ${line}/>`
		+ '<path d="M32 4C47 4 56 14 56 27c0 8-4 14-10 17v9c0 3-2 5-5 5H32Z" fill="#2a2214" opacity=".2"/>'
		+ spec('M13 24C14 15 21 8 29 6.4', 0.9)
		// Brow crack and a hairline from it
		+ cut('M41 5l-4 9 5 5-4 8M20 9l4 6-3 5', 0.55)
		// Sockets with a smouldering ember in each
		+ '<path d="M13 28c-1-8 6-12 12-9 5 3 5 11 2 15-3 3-11 4-13-1-1-2-1-3-1-5Z" fill="#150c08" stroke="#150c08" stroke-width="1.4" stroke-linejoin="round"/>'
		+ '<path d="M51 28c1-8-6-12-12-9-5 3-5 11-2 15 3 3 11 4 13-1 1-2 1-3 1-5Z" fill="#150c08" stroke="#150c08" stroke-width="1.4" stroke-linejoin="round"/>'
		+ '<g class="eyes"><circle cx="23" cy="28" r="4.4" fill="url(#sc-ember)"/><circle cx="41" cy="28" r="4.4" fill="url(#sc-ember)"/></g>'
		// Nose and teeth
		+ '<path d="M32 36 27.4 45h9.2Z" fill="#150c08"/>'
		+ `<path d="M20 47h24v8c0 2-1.4 3.4-3.4 3.4H23.4C21.4 58.4 20 57 20 55Z" fill="url(#sc-bone)" ${line}/>`
		+ cut('M26 47v11M32 47v11.4M38 47v11', 0.65)
		+ '</svg>';

	const meteor = open('doom', 'meteor')
		+ '<g class="flame"><path d="M31 27C38 19 47 11 60 3c-5 9-5 15-10 21 6-2 10-4 13-8-1 12-11 21-26 27Z" fill="url(#sc-flame)"/>'
		+ '<path d="M33 31C40 25 47 20 54 17c-3 5-3 8-7 12Z" fill="#fff3b0" opacity=".7"/></g>'
		+ `<path d="M8 38l5-11 11-3 9 7 3 12-6 11-13 3-8-7Z" fill="url(#sc-rock)" ${line}/>`
		+ '<path d="M24 24l9 7 3 12" fill="none" stroke="#ffb347" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<g fill="#2a1a12" opacity=".6"><circle cx="17" cy="38" r="3.2"/><circle cx="26" cy="46" r="2.4"/><circle cx="21" cy="30" r="1.8"/></g>'
		+ '<g fill="#ffd36a" class="embers"><circle cx="44" cy="40" r="1.4"/><circle cx="50" cy="32" r="1.1"/><circle cx="38" cy="50" r="1.2"/></g>'
		+ '</svg>';

	const blackhole = open('doom', 'blackhole')
		+ '<g transform="rotate(-16 32 32)"><ellipse class="halo" cx="32" cy="32" rx="31" ry="11" fill="url(#sc-disk)"/></g>'
		+ '<circle cx="32" cy="32" r="11.5" fill="#000" stroke="#ffe9b0" stroke-width="1.2" stroke-opacity=".85"/>'
		+ '<path d="M21 28a12 12 0 0 1 22 0" fill="none" stroke="#ffb13b" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>'
		+ '<g transform="rotate(-16 32 32)"><path d="M3 32A29 9.5 0 0 0 61 32" fill="none" stroke="#ff9d1f" stroke-width="3.2" stroke-linecap="round"/>'
		+ '<path d="M6 33A26 8 0 0 0 58 33" fill="none" stroke="#fff2c4" stroke-width="1.2" stroke-linecap="round" opacity=".9"/></g>'
		+ '</svg>';

	const hourglass = open('doom', 'hourglass')
		+ `<path d="M17 8h30c0 14-10 20-14 24 4 4 14 10 14 24H17c0-14 10-20 14-24-4-4-14-10-14-24Z" fill="url(#sc-glass)" stroke="#e8f2fb" stroke-opacity=".7" stroke-width="1.4" stroke-linejoin="round"/>`
		+ '<path d="M21 11h22c-1 7-6 12-10 16v3h-2v-3c-4-4-9-9-10-16Z" fill="url(#sc-sand)" class="top"/>'
		+ '<path d="M18 55c1-6 8-10 14-14 6 4 13 8 14 14Z" fill="url(#sc-sand)"/>'
		+ '<path class="stream" d="M32 30v12" stroke="#ff7a45" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2 2"/>'
		+ `<rect x="10" y="3" width="44" height="6" rx="2.4" fill="url(#sc-gold-v)" ${line}/>`
		+ `<rect x="10" y="55" width="44" height="6" rx="2.4" fill="url(#sc-gold-v)" ${line}/>`
		+ `<path d="M13 9v46M51 9v46" stroke="url(#sc-gold-h)" stroke-width="2.4"/>`
		+ spec('M22 13c0 6 3 9 6 13', 0.7)
		+ '</svg>';

	const cracked = open('doom', 'cracked')
		+ `<circle cx="32" cy="32" r="22" fill="url(#sc-planet)" ${line}/>`
		+ '<path d="M32 10a22 22 0 0 1 0 44 16 22 0 0 0 0-44Z" fill="#000" opacity=".4"/>'
		+ '<g class="lava"><path d="M15 17 24 26 19 33 31 38 28 49 40 55" fill="none" stroke="#e03a0a" stroke-opacity=".5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M15 17 24 26 19 33 31 38 28 49 40 55M31 38l11-3 7-9" fill="none" stroke="url(#sc-lava)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g>'
		+ spec('M16 24C18 17 24 12 30 11', 0.6)
		+ `<path d="M50 6l7 3-2 7-7-2Z" fill="url(#sc-rock)" ${line}/>`
		+ `<path d="M5 48l6-3 4 5-5 6Z" fill="url(#sc-rock)" ${line}/>`
		+ `<path d="M55 49l5 2-1 5-5-1Z" fill="url(#sc-rock)" ${line}/>`
		+ '</svg>';

	// ---- Villains and heroes ------------------------------------------------------------------

	const doommask = open('doom', 'doommask')
		+ `<path d="M32 2C17 2 8 13 8 28l2 22 12 12h20l12-12 2-22C56 13 47 2 32 2Z" fill="url(#sc-hood)" ${line}/>`
		+ '<path d="M32 2C47 2 56 13 56 28l-2 22-12 12H32Z" fill="#000" opacity=".25"/>'
		+ spec('M14 20C16 12 22 7 29 5', 0.45)
		+ `<path d="M32 10C22 10 17 17 17 27v13c0 7 7 14 15 16 8-2 15-9 15-16V27c0-10-5-17-15-17Z" fill="url(#sc-steel-v)" ${line}/>`
		+ '<path d="M32 10c10 0 15 7 15 17v13c0 7-7 14-15 16Z" fill="#0f1626" opacity=".25"/>'
		+ '<path d="M17 24c10 4 20 4 30 0v-3c-10 4-20 4-30 0Z" fill="url(#sc-gold-h)" stroke="#141a29" stroke-width="1"/>'
		+ '<g class="eyes"><path d="M20.5 29h9l-1 4h-7Z" fill="#0a0e17"/><path d="M34.5 29h9l-1 4h-7Z" fill="#0a0e17"/>'
		+ '<path d="M22 30.4h6M36 30.4h6" stroke="#9dff6a" stroke-width="1.6" stroke-linecap="round"/></g>'
		+ '<path d="M32 33 29 45h6Z" fill="#0f1626" opacity=".4"/>'
		+ cut('M25 49h14', 0.7)
		+ '<circle cx="21" cy="39" r="1.1" fill="#fff" opacity=".7"/><circle cx="43" cy="39" r="1.1" fill="#fff" opacity=".7"/>'
		+ spec('M20 18C22 14 26 12 30 11.4', 0.8)
		+ '</svg>';

	const gauntlet = open('doom', 'gauntlet')
		// Cuff, then four fingers, palm and thumb in gold
		+ `<path d="M18 52h28l2 10H16Z" fill="url(#sc-steel-v)" ${line}/>`
		+ `<path d="M13 30l7-3v16l-5 3-7-9Z" fill="url(#sc-gold-h)" ${line}/>`
		+ `<rect x="17" y="8" width="7.5" height="22" rx="3.6" fill="url(#sc-gold-h)" ${line}/>`
		+ `<rect x="25" y="4" width="7.5" height="26" rx="3.6" fill="url(#sc-gold-h)" ${line}/>`
		+ `<rect x="33" y="6" width="7.5" height="24" rx="3.6" fill="url(#sc-gold-h)" ${line}/>`
		+ `<rect x="41" y="11" width="7" height="19" rx="3.4" fill="url(#sc-gold-h)" ${line}/>`
		+ `<path d="M17 28h31v18c0 5-4 8-9 8H26c-5 0-9-3-9-8Z" fill="url(#sc-gold-v)" ${line}/>`
		+ cut('M24.6 12v14M32.8 9v17M40.8 12v14', 0.5)
		+ '<g class="gems"><circle cx="24" cy="36" r="3" fill="#3b8bff"/><circle cx="32.5" cy="34.5" r="3" fill="#35d07f"/><circle cx="41" cy="36" r="3" fill="#a24bff"/>'
		+ '<circle cx="28" cy="45" r="3" fill="#ff8a1f"/><circle cx="37" cy="45" r="3" fill="#ff3b3b"/><circle cx="12" cy="36" r="2.6" fill="#ffe14a"/></g>'
		+ '<g fill="#fff" opacity=".7"><circle cx="23" cy="35" r=".9"/><circle cx="31.5" cy="33.5" r=".9"/><circle cx="40" cy="35" r=".9"/><circle cx="27" cy="44" r=".9"/><circle cx="36" cy="44" r=".9"/></g>'
		+ spec('M19 30c0-8 1-16 4-20', 0.6)
		+ '</svg>';

	const leg = ''
		+ `<path d="M27 22C19 12 11 9 5 14M26 26C16 22 8 24 3 33M26 31C16 33 9 40 7 51M27 35C21 44 17 52 16 60" fill="none" stroke="#8a93a8" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>`
		+ '<path d="M27 22C19 12 11 9 5 14M26 26C16 22 8 24 3 33M26 31C16 33 9 40 7 51M27 35C21 44 17 52 16 60" fill="none" stroke="url(#sc-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
	const spider = open('hero', 'spider')
		+ '<g class="legs">' + leg + mirror(leg) + '</g>'
		+ `<ellipse cx="32" cy="42" rx="10" ry="13" fill="url(#sc-ink)" stroke="#8a93a8" stroke-width="1.4"/>`
		+ `<ellipse cx="32" cy="22" rx="6.4" ry="6" fill="url(#sc-ink)" stroke="#8a93a8" stroke-width="1.4"/>`
		+ '<path class="mark" d="M32 36 27.4 42 32 48 36.6 42Z" fill="url(#sc-suit)"/>'
		+ '<g fill="#ff5a52"><circle cx="29.6" cy="20.4" r="1.3"/><circle cx="34.4" cy="20.4" r="1.3"/></g>'
		+ spec('M25 36C24 41 25 46 28 50', 0.45)
		+ '</svg>';

	const web = open('hero', 'web')
		+ '<g class="strands" fill="none" stroke="url(#sc-web)" stroke-linecap="round" stroke-linejoin="round">'
		+ '<path d="M32 3V61M3 32H61M11.5 11.5 52.5 52.5M52.5 11.5 11.5 52.5" stroke-width="1.5"/>'
		+ '<path d="M32 12 40.5 23.5 52 32 40.5 40.5 32 52 23.5 40.5 12 32 23.5 23.5Z" stroke-width="1.4"/>'
		+ '<path d="M32 21 36 28 43 32 36 36 32 43 28 36 21 32 28 28Z" stroke-width="1.4"/>'
		+ '<path d="M32 4 41 18 58 32 41 46 32 60 23 46 6 32 23 18Z" stroke-width="1.2" opacity=".75"/></g>'
		+ '<g fill="#fff"><circle cx="40.5" cy="23.5" r="1.7"/><circle cx="23.5" cy="40.5" r="1.7"/><circle cx="52" cy="32" r="1.4"/><circle cx="12" cy="32" r="1.4"/></g>'
		+ '</svg>';

	const mask = open('hero', 'mask')
		+ `<path d="M32 3C18 3 10 13 10 28c0 17 9 31 22 33 13-2 22-16 22-33C54 13 46 3 32 3Z" fill="url(#sc-suit)" ${line}/>`
		+ '<path d="M32 3C46 3 54 13 54 28c0 17-9 31-22 33Z" fill="#000" opacity=".18"/>'
		+ '<path d="M32 4V60M11.5 20Q32 27 52.5 20M10.5 33Q32 41 53.5 33M14 46Q32 53 50 46M20 9 25 56M44 9 39 56" fill="none" stroke="#2a0509" stroke-opacity=".7" stroke-width="1"/>'
		+ spec('M16 18C18 11 24 6.5 30 5.4', 0.55)
		+ '<g class="lens"><path d="M13.5 29Q22 20 30 33Q21 38 13.5 29Z" fill="#fff" stroke="#141018" stroke-width="2.2" stroke-linejoin="round"/>'
		+ '<path d="M50.5 29Q42 20 34 33Q43 38 50.5 29Z" fill="#fff" stroke="#141018" stroke-width="2.2" stroke-linejoin="round"/></g>'
		+ '</svg>';

	const villain = [doommask, gauntlet];
	const spiderman = [spider, web, mask];

	const asgard = [hammer, axe, helm, goldbolt];
	const storm = [cloud, star, planet, brackets, plasma];
	const doom = [skull, meteor, blackhole, hourglass, cracked];

	/** Adds the shared gradient definitions once. */
	function ensureDefs() {
		if (document.getElementById('sc-steel-v')) { return; }
		const host = document.createElement('div');
		host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
		host.innerHTML = DEFS;
		(document.body || document.documentElement).appendChild(host);
	}
	if (typeof document !== 'undefined') {
		if (document.body) { ensureDefs(); } else { document.addEventListener('DOMContentLoaded', ensureDefs); }
	}

	// @ts-ignore: shared global, like the other media modules
	globalThis.StormGlyphs = { asgard, storm, doom, villain, spiderman, all: [...asgard, ...storm, ...doom, ...villain, ...spiderman], ensureDefs };
}());
