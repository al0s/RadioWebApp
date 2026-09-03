import { refreshStoreAfterGoogleFetch } from '$lib/util/googleDriveHelpers';
import { getUserData, setUserData } from '$lib/util/userData';
import { writable } from 'svelte/store';

export interface RadioProgress {
	[radioId: string]: {
		lastPlayed: number; // Unix timestamp
	};
}

/** Keep Continue Listening strip bounded (same cap as podcasts). */
export const MAX_RADIO_PROGRESS_ENTRIES = 10;

function pruneRadioProgress(progress: RadioProgress): RadioProgress {
	const entries = Object.entries(progress);
	if (entries.length <= MAX_RADIO_PROGRESS_ENTRIES) return progress;
	entries.sort((a, b) => b[1].lastPlayed - a[1].lastPlayed);
	return Object.fromEntries(entries.slice(0, MAX_RADIO_PROGRESS_ENTRIES));
}

function createRadioProgressStore() {
	const initialState: RadioProgress = pruneRadioProgress(getUserData('radio-progress'));

	const { subscribe, update } = writable<RadioProgress>(initialState);

	subscribe((value) => {
		setUserData('radio-progress', value);
	});

	refreshStoreAfterGoogleFetch('radio-progress', (fn) => {
		update((current) => pruneRadioProgress(fn(current)));
	});

	const updateRadioProgress = (radioId: string) => {
		update((progress) =>
			pruneRadioProgress({
				...progress,
				[radioId]: {
					lastPlayed: Date.now()
				}
			})
		);
	};

	function removeRadioProgress(radioId: string) {
		update((progress) => {
			const newProgress = { ...progress };
			delete newProgress[radioId];
			return newProgress;
		});
	}

	return {
		subscribe,
		updateRadioProgress,
		removeRadioProgress
	};
}

export const radioProgress = createRadioProgressStore();
