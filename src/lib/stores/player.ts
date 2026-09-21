import { writable, get } from 'svelte/store';
import { tick } from 'svelte';
import { settings } from '$lib/stores/settings';
import { clearSearch } from '$lib/stores/search';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { podcasts, type Episode, type Podcast } from '$lib/stores/podcast/podcasts';
import { radios, type Radio } from '$lib/stores/radio/radios';
import { blinkClasses } from '$lib/util/blinkClassess';
import { scrollIntoViewPromise } from '$lib/util/scrollIntoViewPromised';
import { podcastProgress, getEpisodeProgressTimestamp, getLatestEpisodeProgress, resolveResumeTimestamp } from '$lib/stores/podcast/podcastProgress';
import { radioProgress } from '$lib/stores/radio/radioProgress';
import { initMediaSession, updateMediaSessionMetadata } from '$lib/util/media_session';

interface BasePlayerState {
	isPlaying: boolean;
	currentTime: number;
	volume: number;
	playbackRate: number;
	muted: boolean;
	isBuffering: boolean;
	errored: boolean;
}

interface RadioPlayerState extends BasePlayerState {
	type: 'radio';
	currentRadio: Radio;
	currentPodcast: null;
	currentEpisode: null;
	playlist: [];
	duration: 0;
	playbackRate: 1;
}

interface PodcastPlayerState extends BasePlayerState {
	type: 'podcast';
	currentRadio: null;
	currentPodcast: Podcast;
	currentEpisode: Episode;
	playlist: Episode[];
	duration: number;
}

interface IdlePlayerState extends BasePlayerState {
	type: null;
	currentRadio: null;
	currentPodcast: null;
	currentEpisode: null;
	playlist: [];
	duration: 0;
}

export type PlayerState = RadioPlayerState | PodcastPlayerState | IdlePlayerState;

function readyStateIsAbleToPlay(readyState: number) {
	return (
		readyState === HTMLMediaElement.HAVE_CURRENT_DATA ||
		readyState === HTMLMediaElement.HAVE_FUTURE_DATA ||
		readyState === HTMLMediaElement.HAVE_ENOUGH_DATA
	);
}

// Initialize audio only in browser environment
let audio: HTMLAudioElement | undefined;
let resetAudioInterval: NodeJS.Timeout | undefined;
/** Last trusted playback position (ignores network-driven jumps to 100%). */
let lastKnownGoodTime = 0;
/** Timestamp of last media error — used to ignore false "ended" after failures. */
let lastMediaErrorAt = 0;
let recoveryInFlight = false;

