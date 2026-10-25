// Adds the dependency-sized folder the task is about: ignored by .gitignore, thousands of files.
import fs from 'node:fs';
import path from 'node:path';
export default function setup(dir) {
	const lib = path.join(dir, 'venv/lib/python3.11/site-packages');
	fs.mkdirSync(lib, { recursive: true });
	for (let i = 0; i < 2600; i++) { fs.writeFileSync(path.join(lib, `pkg${i}.py`), `DEFAULT_REQUEST_TIMEOUT_MS = 30000  # vendored ${i}\n`); }
}
