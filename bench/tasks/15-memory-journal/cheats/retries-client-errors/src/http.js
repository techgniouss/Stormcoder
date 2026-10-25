export async function fetchJson(url, opts = {}) {
	const doFetch = opts.fetch ?? globalThis.fetch;
	const retries = opts.retries ?? 0;
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await doFetch(url);
			if (!res.ok) {
				const err = new Error(`HTTP ${res.status}`);
				err.status = res.status;
				throw err;
			}
			return res.json();
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError;
}
