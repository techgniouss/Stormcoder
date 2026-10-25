import { makeKey } from './key.js';

export function cartKey(a) {
	const key = makeKey(a);
	return 'cart/' + key;
}
