import { getDisplayName } from './user.js';

export function renderProfile(user) {
	return `profile: ${getDisplayName(user)}`;
}
