/**
 * Fetches `url` and parses the JSON body. `opts.fetch` replaces the global fetch (for tests).
 * A non-2xx answer throws an Error carrying `status`.
 */
export async function fetchJson(url, opts = {}) {
	const doFetch = opts.fetch ?? globalThis.fetch;
	const retries = opts.retries ?? 0;
	// TODO: retry on 5xx and network errors up to `retries` more times, never on 4xx.
	const res = await doFetch(url);
	if (!res.ok) {
		const err = new Error(`HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}
	void retries;
	return res.json();
}
