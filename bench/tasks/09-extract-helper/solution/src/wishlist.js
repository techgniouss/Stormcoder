import { makeKey } from './key.js';

export function wishlistKey(a) {
	const key = makeKey(a);
	return 'wishlist/' + key;
}
