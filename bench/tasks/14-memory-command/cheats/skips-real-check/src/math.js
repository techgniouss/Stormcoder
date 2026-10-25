function add(a, b) {
	return a + b;
}

function sub(a, b) {
	return a - b;
}

function clamp(n, lo, hi) {
	return Math.min(Math.max(n, lo), hi);
}

module.exports = { add, sub, clamp };
