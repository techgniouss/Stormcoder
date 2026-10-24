import { getUserName } from './user.js';

export function renderProfile(user) {
	return `profile: ${getUserName(user)}`;
}
