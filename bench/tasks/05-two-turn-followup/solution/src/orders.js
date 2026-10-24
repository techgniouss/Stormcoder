/**
 * Total for an order: sum of lines, minus the discount percentage.
 */
export function calculateTotal(lines, discountPct = 0) {
	const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
	return Math.round(subtotal * (1 - discountPct / 100) * 100) / 100;
}
