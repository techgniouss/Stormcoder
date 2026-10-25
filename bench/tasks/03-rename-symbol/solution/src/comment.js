import { getDisplayName } from './user.js';

export function renderComment(user) {
	return `comment: ${getDisplayName(user)}`;
}
