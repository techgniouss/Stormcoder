/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The phone app's own code (openvs-relay/pwa): it renders text a model wrote and answers
// prompts that gate commands, so what it must never do is checked against the real modules
// with a small DOM stand-in:
//   - a hostile reply cannot freeze the page (markdown scanning is bounded)
//   - links are limited to safe schemes, and nothing is ever parsed as HTML
//   - an approval too long to review is Deny-only, and every card is announced
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

class Node_ {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this._text = '';
		const classes = new Set();
		this.classList = {
			add: (...n) => n.forEach(x => classes.add(x)),
			remove: (...n) => n.forEach(x => classes.delete(x)),
			contains: n => classes.has(n),
			toggle: (n, f) => { const on = f === undefined ? !classes.has(n) : !!f; if (on) { classes.add(n); } else { classes.delete(n); } return on; },
			_all: classes,
		};
	}
	set className(v) { this.classList._all.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => this.classList._all.add(x)); }
	get className() { return [...this.classList._all].join(' '); }
	set textContent(v) { this.children = []; this._text = String(v); }
	get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
	appendChild(n) { this.children.push(n); return n; }
	append(...ns) { ns.forEach(n => this.children.push(typeof n === 'string' ? Object.assign(new Node_('#text'), { _text: n }) : n)); }
	replaceChildren() { this.children = []; this._text = ''; }
	setAttribute(k, v) { this.attributes[k] = String(v); }
	getAttribute(k) { return this.attributes[k] ?? null; }
	addEventListener(t, h) { (this.listeners[t] ||= []).push(h); }
	fire(t, e = {}) { (this.listeners[t] || []).forEach(h => h(e)); }
	findAll(pred, out = []) { if (pred(this)) { out.push(this); } this.children.forEach(c => c.findAll && c.findAll(pred, out)); return out; }
}
globalThis.document = {
	createElement: tag => new Node_(tag),
	createTextNode: text => Object.assign(new Node_('#text'), { _text: String(text) }),
};

const dir = path.resolve(import.meta.dirname, '../openvs-relay/pwa');
const transcript = await import(pathToFileURL(path.join(dir, 'transcript.js')).href);
const cards = await import(pathToFileURL(path.join(dir, 'cards.js')).href);

// 1. Hostile markdown is rendered quickly and as text. Before the bounds, 100k "[" took ~12 s and
//    30k "[a](" ~4 s on the audit machine, and the transcript re-renders on every reconnect.
{
	for (const hostile of ['['.repeat(100_000), '[a]('.repeat(30_000), '**a '.repeat(30_000), '`'.repeat(100_000), 'https://x.example/' + 'a'.repeat(100_000), '_x'.repeat(50_000)]) {
		const box = new Node_('div');
		const started = Date.now();
		transcript.renderBody(box, hostile);
		const took = Date.now() - started;
		assert.ok(took < 1500, `hostile input of ${hostile.length} chars took ${took}ms`);
	}
	// Ordinary markdown still works, including a link, bold text and code.
	const box = new Node_('div');
	transcript.renderBody(box, 'Use **bold**, `code` and [the docs](https://example.com/a).');
	const links = box.findAll(n => n.tagName === 'A');
	assert.equal(links.length, 1);
	assert.equal(links[0].href, 'https://example.com/a');
	assert.equal(links[0].rel, 'noopener noreferrer');
	assert.equal(box.findAll(n => n.tagName === 'STRONG').length, 1);
	assert.equal(box.findAll(n => n.tagName === 'CODE')[0].textContent, 'code');
}

// 2. Unsafe link targets render as text, never as an href.
{
	for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example/x', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)']) {
		const box = new Node_('div');
		transcript.renderBody(box, `[click](${href})`);
		assert.equal(box.findAll(n => n.tagName === 'A').length, 0, `${href} must not become a link`);
	}
	const box = new Node_('div');
	transcript.renderBody(box, '<img src=x onerror=alert(1)> and <script>alert(1)</script>');
	assert.equal(box.findAll(n => n.tagName === 'IMG' || n.tagName === 'SCRIPT').length, 0, 'markup in a reply is text, not elements');
	assert.match(box.textContent, /<script>alert\(1\)<\/script>/);
}

// 3. Approval cards: announced, and Deny-only when the host says part of it was too long to show.
{
	const posted = [];
	const container = new Node_('div');
	const controller = cards.create({ container, post: m => posted.push(m) });
	const normal = controller.render({ id: 'a1', type: 'approvalRequest', title: 'Run command?', preview: 'npm test' });
	assert.equal(normal.getAttribute('role'), 'alertdialog');
	assert.equal(normal.getAttribute('aria-label'), 'Run command?');
	const labels = c => c.findAll(n => n.tagName === 'BUTTON').map(b => b.textContent);
	assert.deepEqual(labels(normal), ['Allow', 'Allow for run', 'Deny']);

	const long = controller.render({ id: 'a2', type: 'approvalRequest', title: 'Run command?', preview: 'echo …', reviewOnDesktop: true, hiddenBytes: 12345 });
	assert.deepEqual(labels(long), ['Deny'], 'a card with hidden text can only be denied from the phone');
	assert.match(long.textContent, /12345 bytes/);
	assert.match(long.textContent, /Check it on the computer/);
	long.findAll(n => n.tagName === 'BUTTON')[0].fire('click');
	assert.deepEqual(posted.at(-1), { type: 'promptResponse', promptId: 'a2', response: { approved: false, always: false, feedback: '' } });

	const ask = controller.render({ id: 'q1', type: 'askRequest', question: 'Which database?', options: [{ label: 'sqlite' }] });
	assert.equal(ask.getAttribute('role'), 'alertdialog');
	assert.equal(ask.getAttribute('aria-label'), 'Which database?');
}

console.log('test-pwa-hardening: all assertions passed');
