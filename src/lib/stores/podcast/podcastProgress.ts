import { refreshStoreAfterGoogleFetch } from '$lib/util/googleDriveHelpers';
import { throttleDebounce } from '$lib/util/throttleDebounce';
import { getUserData, setUserData } from '$lib/util/userData';
import { writable } from 'svelte/store';

interface EpisodeProgress {
	episodeId: string;
	timestamp: number;
	lastPlayed: number; // Unix timestamp
}

export interface PodcastProgress {
	[podcastId: string]: EpisodeProgress;
}

/** Max Continue Listening podcast entries kept in storage. */
export const MAX_PODCAST_PROGRESS_ENTRIES = 10;

function prunePodcastProgress(progress: PodcastProgress): PodcastProgress {
	const entries = Object.entries(progress);
	if (entries.length <= MAX_PODCAST_PROGRESS_ENTRIES) return progress;
	entries.sort((a, b) => b[1].lastPlayed - a[1].lastPlayed);
	return Object.fromEntries(entries.slice(0, MAX_PODCAST_PROGRESS_ENTRIES));
}

function createPodcastProgressStore() {
	const initialState: PodcastProgress = prunePodcastProgress(
		getUserData('podcast-progress')
	);

	const { subscribe, update } = writable<PodcastProgress>(initialState);

	subscribe((value) => {
		setUserData('podcast-progress', value);
	});

	refreshStoreAfterGoogleFetch('podcast-progress', (fn) => {
		update((current) => prunePodcastProgress(fn(current)));
	});

	const updatePodcastProgress = throttleDebounce(
		(podcastId: string, episodeId: string, timestamp: number) => {
			update((progress) =>
				prunePodcastProgress({
					...progress,
					[podcastId]: {
						episodeId,
						timestamp,
						lastPlayed: Date.now()
					}
				})
			);
		},
		1000,
		true,
		true
	);

	function removePodcastProgress(podcastId: string) {
		update((progress) => {
			const newProgress = { ...progress };
			delete newProgress[podcastId];
			return newProgress;
		});
	}

	return {
		subscribe,
		updatePodcastProgress,
		removePodcastProgress
	};
}

export const podcastProgress = createPodcastProgressStore();