if (typeof window !== 'undefined') {
	initAudio();
	if (get(settings).autoplayLastContent) {
		autoplayLastContent();
	}
}
function initAudio() {
	if (audio) return;

	audio = new Audio();

	// Register minimal Media Session controls
	initMediaSession({
		onSeekForward: () => skipForward(),
		onSeekBackward: () => skipBackward(),
		onNextTrack: () => playerStore.nextTrack(),
		onPreviousTrack: () => playerStore.previousTrack(),
		onStop: () => {
			togglePlayPause(false);
			if (audio) {
				audio.src = '';
			}
		}
	});

	audio.addEventListener('timeupdate', () => {
		if (!audio) return;
		const currentState = get(playerStore);
		// On network failure browsers pause and snap currentTime → duration (100% bar).
		// Only accept time while actively playing with no media error.
		if (
			currentState.errored ||
			recoveryInFlight ||
			audio.error ||
			audio.paused ||
			audio.ended
		) {
			return;
		}

		const t = audio.currentTime ?? 0;
		// Reject absurd forward jumps; intentional seeks go through seekTo().
		if (lastKnownGoodTime > 0 && t - lastKnownGoodTime > 5) {
			return;
		}

		lastKnownGoodTime = t;
		playerStore.updateCurrentTime(t, true);
		if (resetAudioInterval && readyStateIsAbleToPlay(audio.readyState)) {
			clearInterval(resetAudioInterval);
		}

		if (currentState.type === 'podcast') {
			podcastProgress.updatePodcastProgress(
				currentState.currentPodcast.id,
				currentState.currentEpisode.id,
				t
			);
		}
	});

	audio.addEventListener('loadstart', () => {
		playerStore.setBuffering(true);
	});
	audio.addEventListener('waiting', () => {
		playerStore.setBuffering(true);
	});
	audio.addEventListener('waitingforkey', () => {
		playerStore.setBuffering(true);
	});
	// audio.addEventListener('progress', () => {
	// 	console.log('progress');
	// });

	audio.addEventListener('canplay', () => {
		playerStore.setBuffering(false);
	});
	audio.addEventListener('playing', () => {
		playerStore.setBuffering(false);
		playerStore.setErrored(false);
		recoveryInFlight = false;
		lastMediaErrorAt = 0;
		clearAutoRetry();
		if (resetAudioInterval) {
			clearInterval(resetAudioInterval);
			resetAudioInterval = undefined;
		}
	});
	// suspend happens when the download happens and is paused until the player reaches the point of the download
	// audio.addEventListener('suspend', () => {
	// 	console.log(`suspend`);
	// });

	audio.addEventListener('stalled', () => {
		if (resetAudioInterval) {
			clearInterval(resetAudioInterval);
		}
		resetAudioInterval = setInterval(() => {
			void recoverPlayback();
		}, 4000);
	});

	audio.addEventListener('error', () => {
		recoveryInFlight = false;
		lastMediaErrorAt = Date.now();

		const state = get(playerStore);
		const restoreAt = lastKnownGoodTime;
		// Hard-freeze UI/progress at last trusted position (never 100% snap).
		if (state.type === 'podcast' && state.currentEpisode) {
			playerStore.updateCurrentTime(restoreAt, true);
			podcastProgress.updatePodcastProgress(
				state.currentPodcast.id,
				state.currentEpisode.id,
				restoreAt
			);
		} else {
			playerStore.updateCurrentTime(restoreAt, true);
		}

		playerStore.setErrored(true);
		scheduleAutoRetry();
	});
	// Do not treat abort as an error — changing audio.src / load() aborts the prior request.

	audio.addEventListener('ended', () => {
		const state = get(playerStore);
		if (state.type !== 'podcast') return;

		// recoverPlayback() clears src and can fire a spurious "ended" — never advance then.
		if (recoveryInFlight) {
			return;
		}

		// Network/decode failures often emit "ended" after "error", sometimes much later once
		// the connection returns. Never treat those as episode completion.
		if (lastMediaErrorAt > 0 && Date.now() - lastMediaErrorAt < 60_000) {
			playerStore.setErrored(true);
			scheduleAutoRetry();
			return;
		}

		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			playerStore.setErrored(true);
			scheduleAutoRetry();
			return;
		}

		const duration =
			Number.isFinite(audio?.duration) && (audio?.duration ?? 0) > 0
				? (audio?.duration as number)
				: state.duration;
		// Use last known *good* position only — state/audio time may already be corrupted to 100%.
		const currentTime = lastKnownGoodTime > 0 ? lastKnownGoodTime : state.currentTime;
		const nearEnd =
			Number.isFinite(duration) && duration > 0 && currentTime >= Math.max(0, duration - 3);

		const src = audio?.getAttribute('src') || '';
		if (!src || !nearEnd) {
			playerStore.setErrored(true);
			scheduleAutoRetry();
			return;
		}

		// Genuine end of episode → mark finished and optionally advance.
		lastMediaErrorAt = 0;
		podcastProgress.updatePodcastProgress(state.currentPodcast.id, state.currentEpisode.id, 0);
		playerStore.nextTrack(get(settings).autoplay);
	});

	audio.addEventListener('pause', () => {
		playerStore.updateIsPlaying();
		// If pause is from a failure snap, keep the bar where it was.
		if (lastKnownGoodTime >= 0 && (get(playerStore).errored || audio?.error)) {
			playerStore.updateCurrentTime(lastKnownGoodTime, true);
		}
	});
	audio.addEventListener('play', () => {
		playerStore.updateIsPlaying();
	});
}
function toggleAudioWhenReady(value?: boolean, retries: number = 0) {
	setTimeout(() => {
		if (retries > 10) return;
		if (!audio) {
			return setTimeout(() => toggleAudioWhenReady(value, retries + 1), 100);
		}
		if (audio) {
			if (value === undefined) {
				value = audio.paused;
			}
			if (value) {
				audio.play().catch((e) => {
					if (e.name === 'NotAllowedError') {
						playerStore.setMuted();
					} else {
						lastMediaErrorAt = Date.now();
						playerStore.setErrored(true);
						scheduleAutoRetry();
					}
				});
			} else {
				audio.pause();
			}
		}
	}, 0);
}

