import { getUserName } from './user.js';

export function renderHeader(user) {
	return `header: ${getUserName(user)}`;
}
