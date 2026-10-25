export function wishlistKey(a) {
	const key = (a.id + ':' + a.kind).toLowerCase();
	return 'wishlist/' + key;
}
