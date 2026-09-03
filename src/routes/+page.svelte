<script lang="ts">
	import PodcastCard from '$lib/components/PodcastCard.svelte';
	import RadioCard from '$lib/components/RadioCard.svelte';
	import SkeletonCard from '$lib/components/SkeletonCard.svelte';
	import { settings } from '$lib/stores/settings';
	import { radioFavorites } from '$lib/stores/radio/radioFavorites';
	import { podcastFavorites } from '$lib/stores/podcast/podcastFavorites';
	import DropdownSelect from '$lib/components/utility/DropdownSelect.svelte';
	import TouchableButton from '$lib/components/utility/TouchableButton.svelte';
	import { config } from '$lib/config';
	import { togglePlaylist } from '$lib/stores/player';
	import { radios, type Radio } from '$lib/stores/radio/radios';
	import { podcasts, type Podcast } from '$lib/stores/podcast/podcasts';
	import { t } from '$lib/i18n';
	import { playerStore } from '$lib/stores/player';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import VirtualList from '$lib/components/utility/VirtualList.svelte';
	import { searchPodcasts, type SearchHit } from '$lib/util/search';
	import { searchQuery } from '$lib/stores/search';
	import { Archive, ChevronDown, Radio as RadioIcon, RotateCcw, Star } from 'lucide-svelte';

	let expandedPodcasts = new Set<string>();
	let headerClasses = 'mb-2 sm:mb-4';
	let archiveSectionClasses = 'pt-6 sm:pt-8';
	let archiveFilterSpacingClasses = 'pb-6 sm:pb-8';
	let sectionLabelClasses = 'text-base font-semibold text-base-content';
	let sectionIconClasses = 'h-5 w-5 shrink-0 text-primary';
	let categoryFilterButtonClasses =
		'btn btn-sm inline-flex h-10 min-h-10 items-center gap-2 border border-base-300 bg-base-200 px-3 shadow-sm hover:bg-base-300 hover:shadow-md sm:px-4';
	let categoryHeaderClasses =
		'mb-2 flex items-center gap-3 border-b border-base-content/15 pb-2 sm:mb-4 sm:pb-3';
	let categoryTitleClasses = 'text-base font-semibold text-base-content';
	let sectionClasses = 'grid grid-cols-1 items-start gap-2 sm:gap-4 lg:grid-cols-2 2xl:grid-cols-3';
	const ALL_CATEGORY = 'All'; // Keep this as a constant for comparison
	const UNCategorized = '__uncategorized__';

	let lastSearchKey = '';

	let sharedPodcastId: string | null = null;
	let sharedEpisodeId: string | null = null;
	let sharedRadioId: string | null = null;
	let sharedTimeSeconds = 0;
	let shareHandled = false;

	// Create a locale-aware sorter based on the current language
	$: localeSorter = new Intl.Collator($settings.language, { sensitivity: 'base' });

	$: selectedCategory = $settings.selectedCategory;
	$: categoryList = [
		...new Set(
			$podcasts.flatMap((p) =>
				p.categories.filter((cat) => !config.podcast.bypassCategories.includes(cat))
			)
		)
	].sort((a, b) => localeSorter.compare(a, b));
	$: categoryOptions = [
		{ value: ALL_CATEGORY, label: $t.home.allCategories },
		...categoryList.map((cat) => ({ value: cat, label: cat }))
	];
	$: favoriteRadios = $radios.filter((radio) => !!$radioFavorites[radio.title]);
	$: otherRadios = $radios.filter((radio) => !$radioFavorites[radio.title]);
	$: favoritePodcasts = $podcasts.filter((podcast) => !!$podcastFavorites[podcast.id]);

	$: isSearching = $searchQuery.trim().length > 0;
	$: categoryPodcasts =
		selectedCategory === ALL_CATEGORY
			? $podcasts
			: $podcasts.filter((podcast) => podcast.categories.includes(selectedCategory));
	$: filteredPodcasts = categoryPodcasts.filter((podcast) => !$podcastFavorites[podcast.id]);
	$: otherPodcasts = filteredPodcasts;
	$: searchHits = isSearching
		? searchPodcasts(categoryPodcasts, $searchQuery)
		: [];
	$: searchHitById = new Map(searchHits.map((hit) => [hit.podcast.id, hit]));
	$: exactPodcasts = searchHits.filter((hit) => hit.matchKind === 'exact').map((hit) => hit.podcast);
	$: similarPodcasts = searchHits
		.filter((hit) => hit.matchKind === 'similar')
		.map((hit) => hit.podcast);
	$: archivePodcasts = isSearching ? searchHits.map((hit) => hit.podcast) : otherPodcasts;

	function getPrimaryCategory(podcast: Podcast): string {
		const visible = podcast.categories.filter(
			(cat) => !config.podcast.bypassCategories.includes(cat)
		);
		if (visible.length === 0) return UNCategorized;
		return visible[0];
	}

	$: archiveCategoryOrder = (() => {
		const seen = new Set<string>();
		const order: string[] = [];
		for (const podcast of otherPodcasts) {
			const cat = getPrimaryCategory(podcast);
			if (!seen.has(cat)) {
				seen.add(cat);
				order.push(cat);
			}
		}
		return order;
	})();

	$: archiveGroups =
		selectedCategory === ALL_CATEGORY && !isSearching
			? archiveCategoryOrder
					.map((cat) => ({
						category: cat,
						podcasts: otherPodcasts.filter((p) => getPrimaryCategory(p) === cat)
					}))
					.filter((g) => g.podcasts.length > 0)
			: [];

	$: if ($searchQuery !== lastSearchKey) {
		const previousQuery = lastSearchKey;
		lastSearchKey = $searchQuery;
		expandedPodcasts = new Set();

		const next = $searchQuery.trim();
		const prev = previousQuery.trim();
		if (next && next !== prev && selectedCategory !== ALL_CATEGORY) {
			settings.updateSettings({ selectedCategory: ALL_CATEGORY });
		}
	}

	$: if (typeof window !== 'undefined' && $searchQuery.trim()) {
		queueMicrotask(() => {
			const scroller = document.querySelector<HTMLElement>('[data-main-scroller]');
			scroller?.scrollTo({ top: 0 });
		});
	}

	function searchMatch(podcast: Podcast): SearchHit | undefined {
		return searchHitById.get(podcast.id);
	}

	async function tryHandleShare() {
		if (sharedPodcastId) {
			const podcast = get(podcasts).find((p) => p.id === sharedPodcastId);
			if (podcast) {
				const full = (await podcasts.ensureFull(podcast)) ?? podcast;
				const episode = full.items.find(
					(e) => e.id === (sharedEpisodeId ?? full.items[0].id)
				);
				if (episode?.url) {
					await playerStore.playPodcast(full, episode, sharedTimeSeconds);
					togglePlaylist(sharedPodcastId);
					return true;
				}
			}
		} else if (sharedRadioId) {
			const radio = get(radios).find((r) => r.id === sharedRadioId);
			if (radio) {
				playerStore.playRadio(radio);
				togglePlaylist();
				return true;
			}
		}

		return false;
	}

	onMount(() => {
		if (typeof window === 'undefined') return;

		const url = new URL(window.location.href);
		sharedPodcastId = url.searchParams.get('podcast');
		sharedEpisodeId = url.searchParams.get('episode');
		sharedRadioId = url.searchParams.get('radio');
		const timeParam = url.searchParams.get('t');
		sharedTimeSeconds = timeParam ? parseInt(timeParam, 10) || 0 : 0;

		if (!sharedPodcastId && !sharedRadioId) {
			shareHandled = true;
			return;
		}

		void tryHandleShare().then((ok) => {
			shareHandled = ok;
		});
	});

	$: if (
		!shareHandled &&
		typeof window !== 'undefined' &&
		((sharedPodcastId && $podcasts.length > 0) || (sharedRadioId && $radios.length > 0))
	) {
		shareHandled = true; // prevent re-entry while resolving
		void tryHandleShare().then((ok) => {
			if (!ok) shareHandled = false;
		});
	}

	function handlePodcastExpand(podcastId: string, isExpanded: boolean) {
		if (isExpanded) {
			expandedPodcasts.add(podcastId);
			if ($settings.autoCollapse) {
				// Close other expanded podcasts
				const checkboxes = document.querySelectorAll('.collapse input[type="checkbox"]');
				checkboxes.forEach((element) => {
					const checkbox = element as HTMLInputElement;
					const currentPodcastId = checkbox.parentElement?.parentElement?.dataset.podcastId;
					if (checkbox.checked && currentPodcastId && currentPodcastId !== podcastId) {
						checkbox.checked = false;
						expandedPodcasts.delete(currentPodcastId);
					}
				});
			}
			// Use togglePlaylist for scrolling
			togglePlaylist(podcastId);
		} else {
			expandedPodcasts.delete(podcastId);
		}
		expandedPodcasts = expandedPodcasts; // Trigger reactivity
	}
