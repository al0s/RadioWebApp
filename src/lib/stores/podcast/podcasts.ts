import { writable } from 'svelte/store';
import { XMLParser } from 'fast-xml-parser';
import { config } from '$lib/config';
import { getUserData, setUserData } from '$lib/util/userData';
import { withBackoff } from '$lib/util/backoff';
import { throttleDebounce } from '$lib/util/throttleDebounce';
import type { PodcastProgress } from '$lib/stores/podcast/podcastProgress';

export interface Podcast {
	id: string;
	title: string;
	description: string;
	imageUrl: string;
	items: Episode[];
	categories: string[];
	rssUrl: string;
	lastFetched: number; // Timestamp when this podcast was last fetched
}

export interface Episode {
	id: string;
	title: string;
	/** Omitted in cache for older episodes to stay under localStorage quota. */
	url?: string;
	duration?: string;
	image?: string;
	description?: string;
	pubDate?: string;
}

/** How many leading episodes keep url/duration/pubDate in localStorage. */
export const CACHE_FULL_EPISODE_COUNT = 30;

function rssText(value: unknown): string | undefined {
	if (typeof value === 'string' || typeof value === 'number') return String(value);
	if (value && typeof value === 'object' && '#text' in value) {
		return rssText((value as { '#text': unknown })['#text']);
	}
	return undefined;
}

export function episodeHasPlayableUrl(
	episode: Episode | undefined
): episode is Episode & { url: string } {
	return Boolean(episode?.url);
}

export async function getPodcastRssUrls() {
	const feedsUrl = config.podcast.feedUrlsEndpoint;
	const res = await withBackoff(
		async () => {
			const response = await fetch(feedsUrl, { cache: 'no-store' });
			if (!response.ok) {
				throw new Error(
					`Failed to fetch podcast RSS URLs: ${response.status} ${response.statusText}`
				);
			}
			return response;
		},
		2,
		1000,
		7
	);
	const text = await res.text();
	return text
		.split('\n')
		.map((url) => url.trim())
		.filter((url) => url.length > 0 && !url.startsWith('#'));
}

export async function fetchPodcast(url: string): Promise<Podcast | null> {
	try {
		const response = await withBackoff(
			async () => {
				const response = await fetch(url, { cache: 'no-store' });
				if (!response.ok) {
					throw new Error(
						`Failed to fetch podcast from ${url}: ${response.status} ${response.statusText}`
					);
				}
				return response;
			},
			2,
			1000,
			3
		);
		const xmlText = await response.text();
		const parser = new XMLParser();
		const parsed = parser.parse(xmlText);

		if (!parsed?.rss?.channel) {
			console.error(`Skipping feed ${url}: Invalid RSS structure`);
			return null;
		}

		const channel = parsed.rss.channel;

		if (!channel.item?.length) {
			console.error(`Skipping feed ${url}: No episodes found`);
			return null;
		}

		const podcast: Podcast = {
			title: channel.title,
			imageUrl: channel['itunes:image']?.href || channel.image?.url,
			description: channel['itunes:summary'] || channel.description,
			id: channel['podcast:guid'] || url, // Use URL as fallback ID
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items: channel.item.map((item: any) => {
				const episode: Episode = {
					id: rssText(item.guid) || item.enclosure?.url || item.link,
					title: item.title,
					url: item.enclosure?.url || item.link,
					duration: item['itunes:duration'],
					image: item['itunes:image']?.href || item.image?.url,
					description: item.description || item['itunes:summary'],
					pubDate: item.pubDate
				};
				return episode;
			}),
			categories: Array.isArray(channel.category)
				? channel.category
				: channel.category
					? [channel.category]
					: [],
			rssUrl: url,
			lastFetched: Date.now()
		};
		return podcast;
	} catch (error) {
		console.error(`Error processing RSS feed ${url}:`, error);
		return null;
	}
}

// Limit how many RSS feeds are fetched/parsed at the same time to reduce peak
// memory usage on low-RAM devices.
const FETCH_CONCURRENCY = 10;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LAST_REFRESH_KEY = 'podcasts-last-refresh';

