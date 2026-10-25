import test from 'node:test';
import assert from 'node:assert/strict';
import { getDisplayName } from '../src/user.js';
import { renderProfile } from '../src/profile.js';
test('name', () => assert.equal(getDisplayName({ email: 'a@b.c' }), 'a@b.c'));
test('profile', () => assert.equal(renderProfile({ displayName: 'Ann' }), 'profile: Ann'));