</script>

{#if !isSearching}
	{#if favoriteRadios.length > 0 || favoritePodcasts.length > 0}
		<div class="flex items-center gap-2 sm:gap-3 {headerClasses}">
			<Star class={sectionIconClasses} aria-hidden="true" />
			<h2 class={sectionLabelClasses}>{$t.home.favorites}</h2>
		</div>
		<div class={sectionClasses}>
			{#each favoriteRadios as radio (radio.title)}
				<RadioCard {radio} />
			{/each}
			<VirtualList items={favoritePodcasts} estimatedItemHeight={97.5}>
				<svelte:fragment let:item>
					<PodcastCard
						podcast={item as Podcast}
						expanded={expandedPodcasts.has((item as Podcast).id)}
						onExpand={handlePodcastExpand}
					/>
				</svelte:fragment>
			</VirtualList>
		</div>
		<div class="divider"></div>
	{/if}

	<div class="flex items-center gap-2 sm:gap-3 {headerClasses}">
		<RadioIcon class={sectionIconClasses} aria-hidden="true" />
		<h2 class={sectionLabelClasses}>{$t.home.radio}</h2>
	</div>
	<div class={sectionClasses}>
		{#if $radios.length === 0}
			{#each Array(4) as _}
				<SkeletonCard />
			{/each}
		{:else if otherRadios.length === 0}
			<p class="text-base-content-secondary">{$t.home.allStationsInFavorites}</p>
		{:else}
			<VirtualList items={otherRadios} estimatedItemHeight={97.5}>
				<svelte:fragment let:item>
					<RadioCard radio={item as Radio} />
				</svelte:fragment>
			</VirtualList>
		{/if}
	</div>

	<div class="divider"></div>
{/if}

{#snippet podcastGrid(items: Podcast[])}
	<div class={sectionClasses}>
		<VirtualList {items} estimatedItemHeight={97.5}>
			<svelte:fragment let:item>
				{@const podcast = item as Podcast}
				{@const hit = searchMatch(podcast)}
				<PodcastCard
					{podcast}
					expanded={expandedPodcasts.has(podcast.id)}
					onExpand={handlePodcastExpand}
					matchField={hit?.matchField}
					matchedEpisodeIds={hit?.matchedEpisodeIds}
					highlightQuery={isSearching ? $searchQuery : ''}
				/>
			</svelte:fragment>
		</VirtualList>
	</div>
{/snippet}

<section class={archiveSectionClasses}>
	<div class={archiveFilterSpacingClasses}>
		<div class="flex items-center gap-2">
			<DropdownSelect
				value={$settings.selectedCategory}
				onChange={(value) => settings.updateSettings({ selectedCategory: value })}
				options={categoryOptions}
				backgroundColor="bg-base-200"
				specialFirstOption={true}
				matchOptionWidth={true}
				width="w-auto"
			>
				<div slot="trigger" class={categoryFilterButtonClasses}>
					<Archive class="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
					<span class="font-semibold">{$t.home.archive}</span>
					<span class="h-4 w-px shrink-0 bg-base-content/20" aria-hidden="true"></span>
					<span class="font-medium"
						>{categoryOptions.find((o) => o.value === $settings.selectedCategory)?.label}</span
					>
					<ChevronDown class="h-4 w-4 shrink-0 opacity-80" />
				</div>
			</DropdownSelect>
			{#if $settings.selectedCategory !== ALL_CATEGORY}
				<TouchableButton
					size="sm"
					ariaLabel={$t.home.resetCategoryFilter}
					onClick={() => settings.updateSettings({ selectedCategory: ALL_CATEGORY })}
				>
					<RotateCcw class="h-4 w-4" />
				</TouchableButton>
			{/if}
		</div>
	</div>

{#if $podcasts.length === 0}
	<div class={sectionClasses}>
		{#each Array(6) as _}
			<SkeletonCard />
		{/each}
	</div>
{:else if isSearching}
	{#if archivePodcasts.length === 0}
		<p class="text-base-content-secondary">{$t.home.searchNoResults}</p>
	{:else}
		{#if exactPodcasts.length > 0}
			<h3 class="mb-2 text-lg font-semibold sm:mb-4">{$t.home.searchExactMatches}</h3>
			{@render podcastGrid(exactPodcasts)}
		{/if}
		{#if similarPodcasts.length > 0}
			{#if exactPodcasts.length > 0}
				<div class="divider"></div>
			{/if}
			<h3 class="mb-2 text-lg font-semibold sm:mb-4">{$t.home.searchSimilarMatches}</h3>
			{@render podcastGrid(similarPodcasts)}
		{/if}
	{/if}
{:else if archivePodcasts.length === 0}
	<p class="text-base-content-secondary">{$t.home.allArchiveInFavorites}</p>
{:else if selectedCategory === ALL_CATEGORY}
	{#each archiveGroups as group, i (group.category)}
		<div class="{i > 0 ? 'mt-4 sm:mt-6' : ''} {categoryHeaderClasses}">
			<span class="h-4 w-1 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
			<h3 class={categoryTitleClasses}>
				{group.category === UNCategorized ? $t.home.uncategorized : group.category}
			</h3>
		</div>
		{@render podcastGrid(group.podcasts)}
	{/each}
{:else}
	{@render podcastGrid(archivePodcasts)}
{/if}
</section>
