// Stormcoder Relay: Cloudflare Worker + Durable Object + PWA
//
// Regenerates the PWA's icon set from the desktop app's vector icon (build/icon.svg: the
// Stormcoder bolt between code brackets on a dark tile). Run from anywhere with
//   node openvs-relay/scripts/gen-pwa-icons.js
// It renders with the repo's own Chromium helper (test/browser.mjs, playwright-core), so it needs
// no image library. Outputs, all in openvs-relay/pwa/:
//   icon.svg                  the tile as-is (manifest "any" vector icon, favicon)
//   icon-192.png, icon-512.png  the tile on a transparent canvas ("any")
//   icon-512-maskable.png     the artwork on a full-bleed square, so an OS mask (circle,
//                             squircle) never reveals a corner. The brackets and bolt sit inside
//                             the central 80% "safe zone" in the source, so no scaling is needed.
//   apple-touch-icon.png      the same full-bleed square at 180px (iOS applies its own rounding).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'build', 'icon.svg');
const OUT = path.join(__dirname, '..', 'pwa');

/** The source with its rounded, shadowed tile swapped for a full-bleed square of the same gradient and halo. */
function maskableSvg(source) {
	return source
		.replace(/<rect x="100" y="100" width="824" height="824" rx="190" fill="url\(#bg\)" filter="url\(#drop\)"\/>/, '<rect width="1024" height="1024" fill="url(#bg)"/>')
		.replace(/<rect x="100" y="100" width="824" height="824" rx="190" fill="url\(#halo\)"\/>/, '<rect width="1024" height="1024" fill="url(#halo)"/>')
		.replace(/<rect x="103"[^>]*\/>/, '');
}

async function main() {
	const { launchChromium } = await import(pathToFileURL(path.join(REPO_ROOT, 'test', 'browser.mjs')).href);
	const source = fs.readFileSync(SRC, 'utf8');
	const maskable = maskableSvg(source);
	if (maskable === source || /rx="190"/.test(maskable)) { throw new Error('build/icon.svg changed shape: update maskableSvg()'); }
	fs.writeFileSync(path.join(OUT, 'icon.svg'), source);

	const browser = await launchChromium();
	try {
		const render = async (svg, size, file, opaque) => {
			const page = await browser.newPage({ viewport: { width: size, height: size } });
			const markup = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
			await page.setContent(`<body style="margin:0;background:transparent">${markup}</body>`);
			await page.screenshot({ path: path.join(OUT, file), omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
			await page.close();
		};
		await render(source, 192, 'icon-192.png', false);
		await render(source, 512, 'icon-512.png', false);
		await render(maskable, 512, 'icon-512-maskable.png', true);
		await render(maskable, 180, 'apple-touch-icon.png', true);
	} finally {
		await browser.close();
	}
	console.log('Wrote icon.svg, icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon.png to', OUT);
}

main().catch(err => { console.error(err); process.exit(1); });
