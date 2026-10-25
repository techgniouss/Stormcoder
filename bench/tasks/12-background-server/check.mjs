import net from 'node:net';
import { read } from '../../lib/check-lib.mjs';
export default async function check(dir, ctx) {
	const notes = [];
	const said = /pong-4791/.test(ctx.answer ?? '');
	if (!said) { notes.push('final answer does not report the reply "pong-4791"'); }
	if (!/ping/.test(read(dir, '.hits'))) { notes.push('the server never received a /ping request'); }
	const open = await new Promise(res => { const s = net.connect(4791, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
	if (open) { notes.push('server still listening on 4791'); }
	return { pass: !notes.length, notes };
}