const MAX_AUTO_RETRIES = 5;
const AUTO_RETRY_MS = 5000;
let autoRetryInterval: ReturnType<typeof setInterval> | undefined;
let autoRetryCount = 0;

function clearAutoRetry() {
	if (autoRetryInterval) {
		clearInterval(autoRetryInterval);
		autoRetryInterval = undefined;
	}
	autoRetryCount = 0;
}

function scheduleAutoRetry() {
	if (autoRetryInterval) return;
	autoRetryCount = 0;
	autoRetryInterval = setInterval(() => {
		autoRetryCount += 1;
		if (autoRetryCount > MAX_AUTO_RETRIES) {
			clearAutoRetry();
			return;
		}
		const state = get(playerStore);
		if (state.type !== 'podcast' && state.type !== 'radio') {
			clearAutoRetry();
			return;
		}
		if (!state.errored && audio && !audio.paused) {
			clearAutoRetry();
			return;
		}
		void recoverPlayback();
	}, AUTO_RETRY_MS);
}

function getResumeTime(state: PlayerState): number {
	if (state.type !== 'podcast' || !state.currentEpisode) return 0;
	if (lastKnownGoodTime > 0) return lastKnownGoodTime;
	if (state.currentTime > 0) return state.currentTime;
	return getEpisodeProgressTimestamp(
		get(podcastProgress),
		state.currentPodcast.id,
		state.currentEpisode.id
	);
}

/**
 * Re-request the current source and resume.
 * When fromUserGesture is true, play() runs immediately (keeps the click gesture).
 */
async function recoverPlayback(fromUserGesture = false) {
	const state = get(playerStore);
	if (!audio) return;
	if (state.type !== 'radio' && state.type !== 'podcast') return;

	// Manual click always wins over an in-flight auto-retry
	if (recoveryInFlight && !fromUserGesture) return;
	recoveryInFlight = true;

	playerStore.setBuffering(true);
	playerStore.setErrored(false);

	const src =
		state.type === 'radio'
			? state.currentRadio.streamUrl
			: state.currentEpisode.url;

	if (!src) {
		recoveryInFlight = false;
		playerStore.setErrored(true);
		return;
	}

	const resumeAt = state.type === 'podcast' ? getResumeTime(state) : 0;

	try {
		// Force a real reload even when the URL is unchanged
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
		audio.src = src;
		audio.load();

		if (fromUserGesture) {
			// Keep play() inside the user gesture; seek after playback starts
			await audio.play();
			if (resumeAt > 0) {
				try {
					audio.currentTime = resumeAt;
				} catch {
					/* ignore seek errors on live/unready media */
				}
			}
			recoveryInFlight = false;
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const onCanPlay = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error('media error'));
			};
			const cleanup = () => {
				audio?.removeEventListener('canplay', onCanPlay);
				audio?.removeEventListener('error', onError);
			};
			audio?.addEventListener('canplay', onCanPlay);
			audio?.addEventListener('error', onError);
			if (audio && readyStateIsAbleToPlay(audio.readyState)) {
				cleanup();
				resolve();
			}
			setTimeout(() => {
				cleanup();
				resolve(); // try play anyway
			}, 4000);
		});

		if (resumeAt > 0) {
			try {
				audio.currentTime = resumeAt;
			} catch {
				/* ignore */
			}
		}
		await audio.play();
		recoveryInFlight = false;
	} catch {
		recoveryInFlight = false;
		lastMediaErrorAt = Date.now();
		playerStore.setErrored(true);
		playerStore.setBuffering(false);
		scheduleAutoRetry();
	}
}

function resetAudio() {
	void recoverPlayback();
}

