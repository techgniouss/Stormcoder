// The thinking-line drawings and words (media/glyphs.js, media/main.js, media/main.css).
// Nothing else checks them: a typo in a gradient id, a glyph set of one (which would loop the
// picker), a class with no animation or a word in two lists all fail silently on screen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL(`../media/${f}`, import.meta.url), 'utf8');
const ctx = { globalThis: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('glyphs.js'), ctx);
const G = ctx.StormGlyphs;
const css = read('main.css');
const main = read('main.js');

const sets = { asgard: G.asgard, storm: G.storm, doom: G.doom, villain: G.villain, spiderman: G.spiderman };
const defsSource = read('glyphs.js');
const defined = new Set([...defsSource.matchAll(/(?:lin|rad)\('(sc-[a-z-]+)'/g)].map(m => m[1]));

// Every set has at least two drawings, or the "never the one on screen" picker could not terminate.
for (const [name, set] of Object.entries(sets)) {
	assert.ok(set.length >= 2, `${name}: needs at least two glyphs, has ${set.length}`);
}
assert.equal(G.all.length, Object.values(sets).reduce((n, s) => n + s.length, 0));

const seen = new Set();
for (const svg of G.all) {
	const cls = /class="(\w+)-glyph (\w+)"/.exec(svg);
	assert.ok(cls, `glyph without a class: ${svg.slice(0, 60)}`);
	const [, kind, name] = cls;
	assert.ok(['thor', 'storm', 'doom', 'hero'].includes(kind), `${name}: unknown kind ${kind}`);
	assert.ok(!seen.has(name), `${name}: duplicate glyph class`);
	seen.add(name);
	assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), `${name}: not a single svg`);
	assert.ok(/aria-hidden="true"/.test(svg), `${name}: decorative art must be aria-hidden`);
	assert.ok(!/<(script|image|foreignObject)\b|\bon\w+=|href=/i.test(svg), `${name}: no script, image or link in art`);
	assert.ok(!/clipPath|\bid="/.test(svg), `${name}: glyphs may not carry ids or clipPaths (they appear more than once on screen)`);
	for (const ref of svg.matchAll(/url\(#([\w-]+)\)/g)) {
		assert.ok(defined.has(ref[1]), `${name}: references undefined gradient ${ref[1]}`);
	}
	// Balanced tags, so one glyph can never swallow the rest of the status strip.
	const stack = [];
	for (const t of svg.matchAll(/<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g)) {
		if (t[3]) { continue; }
		if (t[1]) { assert.equal(stack.pop(), t[2], `${name}: mismatched </${t[2]}>`); } else { stack.push(t[2]); }
	}
	assert.deepEqual(stack, [], `${name}: unclosed tags`);
	// Each glyph animates in main.css (a drawing that never moves is a missing rule, not a choice).
	assert.ok(css.includes(`.${kind}-glyph.${name}`), `${name}: no .${kind}-glyph.${name} rule in main.css`);
}

// Every gradient that is defined is used, and ids are unique.
const usedAnywhere = new Set([...G.all.join('').matchAll(/url\(#([\w-]+)\)/g)].map(m => m[1]));
const ids = [...defsSource.matchAll(/(?:lin|rad)\('(sc-[a-z-]+)'/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate gradient ids');
for (const id of ids) {
	assert.ok(usedAnywhere.has(id) || new RegExp(`url\\(#${id}\\)`).test(defsSource), `gradient ${id} is defined but never used`);
}

// Words: the six lists in main.js are non-empty, free of duplicates and disjoint.
const lists = {};
for (const m of main.matchAll(/const (PLAIN|ASGARD|STORM|DOOM|VILLAIN|SPIDER)_WORDS = \[([\s\S]*?)\n\t\];/g)) {
	lists[m[1]] = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(w => w[1]);
}
assert.deepEqual(Object.keys(lists).sort(), ['ASGARD', 'DOOM', 'PLAIN', 'SPIDER', 'STORM', 'VILLAIN']);
const all = Object.values(lists).flat();
for (const [k, l] of Object.entries(lists)) { assert.ok(l.length >= 8, `${k}: too few words (${l.length})`); }
assert.equal(new Set(all).size, all.length, `a word is in two lists: ${all.filter((w, i) => all.indexOf(w) !== i)}`);
assert.ok(lists.VILLAIN.includes('Consulting Doctor Doom') && !lists.DOOM.includes('Consulting Doctor Doom'));
// Pick odds must cover 0..1 and every list must be reachable.
for (const kind of ['plain', 'asgard', 'storm', 'doom', 'villain', 'spider']) {
	assert.ok(main.includes(`'${kind}'`), `pick odds never choose ${kind}`);
}
// The picker must survive a missing glyphs.js and keep tool cards off the doom and character sets.
assert.ok(main.includes("typeof StormGlyphs === 'undefined'"), 'main.js must tolerate a missing glyphs.js');
assert.ok(/function pickToolGlyph/.test(main) && /mark\.innerHTML = pickToolGlyph\(\)/.test(main));
// Finished tool cards must not keep animating.
assert.ok(/\.tool:not\(\.running\) \.tool-glyph svg/.test(css));
// Reduced motion switches every glyph class off.
const reduced = css.split('prefers-reduced-motion').slice(1).join('\n');
for (const k of ['thor', 'storm', 'doom', 'hero']) { assert.ok(reduced.includes(`.${k}-glyph`), `${k} glyphs ignore reduced motion`); }

console.log(`ok: ${G.all.length} glyphs in ${Object.keys(sets).length} sets, ${all.length} words in 6 lists`);
