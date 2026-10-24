/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The only Android-specific code the phone app sees. It runs before app.js and, inside the
// Capacitor shell, defines `globalThis.StormcoderNative` (the contract app.js reads):
//   { platform: 'android', scanQr(): Promise<string | null> }
// Outside the shell (a plain browser, or the tests) it does nothing, so the app behaves as the PWA.
(function () {
	'use strict';
	const cap = globalThis.Capacitor;
	if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
		return;
	}
	const scanner = cap.registerPlugin('BarcodeScanner');
	globalThis.StormcoderNative = Object.freeze({
		platform: 'android',
		/**
		 * Opens the camera and resolves with the text of the first QR code read, or null if the
		 * person cancelled. Permission is asked for by the scanner plugin.
		 * @returns {Promise<string | null>}
		 */
		async scanQr() {
			try {
				const { barcodes } = await scanner.scan({ formats: ['QR_CODE'] });
				return barcodes && barcodes[0] && typeof barcodes[0].rawValue === 'string' ? barcodes[0].rawValue : null;
			} catch (err) {
				const message = err && err.message ? String(err.message) : '';
				if (/cancel/i.test(message)) {
					return null;
				}
				throw new Error('Could not scan. Allow camera access, or paste the pairing link instead.');
			}
		},
	});
}());