function createPlayerStore() {
	const initialState: PlayerState = {
		isPlaying: false,
		currentTime: 0,
		duration: 0,
		volume: get(settings)?.volume ?? 1,
		playbackRate: get(settings)?.playbackRate ?? 1,
		muted: get(settings)?.muted ?? false,
		isBuffering: false,
		errored: false,
		type: null,
		currentRadio: null,
		currentPodcast: null,
		currentEpisode: null,
		playlist: []
	};

	const { subscribe, update } = writable<PlayerState>(initialState);

	subscribe((state) => {
		if (!audio) return;

		let shouldUpdateSource = false;

		// Check if source needs updating
		if (state.type === 'radio') {
			shouldUpdateSource = !audio.src || audio.src !== state.currentRadio.streamUrl;
		} else if (state.type === 'podcast') {
			shouldUpdateSource = !audio.src || audio.src !== state.currentEpisode.url;
		}

		// Update source if needed
		if (shouldUpdateSource) {
			if (state.type === 'radio') {
				console.log('playing radio', state.currentRadio.streamUrl);
				audio.src = state.currentRadio.streamUrl;
				audio.playbackRate = 1;
				radioProgress.updateRadioProgress(state.currentRadio.id);
			} else if (state.type === 'podcast') {
				console.log('playing podcast', state.currentEpisode.url);
				audio.src = state.currentEpisode.url;
				// Do not reset progress to 0 here — resume time comes from playPodcast / timeupdate.
			}
			// Wait for the source to be loaded
			audio.load();
		}

		// Always update volume, playback rate and muted state
		audio.volume = state.volume;
		audio.muted = state.muted;
		if (
			state.type === 'podcast' &&
			state.playbackRate &&
			audio &&
			audio.playbackRate !== state.playbackRate
		) {
			audio.playbackRate = state.playbackRate;
		}

		// Minimal Media Session metadata update
		updateMediaSessionMetadata(state);
	});

	function playRadio(radio: Radio) {
		update(
			(state): RadioPlayerState => ({
				...state,
				type: 'radio',
				currentTime: 0,
				duration: 0,
				playbackRate: 1,
				currentRadio: radio,
				currentPodcast: null,
				currentEpisode: null,
				playlist: []
			})
		);

		toggleAudioWhenReady(true);
	}

	function playPodcast(
		podcast: Podcast,
		startWithEpisode?: Episode,
		startWithTime?: number
	) {
		const episodeToPlay = startWithEpisode || podcast.items[0];
		if (!episodeToPlay) return;

		const stored =
			startWithTime !== undefined
				? startWithTime
				: getEpisodeProgressTimestamp(get(podcastProgress), podcast.id, episodeToPlay.id);
		const resumeAt = resolveResumeTimestamp(stored, episodeToPlay.duration);
		lastKnownGoodTime = resumeAt;
		lastMediaErrorAt = 0;

		update(
			(state): PodcastPlayerState => ({
				...state,
				type: 'podcast',
				currentTime: resumeAt,
				currentRadio: null,
				currentPodcast: podcast,
				currentEpisode: episodeToPlay,
				playlist: podcast.items,
				duration: episodeToPlay.duration ? Number(episodeToPlay.duration) : 0
			})
		);

		seekTo(resumeAt);
		toggleAudioWhenReady(true);
	}

	function setErrored(errored = true) {
		update((state) => ({ ...state, errored }));
	}

	function setMuted(muted = true) {
		update((state) => ({ ...state, muted }));
	}

	function setVolume(volume: number) {
		const normalizedVolume = Math.max(0, Math.min(1, volume));
		settings.updateSettings({ volume: normalizedVolume });
		update((state) => ({
			...state,
			volume: normalizedVolume,
			muted: normalizedVolume === 0
		}));
	}

	function toggleMuted(muted?: boolean) {
		update((state) => {
			const newMuted = muted ?? !state.muted;
			settings.updateSettings({ muted: newMuted });
			if (!newMuted) {
				toggleAudioWhenReady(true);
			}
			return {
				...state,
				muted: newMuted
			};
		});
	}

	function nextTrack(autoPlay: boolean = true) {
		const state = get({ subscribe });
		if (state.type !== 'podcast' || !state.currentEpisode) return;

		const currentIndex = state.playlist.findIndex((ep) => ep.id === state.currentEpisode?.id);
		if (currentIndex < 0 || currentIndex >= state.playlist.length - 1) {
			toggleAudioWhenReady(false);
			return;
		}

		const nextEpisode = state.playlist[currentIndex + 1];
		const resumeAt = resolveResumeTimestamp(
			getEpisodeProgressTimestamp(get(podcastProgress), state.currentPodcast.id, nextEpisode.id),
			nextEpisode.duration
		);
		lastKnownGoodTime = resumeAt;
		lastMediaErrorAt = 0;

		update(
			(s): PlayerState => {
				if (s.type !== 'podcast' || s.currentEpisode?.id !== state.currentEpisode?.id) return s;
				return {
					...s,
					currentEpisode: nextEpisode,
					duration: nextEpisode.duration ? Number(nextEpisode.duration) : 0,
					currentTime: resumeAt,
					isPlaying: !(audio?.paused ?? true)
				};
			}
		);

		seekTo(resumeAt);
		if (autoPlay) {
			toggleAudioWhenReady(true);
		}
	}

	function previousTrack() {
		const state = get({ subscribe });
		if (state.type !== 'podcast' || !state.currentEpisode) return;

		const currentIndex = state.playlist.findIndex((ep) => ep.id === state.currentEpisode?.id);
		if (currentIndex <= 0) return;

		const prevEpisode = state.playlist[currentIndex - 1];
		const resumeAt = resolveResumeTimestamp(
			getEpisodeProgressTimestamp(get(podcastProgress), state.currentPodcast.id, prevEpisode.id),
			prevEpisode.duration
		);
		lastKnownGoodTime = resumeAt;
		lastMediaErrorAt = 0;

		update(
			(s): PlayerState => {
				if (s.type !== 'podcast' || s.currentEpisode?.id !== state.currentEpisode?.id) return s;
				return {
					...s,
					currentEpisode: prevEpisode,
					duration: prevEpisode.duration ? Number(prevEpisode.duration) : 0,
					currentTime: resumeAt,
					isPlaying: !(audio?.paused ?? true)
				};
			}
		);

		seekTo(resumeAt);
		toggleAudioWhenReady(true);
	}

	function updateCurrentTime(explicitTime?: number, force = false) {
		update((state) => {
			if (!force && state.isBuffering) return state;
			return {
				...state,
				currentTime: explicitTime ?? audio?.currentTime ?? 0
			};
		});
	}

	function setPlaybackRate(playbackRate: number) {
		update((state) => {
			if (state.type === 'podcast') {
				settings.updateSettings({ playbackRate });
				return { ...state, playbackRate };
			} else {
				return state;
			}
		});
	}

	function updateCurrentRadio(radio: Radio) {
		update((state) => {
			if (state.type === 'radio' && state.currentRadio?.id === radio.id) {
				return { ...state, currentRadio: radio };
			}
			return state;
		});
	}

	function updateIsPlaying() {
		update((state) => ({
			...state,
			isPlaying: !(audio?.paused ?? true),
			muted: state.volume === 0
		}));
	}

	function setBuffering(buffering: boolean) {
		update((state) => ({ ...state, isBuffering: buffering }));
	}

	return {
		subscribe,
		setErrored,
		setMuted,
		setVolume,
		setBuffering,
		updateCurrentTime,
		updateIsPlaying,
		toggleMuted,
		playRadio,
		playPodcast,
		nextTrack,
		previousTrack,
		setPlaybackRate,
		updateCurrentRadio
	};
}

