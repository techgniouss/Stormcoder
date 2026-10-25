import { makeKey } from './key.js';

export function compareKey(a) {
	const key = makeKey(a);
	return 'compare/' + key;
}
