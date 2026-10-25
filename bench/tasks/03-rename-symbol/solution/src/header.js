import { getDisplayName } from './user.js';

export function renderHeader(user) {
	return `header: ${getDisplayName(user)}`;
}