export const playerStore = createPlayerStore();

settings.subscribe((settings) => {
	if (settings.playbackRate !== get(playerStore).playbackRate) {
		playerStore.setPlaybackRate(settings.playbackRate);
	}
	if (settings.volume !== get(playerStore).volume) {
		playerStore.setVolume(settings.volume);
	}
});

// Keep radio metadata (artwork/title/artist) in sync with live track updates
radios.subscribe((list) => {
	const state = get(playerStore);
	if (state.type === 'radio' && state.currentRadio) {
		const updated = list.find((r) => r.id === state.currentRadio?.id);
		if (updated) {
			playerStore.updateCurrentRadio(updated);
		}
	}
});

// Player controls for AUDIO element
export function togglePlayPause(value?: boolean) {
	const state = get(playerStore);
	// Warning icon / failed network: force reconnect + play on this click gesture
	if (state.errored) {
		clearAutoRetry();
		scheduleAutoRetry();
		void recoverPlayback(true);
		return;
	}
	toggleAudioWhenReady(value);
}
export function seekTo(time: number) {
	if (!Number.isFinite(time) || time < 0) return;

	const state = get(playerStore);
	const duration =
		state.type === 'podcast' && Number.isFinite(state.duration) && state.duration > 0
			? state.duration
			: Number.isFinite(audio?.duration)
				? (audio?.duration as number)
				: undefined;
	const clamped =
		duration !== undefined && duration > 0 ? Math.min(time, duration) : time;

	lastKnownGoodTime = clamped;
	playerStore.updateCurrentTime(clamped, true);

	// When media is in error/offline state, audio.currentTime is unreliable — only update the store.
	if (audio && !audio.error && !state.errored) {
		try {
			audio.currentTime = clamped;
		} catch {
			/* ignore seek errors on unready media */
		}
	}
}
export function skipForward() {
	const state = get(playerStore);
	if (state.type !== 'podcast') return;

	const duration =
		Number.isFinite(state.duration) && state.duration > 0
			? state.duration
			: Number.isFinite(audio?.duration) && (audio?.duration as number) > 0
				? (audio?.duration as number)
				: 0;
	if (!duration) return;

	const current = lastKnownGoodTime > 0 ? lastKnownGoodTime : state.currentTime;
	if (!Number.isFinite(current)) return;

	const skipAmount = get(settings).skipSeconds;
	seekTo(Math.min(current + skipAmount, duration));
}
export function skipBackward() {
	const state = get(playerStore);
	if (state.type !== 'podcast') return;

	const current = lastKnownGoodTime > 0 ? lastKnownGoodTime : state.currentTime;
	if (!Number.isFinite(current)) return;

	const skipAmount = get(settings).skipSeconds;
	seekTo(Math.max(current - skipAmount, 0));
}
export function restartRadio() {
	const state = get(playerStore);
	if (state.type === 'radio' && state.currentRadio && audio) {
		clearAutoRetry();
		playerStore.setErrored(false);
		playerStore.setBuffering(true);
		audio.src = state.currentRadio.streamUrl;
		audio.load();
		toggleAudioWhenReady(true);
	}
}

