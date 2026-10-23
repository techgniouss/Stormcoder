// The syntax highlighter: output is safe HTML whose text equals the input, tokens get the
// expected classes, and unknown languages are only escaped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { globalThis: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../media/highlight.js', import.meta.url), 'utf8'), ctx);
const { highlight } = ctx.StormHighlight;

/** The visible text of highlighted markup. */
const text = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const samples = {
	ts: 'export async function f<T>(x: Map<string, T>): Promise<T> {\n\t// note <b>\n\treturn await run("a<b", 0x1F, `t${x}`);\n}\n',
	py: 'def f(a):\n    """doc <x>"""\n    return {"k": a} # c\n',
	sh: 'if [ -n "$HOME" ]; then echo --flag; fi\n',
	json: '{"a": [1, 2.5e3, true, null], "b": "<script>"}',
	css: '.a > b { color: #fff; margin: -1px 2em; }',
	html: '<div class="a" id=\'b\'>x &amp; y</div><!-- c -->',
	sql: "SELECT count(*) FROM t WHERE a = 'x' -- c",
	diff: '@@ -1 +1 @@\n-old\n+new\n',
	rs: 'fn main() { println!("{}", 1); }',
};
for (const [lang, code] of Object.entries(samples)) {
	const html = highlight(code, lang);
	assert.equal(text(html), code, `${lang}: the text must survive unchanged`);
	assert.ok(!/<(?!\/?span\b)[a-z]/i.test(html), `${lang}: no markup other than our spans`);
}

// Classes.
assert.match(highlight('const x = 1;', 'ts'), /<span class="tk-keyword">const<\/span>/);
assert.match(highlight('const x = 1;', 'ts'), /<span class="tk-number">1<\/span>/);
assert.match(highlight('foo("a")', 'js'), /<span class="tk-fn">foo<\/span>/);
assert.match(highlight('// hi', 'js'), /<span class="tk-comment">\/\/ hi<\/span>/);
assert.match(highlight('{"a": 1}', 'json'), /<span class="tk-prop">&quot;a&quot;<\/span>/);
// A keyword inside a longer word is left alone.
assert.ok(!/tk-keyword/.test(highlight('constant = 1', 'js')));
// Hostile input stays inert; unknown languages are only escaped.
assert.equal(highlight('<img src=x onerror=alert(1)>', 'nope'), '&lt;img src=x onerror=alert(1)&gt;');
assert.ok(!highlight('"<img onerror=x>"', 'js').includes('<img'));
// Unterminated strings and comments do not hang or lose text.
for (const code of ['"abc', '/* never closed', "'x", '`t${']) { assert.equal(text(highlight(code, 'ts')), code); }
// Large blocks are not scanned.
const big = 'a'.repeat(70000);
assert.equal(highlight(big, 'js'), big);
console.log('test-highlight: all assertions passed');
