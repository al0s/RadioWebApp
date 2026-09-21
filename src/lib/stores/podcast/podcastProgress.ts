import { refreshStoreAfterGoogleFetch } from '$lib/util/googleDriveHelpers';
import { throttleDebounce } from '$lib/util/throttleDebounce';
import { getUserData, setUserData } from '$lib/util/userData';
import { writable } from 'svelte/store';

export interface EpisodeProgressEntry {
	timestamp: number;
	lastPlayed: number; // Unix timestamp
}

/** Per-podcast map of episodeId → progress. */
export interface PodcastEpisodeProgress {
	[episodeId: string]: EpisodeProgressEntry;
}

export interface PodcastProgress {
	[podcastId: string]: PodcastEpisodeProgress;
}

/** Max episode progress entries kept per podcast. */
export const MAX_EPISODES_PER_PODCAST = 3;

/** Max podcasts kept in Continue Listening / storage. */
export const MAX_PODCAST_PROGRESS_ENTRIES = 10;

type LegacyEpisodeProgress = {
	episodeId: string;
	timestamp: number;
	lastPlayed: number;
};

function isLegacyEpisodeProgress(value: unknown): value is LegacyEpisodeProgress {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.episodeId === 'string' && typeof record.timestamp === 'number';
}

function isEpisodeProgressEntry(value: unknown): value is EpisodeProgressEntry {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.timestamp === 'number' && typeof record.lastPlayed === 'number';
}

/** Accepts legacy single-episode or multi-episode shapes. */
export function normalizePodcastProgress(raw: unknown): PodcastProgress {
	if (!raw || typeof raw !== 'object') return {};

	const result: PodcastProgress = {};

	for (const [podcastId, value] of Object.entries(raw as Record<string, unknown>)) {
		if (isLegacyEpisodeProgress(value)) {
			result[podcastId] = {
				[value.episodeId]: {
					timestamp: value.timestamp,
					lastPlayed: value.lastPlayed ?? 0
				}
			};
			continue;
		}

		if (!value || typeof value !== 'object') continue;

		const episodes: PodcastEpisodeProgress = {};
		for (const [episodeId, entry] of Object.entries(value as Record<string, unknown>)) {
			if (isEpisodeProgressEntry(entry)) {
				episodes[episodeId] = {
					timestamp: entry.timestamp,
					lastPlayed: entry.lastPlayed
				};
			}
		}
		if (Object.keys(episodes).length > 0) {
			result[podcastId] = episodes;
		}
	}

	return result;
}

export function getLatestEpisodeProgress(
	episodes: PodcastEpisodeProgress | undefined
): { episodeId: string; timestamp: number; lastPlayed: number } | null {
	if (!episodes) return null;

	let latest: { episodeId: string; timestamp: number; lastPlayed: number } | null = null;
	for (const [episodeId, entry] of Object.entries(episodes)) {
		if (!latest || entry.lastPlayed > latest.lastPlayed) {
			latest = {
				episodeId,
				timestamp: entry.timestamp,
				lastPlayed: entry.lastPlayed
			};
		}
	}
	return latest;
}

export function getEpisodeProgressTimestamp(
	progress: PodcastProgress,
	podcastId: string,
	episodeId: string
): number {
	return progress[podcastId]?.[episodeId]?.timestamp ?? 0;
}

/** If progress is at/near the end, treat as finished and restart from 0. */
export function resolveResumeTimestamp(
	timestamp: number,
	durationSeconds?: number | string
): number {
	if (!timestamp || timestamp <= 0) return 0;
	const duration = parseDurationSeconds(durationSeconds);
	if (duration > 0 && timestamp >= Math.max(0, duration - 3)) {
		return 0;
	}
	return timestamp;
}

function parseDurationSeconds(value?: number | string): number {
	if (value === undefined || value === null || value === '') return 0;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const raw = String(value).trim();
	const asNumber = Number(raw);
	if (Number.isFinite(asNumber)) return asNumber;
	const parts = raw.split(':').map((part) => Number(part));
	if (parts.length >= 2 && parts.every((part) => Number.isFinite(part))) {
		return parts.reduce((total, part) => total * 60 + part, 0);
	}
	return 0;
}

function pruneEpisodesForPodcast(episodes: PodcastEpisodeProgress): PodcastEpisodeProgress {
	const entries = Object.entries(episodes);
	if (entries.length <= MAX_EPISODES_PER_PODCAST) return episodes;
	entries.sort((a, b) => b[1].lastPlayed - a[1].lastPlayed);
	return Object.fromEntries(entries.slice(0, MAX_EPISODES_PER_PODCAST));
}

export function prunePodcastProgress(progress: PodcastProgress): PodcastProgress {
	const prunedPerPodcast: PodcastProgress = {};
	for (const [podcastId, episodes] of Object.entries(progress)) {
		prunedPerPodcast[podcastId] = pruneEpisodesForPodcast(episodes);
	}

	const podcastEntries = Object.entries(prunedPerPodcast);
	if (podcastEntries.length <= MAX_PODCAST_PROGRESS_ENTRIES) return prunedPerPodcast;

	podcastEntries.sort((a, b) => {
		const aLatest = getLatestEpisodeProgress(a[1])?.lastPlayed ?? 0;
		const bLatest = getLatestEpisodeProgress(b[1])?.lastPlayed ?? 0;
		return bLatest - aLatest;
	});

	return Object.fromEntries(podcastEntries.slice(0, MAX_PODCAST_PROGRESS_ENTRIES));
}

function createPodcastProgressStore() {
	const initialState = prunePodcastProgress(
		normalizePodcastProgress(getUserData('podcast-progress'))
	);

	const { subscribe, update } = writable<PodcastProgress>(initialState);

	subscribe((value) => {
		setUserData('podcast-progress', value);
	});

	refreshStoreAfterGoogleFetch('podcast-progress', (fn) => {
		update((current) =>
			prunePodcastProgress(normalizePodcastProgress(fn(current)))
		);
	});

	const updatePodcastProgress = throttleDebounce(
		(podcastId: string, episodeId: string, timestamp: number) => {
			update((progress) => {
				const existing = progress[podcastId] ?? {};
				return prunePodcastProgress({
					...progress,
					[podcastId]: {
						...existing,
						[episodeId]: {
							timestamp,
							lastPlayed: Date.now()
						}
					}
				});
			});
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
