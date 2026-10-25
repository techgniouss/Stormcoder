import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('--json', () => assert.equal(execFileSync('node', ['cli.js', '--json', '2', '3'], { encoding: 'utf8' }).trim(), '{"sum":5}'));
