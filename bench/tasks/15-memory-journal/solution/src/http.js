/**
 * Fetches `url` and parses the JSON body. `opts.fetch` replaces the global fetch (for tests).
 * A non-2xx answer throws an Error carrying `status`. `opts.retries` extra attempts are made
 * after a 5xx answer or a network error, never after a 4xx.
 */
export async function fetchJson(url, opts = {}) {
	const doFetch = opts.fetch ?? globalThis.fetch;
	const retries = opts.retries ?? 0;
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		let res;
		try {
			res = await doFetch(url);
		} catch (err) {
			lastError = err;
			continue;
		}
		if (res.ok) {
			return res.json();
		}
		const err = new Error(`HTTP ${res.status}`);
		err.status = res.status;
		if (res.status < 500) {
			throw err;
		}
		lastError = err;
	}
	throw lastError;
}
