// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small syntax highlighter for the code blocks models write. It scans the raw code once with a
 * per-language pattern list and escapes every piece itself, so the result is safe HTML and the
 * visible text is exactly the input (Copy reads `textContent`). Unknown languages come back
 * escaped and unstyled. It aims at "readable and pleasant", not at a full grammar: no nesting
 * and no language servers.
 */
(function () {
	'use strict';

	/** @param {string} s */
	function esc(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	const C_LIKE_KW = 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield';
	const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self';
	const GO_KW = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false';
	const RUST_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while';
	const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try void volatile while var record namespace using string bool object foreach in is as readonly override virtual get set';
	const C_KW = 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual new delete nullptr true false using bool';
	const SH_KW = 'if then else elif fi for while until do done case esac function in select time return exit export local readonly set unset echo cd source alias';
	const SQL_KW = 'select from where group by order having insert into values update set delete create table alter drop index join left right inner outer full on as and or not null is in like between limit offset union all distinct case when then else end primary key foreign references default unique count sum avg min max';
	const CSS_KW = 'important';

	/** @typedef {{ re: RegExp, cls: string }} Rule */

	/** @param {string} kw @param {boolean} [ci] */
	function words(kw, ci) {
		return new RegExp('\\b(?:' + kw.trim().split(/\s+/).join('|') + ')\\b', ci ? 'iy' : 'y');
	}

	const STR_DQ = { re: /"(?:\\[\s\S]|[^"\\\n])*"?/y, cls: 'string' };
	const STR_SQ = { re: /'(?:\\[\s\S]|[^'\\\n])*'?/y, cls: 'string' };
	const STR_BT = { re: /`(?:\\[\s\S]|[^`\\])*`?/y, cls: 'string' };
	const NUM = { re: /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y, cls: 'number' };
	const SLASH_COMMENT = { re: /\/\/[^\n]*/y, cls: 'comment' };
	const BLOCK_COMMENT = { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'comment' };
	const HASH_COMMENT = { re: /#[^\n]*/y, cls: 'comment' };
	const FN_CALL = { re: /[A-Za-z_$][\w$]*(?=\s*\()/y, cls: 'fn' };
	const TYPE_NAME = { re: /\b[A-Z][A-Za-z0-9_]*\b/y, cls: 'type' };

	/** @type {Record<string, Rule[]>} */
	const LANGS = {};
	/** @param {string[]} names @param {Rule[]} rules */
	function define(names, rules) { for (const n of names) { LANGS[n] = rules; } }

	const jsRules = [SLASH_COMMENT, BLOCK_COMMENT, STR_DQ, STR_SQ, STR_BT, NUM, { re: words(C_LIKE_KW), cls: 'keyword' }, FN_CALL, TYPE_NAME];
	define(['js', 'javascript', 'jsx', 'mjs', 'cjs', 'ts', 'typescript', 'tsx'], jsRules);
	define(['py', 'python'], [HASH_COMMENT, { re: /(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, cls: 'string' }, STR_DQ, STR_SQ, NUM, { re: words(PY_KW), cls: 'keyword' }, { re: /@[A-Za-z_][\w.]*/y, cls: 'fn' }, FN_CALL, TYPE_NAME]);
	define(['go', 'golang'], [SLASH_COMMENT, BLOCK_COMMENT, STR_DQ, STR_BT, STR_SQ, NUM, { re: words(GO_KW), cls: 'keyword' }, FN_CALL, TYPE_NAME]);
	define(['rs', 'rust'], [SLASH_COMMENT, BLOCK_COMMENT, STR_DQ, STR_SQ, NUM, { re: words(RUST_KW), cls: 'keyword' }, { re: /[A-Za-z_]\w*!/y, cls: 'fn' }, FN_CALL, TYPE_NAME]);
	define(['java', 'kt', 'kotlin', 'cs', 'csharp', 'swift', 'scala', 'dart'], [SLASH_COMMENT, BLOCK_COMMENT, STR_DQ, STR_SQ, NUM, { re: words(JAVA_KW), cls: 'keyword' }, { re: /@[A-Za-z_]\w*/y, cls: 'fn' }, FN_CALL, TYPE_NAME]);
	define(['c', 'h', 'cpp', 'c++', 'cc', 'hpp'], [SLASH_COMMENT, BLOCK_COMMENT, { re: /#\s*\w+[^\n]*/y, cls: 'keyword' }, STR_DQ, STR_SQ, NUM, { re: words(C_KW), cls: 'keyword' }, FN_CALL, TYPE_NAME]);
	define(['sh', 'bash', 'shell', 'zsh', 'console', 'shellscript'], [HASH_COMMENT, STR_DQ, STR_SQ, { re: /\$\{?[A-Za-z_]\w*\}?/y, cls: 'type' }, NUM, { re: words(SH_KW), cls: 'keyword' }, { re: /(?:^|(?<=\s))-{1,2}[A-Za-z][\w-]*/y, cls: 'prop' }]);
	define(['sql'], [{ re: /--[^\n]*/y, cls: 'comment' }, BLOCK_COMMENT, STR_SQ, STR_DQ, NUM, { re: words(SQL_KW, true), cls: 'keyword' }, FN_CALL]);
	define(['json', 'jsonc', 'json5'], [SLASH_COMMENT, BLOCK_COMMENT, { re: /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, cls: 'prop' }, STR_DQ, NUM, { re: /\b(?:true|false|null)\b/y, cls: 'keyword' }]);
	define(['yaml', 'yml', 'toml', 'ini'], [HASH_COMMENT, { re: /^[ \t-]*[\w.-]+(?=\s*[:=])/my, cls: 'prop' }, STR_DQ, STR_SQ, NUM, { re: /\b(?:true|false|null|yes|no)\b/y, cls: 'keyword' }]);
	define(['css', 'scss', 'less'], [BLOCK_COMMENT, SLASH_COMMENT, STR_DQ, STR_SQ, { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'number' }, { re: /-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/y, cls: 'number' }, { re: /--?[A-Za-z][\w-]*(?=\s*:)/y, cls: 'prop' }, { re: /@[\w-]+/y, cls: 'keyword' }, { re: words(CSS_KW), cls: 'keyword' }, { re: /[.#][A-Za-z_][\w-]*/y, cls: 'type' }]);
	define(['html', 'xml', 'svg', 'vue', 'htm'], [{ re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'comment' }, { re: /<\/?[A-Za-z][\w:-]*/y, cls: 'keyword' }, { re: /\/?>/y, cls: 'keyword' }, { re: /[A-Za-z_:@][\w:.-]*(?=\s*=)/y, cls: 'prop' }, STR_DQ, STR_SQ]);
	define(['diff', 'patch'], [{ re: /^\+[^\n]*/my, cls: 'string' }, { re: /^-[^\n]*/my, cls: 'number' }, { re: /^@@[^\n]*/my, cls: 'keyword' }]);

	/**
	 * @param {string} code
	 * @param {string} [language]
	 * @returns {string} HTML-safe markup whose text content equals `code`.
	 */
	function highlight(code, language) {
		const rules = LANGS[(language || '').toLowerCase()];
		// Past this size a block is more likely data than code, and the scan would only slow streaming.
		if (!rules || code.length > 60000) { return esc(code); }
		let out = '';
		let plain = '';
		let i = 0;
		const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
		scan: while (i < code.length) {
			for (const rule of rules) {
				rule.re.lastIndex = i;
				const m = rule.re.exec(code);
				if (m && m[0].length > 0) {
					flush();
					out += '<span class="tk-' + rule.cls + '">' + esc(m[0]) + '</span>';
					i += m[0].length;
					continue scan;
				}
			}
			// Nothing matched here. Advance over a whole identifier so a keyword inside a longer
			// word ("constant") is never cut out of it by the next position's match.
			const ident = /[A-Za-z0-9_$]+/y;
			ident.lastIndex = i;
			const w = ident.exec(code);
			const step = w ? w[0].length : 1;
			plain += code.slice(i, i + step);
			i += step;
		}
		flush();
		return out;
	}

	// @ts-ignore: attached to the global scope like the other media modules
	globalThis.StormHighlight = { highlight };
}());
