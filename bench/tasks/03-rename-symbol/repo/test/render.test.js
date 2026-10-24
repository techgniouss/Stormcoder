import test from 'node:test';
import assert from 'node:assert/strict';
import { getUserName } from '../src/user.js';
import { renderProfile } from '../src/profile.js';
test('name', () => assert.equal(getUserName({ email: 'a@b.c' }), 'a@b.c'));
test('profile', () => assert.equal(renderProfile({ displayName: 'Ann' }), 'profile: Ann'));
