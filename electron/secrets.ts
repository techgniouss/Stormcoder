/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SafeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { HostEnvironment } from '../host/env';

/** Where the codec reports problems; the app writes them to its log file. */
type Log = (level: string, ...parts: unknown[]) => void;

/**
 * Whether `safeStorage` is backed by a real keychain. On Linux Electron reports encryption as
 * available even when it fell back to the `basic_text` backend, which uses a hard-coded
 * password and protects nothing; that case is treated as unavailable.
 */
export function keychainAvailable(safeStorage: SafeStorage): boolean {
	if (!safeStorage.isEncryptionAvailable()) {
		return false;
	}
	if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
		return safeStorage.getSelectedStorageBackend() !== 'basic_text';
	}
	return true;
}

/** Stored secret blobs start with this tag and a scheme letter, so a later change of backend is detected rather than misread. */
const BLOB_TAG = 'sc1:';

/** Loads the 32-byte AES key, creating it if missing. An invalid key file is kept aside, never silently overwritten. */
function loadSecretKey(userDataDir: string, log: Log): Buffer {
	const keyFile = path.join(userDataDir, 'secret.key');
	if (fs.existsSync(keyFile)) {
		const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
		if (key.length === 32) {
			return key;
		}
		const aside = `${keyFile}.invalid-${Date.now()}`;
		fs.renameSync(keyFile, aside);
		log('error', `secret.key was not a 32-byte key; moved to ${aside} and generated a new one. Secrets stored under the old key can no longer be read.`);
	}
	const key = crypto.randomBytes(32);
	fs.mkdirSync(userDataDir, { recursive: true });
	fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
	return key;
}

/**
 * Secrets use the OS keychain through `safeStorage`. Where none exists (a bare Linux
 * session), AES-256-GCM under a random key in a 0600 file — which protects the secrets file
 * on its own but not against another process running as the same user; the shell says so.
 * Blobs carry a scheme prefix; unprefixed blobs from earlier versions are still read.
 */
export function createSecretCodec({ userDataDir, safeStorage, log }: { userDataDir: string; safeStorage: SafeStorage; log: Log }): Pick<HostEnvironment, 'encrypt' | 'decrypt'> {
	const useKeychain = keychainAvailable(safeStorage);
	let key: Buffer | undefined;
	const aesKey = () => key ?? (key = loadSecretKey(userDataDir, log));
	const tag = Buffer.from(BLOB_TAG + (useKeychain ? 'k' : 'a'));
	const encryptRaw = (plain: string): Buffer => {
		if (useKeychain) {
			return safeStorage.encryptString(plain);
		}
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
		const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), body]);
	};
	const decryptRaw = (data: Buffer, keychain: boolean): string => {
		if (keychain) {
			return safeStorage.decryptString(data);
		}
		const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), data.subarray(0, 12));
		decipher.setAuthTag(data.subarray(12, 28));
		return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
	};
	return {
		encrypt: plain => Buffer.concat([tag, encryptRaw(plain)]),
		decrypt: data => {
			if (data.subarray(0, BLOB_TAG.length).toString() === BLOB_TAG) {
				const scheme = data.subarray(BLOB_TAG.length, BLOB_TAG.length + 1).toString();
				if ((scheme === 'k') !== useKeychain) {
					throw new Error(`This secret was stored with the ${scheme === 'k' ? 'OS keychain' : 'file key'}, which is not what is in use now.`);
				}
				return decryptRaw(data.subarray(BLOB_TAG.length + 1), useKeychain);
			}
			// Written before blobs were tagged: the scheme is whichever one is in use now.
			return decryptRaw(data, useKeychain);
		},
	};
}
