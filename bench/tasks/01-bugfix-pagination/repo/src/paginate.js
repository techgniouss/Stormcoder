/**
 * Returns one page of `items`. Pages are 1-based.
 */
export function paginate(items, page, size) {
	const start = page * size;
	return items.slice(start, start + size);
}
