<script lang="ts">
	import { beforeNavigate, goto, onNavigate } from '$app/navigation';
	import { ChevronLeft, Search, Settings, SquareArrowOutUpRight } from 'lucide-svelte';
	import TouchableButton from '$lib/components/utility/TouchableButton.svelte';
	import SearchInput from '$lib/components/utility/SearchInput.svelte';
	import { config } from '$lib/config/config';
	import { getIconComponent } from '$lib/util/getIconComponent';
	import { writable } from 'svelte/store';
	import ExternalLinksModal from '$lib/components/modals/ExternalLinksModal.svelte';
	import { onMount, tick } from 'svelte';
	import { t } from '$lib/i18n';
	import { searchOpen, searchQuery, openSearch, closeSearch } from '$lib/stores/search';

	const showBackButton = writable(false);
	let externalLinksModal: ExternalLinksModal;
	let searchButtonEl: HTMLElement | null = null;
	let wasSearchOpen = false;

	$: searchOpenOnHome = !$showBackButton && $searchOpen;

	$: {
		if (wasSearchOpen && !$searchOpen) {
			searchQuery.set('');
			void restoreSearchButtonFocus();
		}
		wasSearchOpen = $searchOpen;
	}

	onMount(() => {
		showBackButton.set(window.location.pathname !== '/');
	});

	beforeNavigate((navigation) => {
		if (
			navigation.type !== 'popstate' &&
			$searchOpen &&
			navigation.from?.url.pathname === '/' &&
			navigation.to?.url.pathname !== '/'
		) {
			closeSearch({ popHistory: false });
		}
	});

	onNavigate((navigation) => {
		showBackButton.set(navigation.to?.url.pathname !== '/');
	});

	async function restoreSearchButtonFocus() {
		await tick();
		if (searchButtonEl?.isConnected) {
			searchButtonEl.focus();
		}
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (
			event.key === 'Escape' &&
			$searchOpen &&
			!event.defaultPrevented &&
			!event.isComposing &&
			!document.querySelector('dialog[open]')
		) {
			event.preventDefault();
			closeSearch();
		}
	}
</script>

<svelte:window on:keydown={handleSearchKeydown} />

<div class="flex w-full items-center gap-1 sm:gap-2">
	<div class="flex shrink-0 items-center {searchOpenOnHome ? 'max-sm:hidden' : ''}">
		<TouchableButton
			onClick={() => ($showBackButton ? window.history.back() : goto('/'))}
			ariaLabel={$t.navbar.goBack}
			circle={false}
			buttonClassName="px-1"
			size="sm"
		>
			{#if $showBackButton}
				<ChevronLeft class="w-[32px]" />
			{:else}
				<img
					src="/favicon.png"
					alt="Logo"
					class="h-full w-[32px] rounded-full border border-base-content/30"
					draggable="false"
				/>
			{/if}
		</TouchableButton>
		<a href="/" class={`text-l z-10 pl-0 font-bold text-base-content sm:text-2xl`}>
			{config.website.title}
		</a>
	</div>

	<div class="ml-auto flex min-w-0 flex-1 items-center justify-end sm:flex-none">
		{#if searchOpenOnHome}
			<div
				role="search"
				aria-label={$t.home.searchLabel}
				class="flex min-w-0 flex-1 items-center gap-1 sm:flex-none sm:w-72 md:w-80 lg:w-96"
			>
				<TouchableButton
					onClick={closeSearch}
					ariaLabel={$t.navbar.closeSearch}
					circle={false}
					buttonClassName="px-1"
					size="sm"
				>
					<ChevronLeft class="w-[32px]" />
				</TouchableButton>
				<SearchInput
					bind:value={$searchQuery}
					placeholder={$t.home.searchPlaceholder}
					ariaLabel={$t.home.searchLabel}
					clearLabel={$t.home.searchClear}
				/>
			</div>
		{:else if !$showBackButton}
			<TouchableButton
				bind:el={searchButtonEl}
				onClick={openSearch}
				ariaLabel={$t.navbar.search}
				circle={false}
				size="sm"
			>
				<Search class="h-5 w-5 sm:h-6 sm:w-6" />
			</TouchableButton>
		{/if}

		{#each config.website.links as link (link.url)}
			<TouchableButton
				onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
				ariaLabel={link.iconLabel}
				circle={false}
				size="sm"
			>
				<svelte:component this={getIconComponent(link.iconLabel)} class="h-5 w-5 sm:h-6 sm:w-6" />
			</TouchableButton>
		{/each}

		<TouchableButton
			onClick={() => externalLinksModal.open()}
			ariaLabel={$t.navbar.otherLinks}
			circle={false}
			size="sm"
		>
			<SquareArrowOutUpRight class="h-5 w-5 sm:h-6 sm:w-6" />
		</TouchableButton>

		<TouchableButton
			onClick={() => goto('/settings')}
			ariaLabel={$t.settings.title}
			circle={false}
			size="sm"
		>
			<Settings class="h-5 w-5 sm:h-6 sm:w-6" />
		</TouchableButton>
	</div>
</div>

<ExternalLinksModal bind:this={externalLinksModal} />