function readLastRefreshAt(): number {
	if (typeof window === 'undefined') return 0;
	const raw = localStorage.getItem(LAST_REFRESH_KEY);
	const parsed = raw ? Number(raw) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function writeLastRefreshAt(timestamp: number) {
	if (typeof window === 'undefined') return;
	localStorage.setItem(LAST_REFRESH_KEY, String(timestamp));
}

function progressEpisodeIdByPodcast(): Map<string, string> {
	const progress = getUserData('podcast-progress') as PodcastProgress;
	const map = new Map<string, string>();
	for (const [podcastId, ep] of Object.entries(progress ?? {})) {
		if (ep?.episodeId) map.set(podcastId, ep.episodeId);
	}
	return map;
}

/**
 * Cache keeps every episode title (search), but only recent / in-progress
 * episodes keep playable urls so localStorage stays under quota.
 */
export function slimPodcastForCache(
	podcast: Podcast,
	progressEpisodeId?: string
): Podcast {
	return {
		id: podcast.id,
		title: podcast.title,
		description: podcast.description ?? '',
		imageUrl: podcast.imageUrl,
		categories: podcast.categories,
		rssUrl: podcast.rssUrl,
		lastFetched: podcast.lastFetched,
		items: podcast.items.map((episode, index) => {
			const keepFull =
				Boolean(episode.url) &&
				(index < CACHE_FULL_EPISODE_COUNT || episode.id === progressEpisodeId);

			if (keepFull) {
				return {
					id: episode.id,
					title: episode.title,
					url: episode.url,
					duration: episode.duration,
					pubDate: episode.pubDate
				};
			}

			return {
				id: episode.id,
				title: episode.title
			};
		})
	};
}

function createPodcastsStore() {
	const { subscribe, set, update } = writable<Podcast[]>([]);
	let latestPodcasts: Podcast[] = [];
	let refreshInFlight = false;
	let lastRefreshAt = readLastRefreshAt();
	const ensureInFlight = new Map<string, Promise<Podcast | null>>();

	subscribe((value) => {
		latestPodcasts = value;
	});

	function hydrateFromCache() {
		const cachedPodcasts = getUserData('cached-podcasts') as Podcast[];
		if (cachedPodcasts.length > 0) {
			set(cachedPodcasts);
		}
	}

	function orderPodcasts(
		feedUrls: string[],
		fetchedPodcastMap: Map<string, Podcast>,
		existing: Podcast[]
	): Podcast[] {
		const existingPodcastsMap = new Map<string, Podcast>();
		existing.forEach((podcast) => {
			existingPodcastsMap.set(podcast.rssUrl, podcast);
		});

		const orderedPodcasts: Podcast[] = [];
		for (const url of feedUrls) {
			const podcast = fetchedPodcastMap.get(url) ?? existingPodcastsMap.get(url);
			if (podcast) {
				orderedPodcasts.push(podcast);
			}
		}
		return orderedPodcasts;
	}

	function persistPodcastCache(podcastList: Podcast[]): boolean {
		const progressIds = progressEpisodeIdByPodcast();
		return setUserData(
			'cached-podcasts',
			podcastList.map((podcast) =>
				slimPodcastForCache(podcast, progressIds.get(podcast.id))
			)
		);
	}

	function mergePodcast(podcast: Podcast) {
		update((list) => {
			const index = list.findIndex(
				(p) => p.id === podcast.id || p.rssUrl === podcast.rssUrl
			);
			const next =
				index >= 0
					? list.map((p, i) => (i === index ? podcast : p))
					: [...list, podcast];
			persistPodcastCache(next);
			return next;
		});
	}

	/** Refetch RSS when cached episodes lack playable urls. */
	async function ensureFull(podcast: Podcast): Promise<Podcast | null> {
		if (podcast.items.length > 0 && podcast.items.every((ep) => ep.url)) {
			return podcast;
		}

		const key = podcast.rssUrl;
		const existing = ensureInFlight.get(key);
		if (existing) return existing;

		const promise = fetchPodcast(key)
			.then((fetched) => {
				if (fetched) mergePodcast(fetched);
				return fetched;
			})
			.finally(() => {
				ensureInFlight.delete(key);
			});

		ensureInFlight.set(key, promise);
		return promise;
	}

	async function refresh(force = false) {
		if (refreshInFlight) return;
		if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return;

		refreshInFlight = true;

		try {
			const feedUrls = await getPodcastRssUrls();

			const fetchedPodcastMap = new Map<string, Podcast>();

			const throttledUpdate = throttleDebounce(
				() => {
					update((podcastList) => {
						const orderedPodcasts = orderPodcasts(
							feedUrls,
							fetchedPodcastMap,
							podcastList
						);
						persistPodcastCache(orderedPodcasts);
						return orderedPodcasts;
					});
				},
				500,
				false,
				true
			);

			let nextIndex = 0;
			async function worker() {
				while (nextIndex < feedUrls.length) {
					const url = feedUrls[nextIndex++];
					try {
						const podcast = await fetchPodcast(url);

						if (podcast) {
							fetchedPodcastMap.set(url, podcast);
							throttledUpdate();
						}
					} catch (error) {
						console.error(`Error processing podcast ${url}:`, error);
					}
				}
			}

			const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, feedUrls.length) }, () =>
				worker()
			);
			await Promise.all(workers);

			// Final write (throttled updates may still be pending / mid-run)
			let cacheSaved = false;
			update((podcastList) => {
				const orderedPodcasts = orderPodcasts(feedUrls, fetchedPodcastMap, podcastList);
				cacheSaved = persistPodcastCache(orderedPodcasts);
				return orderedPodcasts;
			});

			// Only mark refresh complete if the catalog actually fit in storage
			if (cacheSaved) {
				lastRefreshAt = Date.now();
				writeLastRefreshAt(lastRefreshAt);
			}
		} finally {
			refreshInFlight = false;
		}
	}

	if (typeof window !== 'undefined') {
		hydrateFromCache();
		refresh();
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') refresh();
		});
	}

	return {
		subscribe,
		ensureFull,
		mergePodcast,
		getAll: () => latestPodcasts
	};
}

export const podcasts = createPodcastsStore();