function revealOnHome(task: () => Promise<void>): Promise<void> {
	// goto('/') from home would replace page.state and close search.
	if (page.url.pathname === '/') return task();
	return goto('/').then(task);
}

// Other player utilities
export function togglePlaylist(targetPodcastId?: string) {
	// Player "go to" has no target id; expand/reverse pass one and must keep search.
	if (targetPodcastId === undefined && clearSearch()) {
		tick().then(() => togglePlaylist());
		return;
	}
	const state = get(playerStore);
	const podcastId = targetPodcastId ?? (state.type === 'podcast' ? state.currentPodcast?.id : null);

	if (podcastId) {
		revealOnHome(async () => {
			// Ask VirtualLists to ensure the podcast is visible and await completion
			await ensureVisibleById(podcastId);

			const podcast = podcastId ? get(podcasts).find((p) => p.id === podcastId) : null;
			// After navigation, find and expand the podcast
			const podcastElement = document.querySelector(`[data-podcast-id="${podcastId}"]`);
			if (podcastElement) {
				// Function to find and scroll to episode
				const scrollToEpisode = async () => {
					const episodeButtons = podcastElement.querySelectorAll('button');
					const episodeId = state.currentEpisode?.id ?? podcast?.items[0].id;
					const episodeElement =
						Array.from(episodeButtons).find(
							(button) => button.getAttribute('data-episode-id') === episodeId
						) ?? episodeButtons[0];
					if (episodeElement) {
						scrollIntoViewPromise(episodeElement, { behavior: 'smooth', block: 'nearest' });
						scrollIntoViewPromise(podcastElement, { behavior: 'smooth', block: 'center' });
					}
				};

				// Expand the podcast if not already expanded
				const checkbox = podcastElement.querySelector('input[type="checkbox"]') as HTMLInputElement;
				if (checkbox && !checkbox.checked) {
					// Trigger the change event properly
					checkbox.checked = true;
					checkbox.dispatchEvent(new Event('change', { bubbles: true }));
				}

				// Get the collapse content element
				const collapseContent = podcastElement.querySelector('.collapse-content');
				if (collapseContent) {
					if (collapseContent.getAnimations().length > 0) {
						// Listen for the transition end
						const onTransitionEnd = (ev: Event) => {
							if (ev.target !== collapseContent) return;
							collapseContent.removeEventListener('transitionend', onTransitionEnd);
							scrollToEpisode();
						};
						collapseContent.addEventListener('transitionend', onTransitionEnd);
					} else {
						scrollToEpisode();
					}
				}
			} else {
				// If podcast is not found, check if it exists and if current category doesn't include it
				const settingsStore = get(settings);
				if (
					settingsStore.selectedCategory !== 'All' &&
					podcast?.categories &&
					!podcast.categories.includes(settingsStore.selectedCategory)
				) {
					settings.updateSettings({ selectedCategory: 'All' });
					// Wait for the next tick to let the UI update
					setTimeout(() => {
						return togglePlaylist(targetPodcastId);
					}, 0);
				}
			}
		});
	} else if (state.type === 'radio' && state.currentRadio) {
		revealOnHome(async () => {
			// Ask VirtualLists to ensure the radio is visible and await completion
			if (state.currentRadio) {
				await ensureVisibleById(state.currentRadio.id);
			}

			// Find the radio card by title
			const radioCard = Array.from(document.querySelectorAll('[role="button"]')).find(
				(element) => element.querySelector('h3')?.textContent === state.currentRadio?.title
			) as HTMLElement;
			if (radioCard) {
				await scrollIntoViewPromise(radioCard, { behavior: 'smooth', block: 'center' });
				// add focus visible
				const focusClasses = ['outline-primary', 'outline-2', 'outline-offset-2', 'outline'];
				radioCard.focus({ preventScroll: true });
				radioCard.onblur = () => {
					focusClasses.forEach((className) => radioCard.classList.remove(className));
				};
				await blinkClasses(radioCard, focusClasses, 1, 0, 1500);
			}
		});
	}
}

