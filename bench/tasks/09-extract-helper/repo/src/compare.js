export function compareKey(a) {
	const key = (a.id + ':' + a.kind).toLowerCase();
	return 'compare/' + key;
}
