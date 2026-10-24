/**
 * Calls `fn` up to `attempts` times, waiting between tries.
 */
export async function retry(fn, attempts = 3, delayMs = 10) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn(i);
		} catch (err) {
			lastError = err;
			await new Promise(r => setTimeout(r, delayMs * (i + 1)));
		}
	}
	throw lastError;
}
