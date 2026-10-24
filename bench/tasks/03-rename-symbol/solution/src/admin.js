import { getDisplayName } from './user.js';

export function renderAdmin(user) {
	return `admin: ${getDisplayName(user)}`;
}
