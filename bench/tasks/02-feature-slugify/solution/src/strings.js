/**
 * Upper-cases the first character.
 */
export function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Cuts `text` to `max` characters, adding an ellipsis when it was cut.
 */
export function truncate(text, max) {
	return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Turns `text` into a lowercase, dash-separated URL slug.
 */
export function slugify(text) {
	return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
