import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
test('first page', () => assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]));
test('last partial page', () => assert.deepEqual(paginate(items, 4, 3), [10]));
test('beyond the end is empty', () => assert.deepEqual(paginate(items, 5, 3), []));
test('page below 1 is rejected', () => assert.throws(() => paginate(items, 0, 3), RangeError));
