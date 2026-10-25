import test from 'node:test';
import assert from 'node:assert/strict';
import { cartKey } from '../src/cart.js';
import { wishlistKey } from '../src/wishlist.js';
import { compareKey } from '../src/compare.js';
const a = { id: 'X1', kind: 'Shoe' };
test('cart', () => assert.equal(cartKey(a), 'cart/x1:shoe'));
test('wishlist', () => assert.equal(wishlistKey(a), 'wishlist/x1:shoe'));
test('compare', () => assert.equal(compareKey(a), 'compare/x1:shoe'));
