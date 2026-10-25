import { getUserName } from './user.js';

export function renderComment(user) {
	return `comment: ${getUserName(user)}`;
}
