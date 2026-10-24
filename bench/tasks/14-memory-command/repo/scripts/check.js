// The project's real checks. Records the hash of src/math.js it ran against, so a stale run is detectable.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'math.js');
const math = require(file);
assert.equal(math.add(1, 2), 3);
assert.equal(math.sub(5, 2), 3);
assert.equal(typeof math.clamp, 'function', 'clamp is not exported from src/math.js');
assert.equal(math.clamp(5, 0, 3), 3);
assert.equal(math.clamp(-1, 0, 3), 0);
assert.equal(math.clamp(2, 0, 3), 2);
fs.writeFileSync(path.join(__dirname, '..', '.check-ran'), crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'));
console.log('all checks passed');
