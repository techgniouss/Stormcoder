/**
 * Returns one page of `items`. Pages are 1-based.
 */
export function paginate(items, page, size) {
	if (page < 1) {
		throw new RangeError('page must be >= 1');
	}
	const start = (page - 1) * size;
	return items.slice(start, start + size);
}