// Fire-and-wait helper: single-event with resolver
async function ensureVisibleById(id: string, timeoutMs = 4000) {
	return await new Promise<void>((resolve) => {
		const timer = setTimeout(() => resolve(), timeoutMs);
		// Defer dispatch to next tick to allow route/dom to settle
		setTimeout(() => {
			window.dispatchEvent(
				new CustomEvent('virtual-list-ensure-visible', {
					detail: {
						id,
						resolve: () => {
							clearTimeout(timer);
							resolve();
						}
					}
				})
			);
		}, 0);
	});
}
export async function autoplayLastContent() {
	const lastPlayedRadio = Object.entries(get(radioProgress)).reduce(
		(latest, [id, progress]) => {
			if (!latest || progress.lastPlayed > latest.lastPlayed) {
				return { id, lastPlayed: progress.lastPlayed };
			}
			return latest;
		},
		null as { id: string; lastPlayed: number } | null
	);

	const lastPlayedPodcast = Object.entries(get(podcastProgress)).reduce(
		(latest, [id, episodes]) => {
			const episodeProgress = getLatestEpisodeProgress(episodes);
			if (!episodeProgress) return latest;
			if (!latest || episodeProgress.lastPlayed > latest.lastPlayed) {
				return {
					id,
					lastPlayed: episodeProgress.lastPlayed,
					episodeId: episodeProgress.episodeId,
					timestamp: episodeProgress.timestamp
				};
			}
			return latest;
		},
		null as { id: string; lastPlayed: number; episodeId: string; timestamp: number } | null
	);

	if (!lastPlayedRadio && !lastPlayedPodcast) return;

	if (lastPlayedRadio && lastPlayedPodcast) {
		if (lastPlayedRadio.lastPlayed > lastPlayedPodcast.lastPlayed) {
			const radio = get(radios).find((r) => r.id === lastPlayedRadio.id);
			if (radio) playerStore.playRadio(radio);
		} else {
			const podcast = get(podcasts).find((p: Podcast) => p.id === lastPlayedPodcast.id);
			if (podcast) {
				const episode = podcast.items.find((e: Episode) => e.id === lastPlayedPodcast.episodeId);
				if (episode) {
					playerStore.playPodcast(
						podcast,
						episode,
						resolveResumeTimestamp(lastPlayedPodcast.timestamp, episode.duration)
					);
				}
			}
		}
		return;
	}

	if (lastPlayedRadio) {
		const radio = get(radios).find((r) => r.id === lastPlayedRadio.id);
		if (radio) playerStore.playRadio(radio);
		return;
	}

	if (lastPlayedPodcast) {
		const podcast = get(podcasts).find((p: Podcast) => p.id === lastPlayedPodcast.id);
		if (podcast) {
			const episode = podcast.items.find((e: Episode) => e.id === lastPlayedPodcast.episodeId);
			if (episode) {
				playerStore.playPodcast(
					podcast,
					episode,
					resolveResumeTimestamp(lastPlayedPodcast.timestamp, episode.duration)
				);
			}
		}
	}
}
