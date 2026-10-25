export function makeKey(a) {
	return (a.id + ':' + a.kind).toLowerCase();
}
