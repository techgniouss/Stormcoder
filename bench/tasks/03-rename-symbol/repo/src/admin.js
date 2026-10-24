import { getUserName } from './user.js';

export function renderAdmin(user) {
	return `admin: ${getUserName(user)}`;
}
