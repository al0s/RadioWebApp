import { get, writable } from 'svelte/store';

export const homeSearchQuery = writable('');

export function clearHomeSearch(): boolean {
	if (!get(homeSearchQuery).trim()) return false;
	homeSearchQuery.set('');
	return true;
}
