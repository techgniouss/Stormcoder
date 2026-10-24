export function cartKey(a) {
	const key = (a.id + ':' + a.kind).toLowerCase();
	return 'cart/' + key;
}
