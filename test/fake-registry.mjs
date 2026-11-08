// A stand-in npm registry that serves a tiny, valid "Claude Agent SDK" (and the platform build it
// would need) as real gzip'd tarballs, for tests of the in-app installer. Loopback only.
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

const SDK = '@anthropic-ai/claude-agent-sdk';

const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';

function entry(name, content = Buffer.alloc(0), { mode = 0o644, type = '0' } = {}) {
	const data = Buffer.from(content);
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, 'utf8');
	block.write(octal(mode, 8), 100, 'latin1');
	block.write(octal(0, 8), 108, 'latin1');
	block.write(octal(0, 8), 116, 'latin1');
	block.write(octal(data.length, 12), 124, 'latin1');
	block.write(octal(0, 12), 136, 'latin1');
	block.write('        ', 148, 'latin1');
	block.write(type, 156, 'latin1');
	block.write('ustar\0', 257, 'latin1');
	block.write('00', 263, 'latin1');
	let sum = 0;
	for (const byte of block) { sum += byte; }
	block.write(octal(sum, 7) + ' ', 148, 'latin1');
	return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tarball(files) {
	const entries = [entry('package/', '', { mode: 0o755, type: '5' })];
	for (const [name, { content, mode }] of Object.entries(files)) { entries.push(entry(`package/${name}`, content, { mode })); }
	return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** Starts the registry. `version` is the only release it publishes. */
export async function startFakeRegistry({ version = '0.3.17' } = {}) {
	const platform = `${SDK}-${process.platform}-${process.arch}`;
	const sdk = tarball({
		'package.json': { content: JSON.stringify({ name: SDK, version, type: 'module', exports: { '.': { default: './sdk.mjs' } } }) },
		'sdk.mjs': { content: 'export function query() { throw new Error("fake sdk"); }\n' },
	});
	const bin = tarball({ 'package.json': { content: JSON.stringify({ name: platform, version }) }, claude: { content: Buffer.alloc(2048, 5), mode: 0o755 } });
	const sri = buf => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url);
		const base = `http://127.0.0.1:${server.address().port}`;
		const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
		if (req.url === `/${SDK.replace('/', '%2F')}`) {
			return json({ versions: { [version]: { dist: { tarball: `${base}/sdk.tgz`, integrity: sri(sdk) }, optionalDependencies: { [platform]: version } } } });
		}
		if (req.url === `/${platform.replace('/', '%2F')}/${version}`) { return json({ dist: { tarball: `${base}/bin.tgz`, integrity: sri(bin) } }); }
		if (req.url === '/sdk.tgz' || req.url === '/bin.tgz') {
			const body = req.url === '/sdk.tgz' ? sdk : bin;
			res.writeHead(200, { 'content-length': body.length });
			return res.end(body);
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
