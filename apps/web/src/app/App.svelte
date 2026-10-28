<script lang="ts">
  import { onMount } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { Ellipsis, Eye, EyeOff } from "@lucide/svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { connectorList } from "@taiwan-fin-hub/shared";
  import Overview from "@/features/overview/OverviewPage.svelte";
  import type { ConnectorId } from "@/data/connectors/types";
  import { createApiClient } from "@/shared/api/client";
  import { swipeBack } from "@/shared/actions/swipe-back";
  import { moneyState } from "@/shared/state/money-visibility.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import Icon from "@/shared/ui/Icon.svelte";
  import {
    mobilePrimaryViews,
    mobileSettingsLabels,
    navItems,
  } from "./navigation-config";
  import { parseViewHash, viewHash } from "./navigation";
  import { recoverFromChunkLoadError } from "./chunk-reload";
  import { queryClient } from "./query-client";
  import type {
    MobileSettingsView,
    PrimaryView,
    RuntimeInfo,
    View,
  } from "./types";
  import "../styles.css";

  type LazyView = Exclude<View, "overview">;
  type PageKey = "assets" | "activity" | "settings";
  type LazyPageModule =
    | typeof import("@/features/assets/AssetsPage.svelte")
    | typeof import("@/features/activity/ActivityPage.svelte")
    | typeof import("@/features/settings/SettingsPage.svelte");
  type SettingsPageComponent =
    typeof import("@/features/settings/SettingsPage.svelte").default;

  const pageLoaders = {
    assets: () => import("@/features/assets/AssetsPage.svelte"),
    activity: () => import("@/features/activity/ActivityPage.svelte"),
    settings: () => import("@/features/settings/SettingsPage.svelte"),
  } satisfies Record<PageKey, () => Promise<LazyPageModule>>;
  const pagePromises: Partial<Record<PageKey, Promise<LazyPageModule>>> = {};

  const api = createApiClient();
  // Read the hash before the first render so deep links do not mount the
  // overview page and fire its queries first.
  const initialRouteView = parseViewHash(window.location.hash);
  let view = $state<View>(initialRouteView ?? "overview");
  let connectorTarget = $state<ConnectorId | null>(null);
  // 連接器詳情是否從「新增資料來源」面板選入；決定返回時要不要重新打開面板。
  let connectorFromAddSource = $state(false);
  let addSourceOpen = $state(false);
  let runtime = $state<RuntimeInfo>({ demoMode: false });
  const isMobileSetting = (v: View): v is MobileSettingsView =>
    Object.hasOwn(mobileSettingsLabels, v);
  const primaryViewOf = (v: View): PrimaryView =>
    v === "more" || isMobileSetting(v) ? "settings" : (v as PrimaryView);
  const navItemFor = (v: View) =>
    navItems.find((item) => item.view === primaryViewOf(v)) ?? navItems[0]!;
  const primaryView = $derived(primaryViewOf(view));

  function pageKey(next: LazyView): PageKey {
    if (next === "assets" || next === "activity") return next;
    return "settings";
  }

  function getPagePromise(key: PageKey) {
    return (pagePromises[key] ??= pageLoaders[key]());
  }

  const pagePromise = $derived.by(() => {
    if (view === "overview") return Promise.resolve(undefined);
    return getPagePromise(pageKey(view as LazyView));
  });

  function retryPage() {
    window.location.reload();
  }

  const isStandalone = () =>
    document.documentElement.classList.contains("is-standalone");
  function scrollToTop() {
    const options: ScrollToOptions = { top: 0, behavior: "smooth" };
    if (isStandalone()) document.getElementById("root")?.scrollTo(options);
    else window.scrollTo(options);
  }

  onMount(() => {
    if (!initialRouteView)
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${viewHash(view)}`,
      );

    const handleHashChange = () => {
      const next = parseViewHash(window.location.hash);
      if (next) {
        view = next;
        scrollToTop();
      }
    };
    window.addEventListener("hashchange", handleHashChange);

    void api
      .get<RuntimeInfo>("/api/runtime")
      .then((info) => (runtime = info))
      .catch(() => (runtime = { demoMode: false }));
    moneyState.hidden =
      localStorage.getItem("taiwan-fin-hub-money-hidden") === "true";
    return () => window.removeEventListener("hashchange", handleHashChange);
  });
  function navigate(
    next: View,
    targetConnector?: ConnectorId,
    options?: { fromAddSource?: boolean },
  ) {
    view = next;
    connectorTarget =
      next === "data-sources" ? (targetConnector ?? null) : null;
    connectorFromAddSource = Boolean(connectorTarget && options?.fromAddSource);
    const nextHash = viewHash(next);
    if (window.location.hash !== nextHash) {
      if (isStandalone()) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${nextHash}`,
        );
      } else {
        window.location.hash = nextHash;
      }
    }
    scrollToTop();
  }
  function navigateBack() {
    if (!backTarget) return;
    const reopenAddSource = backTarget.addSource;
    navigate(backTarget.view);
    if (reopenAddSource) addSourceOpen = true;
  }
  // 手機設定子頁的返回目標：連接器詳情回到資料來源清單；若是從「新增資料來源」選進來，
  // 則回到資料來源並重新打開新增面板。其他子頁回到「更多」。
  const backTarget = $derived<{ view: View; addSource: boolean } | null>(
    view === "data-sources" && connectorTarget
      ? { view: "data-sources", addSource: connectorFromAddSource }
      : isMobileSetting(view)
        ? { view: "more", addSource: false }
        : null,
  );

  // 跟手返回：目前頁面跟著手指往右，底下暫時掛上返回目標的頁面；放開後動畫收尾。
  // 只在手機版版面啟用，較寬的版面維持放開後直接返回。
  const PAGE_SWIPE_SETTLE_MS = 220;
  const mobileLayout = new MediaQuery("(max-width: 767.98px)");
  let pageSwipe = $state<{
    phase: "dragging" | "settling" | "committing";
    offset: number;
  } | null>(null);
  let pageSwipeTimer: ReturnType<typeof setTimeout> | undefined;
  const pageSwipeProgress = $derived(
    pageSwipe ? Math.min(1, pageSwipe.offset / window.innerWidth) : 0,
  );
  function dragPage(distance: number) {
    if (pageSwipe?.phase === "committing") return;
    clearTimeout(pageSwipeTimer);
    pageSwipe = { phase: "dragging", offset: distance };
  }
  function settlePage(commit: boolean) {
    if (pageSwipe?.phase === "committing") return;
    clearTimeout(pageSwipeTimer);
    pageSwipe = {
      phase: commit ? "committing" : "settling",
      offset: commit ? window.innerWidth : 0,
    };
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    pageSwipeTimer = setTimeout(
      () => {
        if (commit) {
          // 底層頁面顯示在頂端；先瞬間捲回頂端，換頁後才不會看到平滑捲動。
          document.getElementById("root")?.scrollTo({ top: 0 });
          navigateBack();
        }
        pageSwipe = null;
      },
      reduceMotion ? 0 : PAGE_SWIPE_SETTLE_MS,
    );
  }
  function toggleMoneyVisibility() {
    moneyState.hidden = !moneyState.hidden;
    localStorage.setItem(
      "taiwan-fin-hub-money-hidden",
      String(moneyState.hidden),
    );
  }
</script>

{#snippet pageHeader(headerView: View, headerConnector: ConnectorId | null)}
  {@const headerSetting = isMobileSetting(headerView)
    ? mobileSettingsLabels[headerView]
    : undefined}
  {@const headerPrimary = primaryViewOf(headerView)}
  {@const headerNav = navItemFor(headerView)}
  {@const headerConnectorTitle =
    headerView === "data-sources" && headerConnector
      ? connectorList.find((source) => source.id === headerConnector)?.title
      : undefined}
  <header
    class="sticky top-0 z-20 border-b border-ink/10 bg-paper/95 backdrop-blur-sm xl:static xl:bg-transparent xl:backdrop-blur-0"
  >
    <div
      class="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-4 sm:px-6 xl:px-8 xl:py-6"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          {#if headerSetting}
            <div class="flex items-center gap-2 md:block">
              <button
                aria-label={headerView === "data-sources" && headerConnector
                  ? connectorFromAddSource
                    ? "返回新增資料來源"
                    : "返回資料來源清單"
                  : "返回更多"}
                class="flex size-10 shrink-0 items-center justify-center rounded-full text-xl text-ink hover:bg-ink/5 md:hidden"
                onclick={navigateBack}>←</button
              >
              <h1
                class="truncate text-2xl font-semibold tracking-tight outline-none xl:text-3xl"
                data-page-title
                tabindex="-1"
              >
                <!-- 手機版連接器詳情以連接器名稱當頁首標題；上一層名稱由返回鍵的標籤表達。 -->
                <span class="md:hidden"
                  >{headerConnectorTitle ?? headerSetting.label}</span
                >
                <span class="hidden md:inline">設定</span>
              </h1>
            </div>
          {:else}
            <h1
              class="truncate text-2xl font-semibold tracking-tight xl:text-3xl"
            >
              <span class="md:hidden"
                >{headerView === "more"
                  ? "更多"
                  : headerPrimary === "overview"
                    ? "資產總覽"
                    : headerPrimary === "activity"
                      ? "所有活動"
                      : (headerNav.pageTitle ?? headerNav.label)}</span
              ><span class="hidden md:inline"
                >{headerNav.pageTitle ?? headerNav.label}</span
              >
            </h1>
          {/if}
          <p class="mt-1 hidden text-sm leading-6 text-subtle md:block">
            {headerSetting?.description ?? headerNav.description}
          </p>
        </div>
        {#if headerView !== "about"}
          <div class="flex shrink-0 items-center gap-2">
            <Button
              class={headerSetting
                ? "hidden rounded-full md:inline-flex"
                : "rounded-full"}
              aria-label={moneyState.hidden ? "顯示金額" : "隱藏金額"}
              onclick={toggleMoneyVisibility}
              size="icon"
              variant="secondary"
              ><Icon
                icon={moneyState.hidden ? Eye : EyeOff}
                size="lg"
              /></Button
            >
          </div>
        {/if}
      </div>
    </div>
  </header>
{/snippet}

<QueryClientProvider client={queryClient}>
  <div
    class="min-h-screen bg-paper text-ink xl:grid xl:grid-cols-[240px_minmax(0,1fr)]"
    use:swipeBack={{
      enabled: isStandalone() && backTarget !== null,
      onBack: mobileLayout.current ? () => settlePage(true) : navigateBack,
      onDrag: mobileLayout.current ? dragPage : undefined,
      onCancel: () => settlePage(false),
    }}
  >
    <aside
      class="hidden border-r border-white/10 bg-inverse px-6 py-7 text-white xl:sticky xl:top-0 xl:flex xl:h-screen xl:flex-col"
    >
      <div class="px-2">
        <h1 class="text-xl font-semibold tracking-normal">不用記帳</h1>
        <p
          class="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-steel/90"
        >
          ALL SET
        </p>
      </div>
      <nav class="mt-6 grid gap-1">
        {#each navItems as item (item.view)}
          {@const NavIcon = item.icon}
          <button
            class={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition ${primaryView === item.view ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white"}`}
            aria-current={primaryView === item.view ? "page" : undefined}
            onclick={() => navigate(item.view)}
          >
            <NavIcon class="size-[22px] shrink-0 stroke-[1.8]" />{item.label}
          </button>
        {/each}
      </nav>
    </aside>

    {#if pageSwipe && backTarget}
      <div
        aria-hidden="true"
        class={`pointer-events-none fixed inset-0 overflow-hidden bg-paper ${pageSwipe.phase === "dragging" ? "" : "transition-transform duration-200 ease-out motion-reduce:transition-none"}`}
        inert
        style:transform={`translateX(${(pageSwipeProgress - 1) * 30}%)`}
      >
        {#if backTarget.addSource}
          {#await getPagePromise("settings") then module}
            {@const Page = module.default as SettingsPageComponent}
            <Page
              {api}
              demoMode={runtime.demoMode}
              mobileView="data-sources"
              {navigate}
              addSourcePreview
            />
          {/await}
        {:else}
          {@render pageHeader(backTarget.view, null)}
          <main class="mx-auto max-w-[1440px] px-4 pb-5 pt-0 sm:px-6">
            {#await getPagePromise("settings") then module}
              {@const Page = module.default as SettingsPageComponent}
              <Page
                {api}
                demoMode={runtime.demoMode}
                connectorTarget={null}
                mobileView={backTarget.view === "more"
                  ? "more"
                  : "data-sources"}
                {navigate}
              />
            {/await}
          </main>
        {/if}
        <div
          class={`absolute inset-0 bg-inverse ${pageSwipe.phase === "dragging" ? "" : "transition-opacity duration-200 ease-out motion-reduce:transition-none"}`}
          style:opacity={(1 - pageSwipeProgress) * 0.12}
        ></div>
      </div>
    {/if}

    <div
      class={`min-w-0 pb-20 ${pageSwipe ? "relative z-10 min-h-dvh bg-paper shadow-[-12px_0_32px_rgba(31,41,51,0.16)]" : ""} ${pageSwipe && pageSwipe.phase !== "dragging" ? "transition-transform duration-200 ease-out motion-reduce:transition-none" : ""}`}
      style:transform={pageSwipe
        ? `translateX(${pageSwipe.offset}px)`
        : undefined}
    >
      <div
        class="no-scrollbar hidden border-b border-ink/10 bg-paper px-4 py-2 md:flex md:gap-1 md:overflow-x-auto xl:hidden"
      >
        {#each navItems as item (item.view)}
          {@const NavIcon = item.icon}
          <button
            class={`flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium ${primaryView === item.view ? "bg-inverse text-white" : "text-subtle hover:bg-ink/5"}`}
            onclick={() => navigate(item.view)}
            ><NavIcon class="size-4" />{item.label}</button
          >
        {/each}
      </div>
      {@render pageHeader(view, connectorTarget)}

      <main
        class="mx-auto max-w-[1440px] px-4 pb-5 pt-0 sm:px-6 md:py-5 xl:px-8 xl:py-6"
      >
        {#if view === "overview"}
          <Overview {api} {navigate} />
        {:else}
          {#await pagePromise}
            <EmptyState title="載入頁面中" body="正在準備內容。" />
          {:then module}
            {#if module}
              {#if view === "assets"}
                {@const Page =
                  module.default as typeof import("@/features/assets/AssetsPage.svelte").default}
                <Page {api} />
              {:else if view === "activity"}
                {@const Page =
                  module.default as typeof import("@/features/activity/ActivityPage.svelte").default}
                <Page {api} />
              {:else}
                {@const Page =
                  module.default as typeof import("@/features/settings/SettingsPage.svelte").default}
                <Page
                  {api}
                  demoMode={runtime.demoMode}
                  {connectorTarget}
                  mobileView={view === "more"
                    ? "more"
                    : isMobileSetting(view)
                      ? view
                      : undefined}
                  {navigate}
                  bind:addSourceOpen
                />
              {/if}
            {/if}
          {:catch error}
            {@const recovered = recoverFromChunkLoadError(error)}
            {#if recovered}
              <EmptyState title="偵測到新版本" body="正在重新整理頁面。" />
            {:else}
              <section class="min-w-0 py-16" role="alert" aria-live="assertive">
                <h2 class="text-base font-semibold tracking-tight">
                  頁面載入失敗
                </h2>
                <p class="mt-2 text-caption text-subtle">請再試一次。</p>
                <Button class="mt-5" variant="outline" onclick={retryPage}
                  >重新載入</Button
                >
              </section>
            {/if}
          {/await}
        {/if}
      </main>
      <footer
        class="mx-auto hidden max-w-[1440px] border-t border-ink/8 px-4 py-6 sm:px-6 md:block xl:px-8"
      >
        <p class="text-xs leading-relaxed text-ink/35">
          <strong class="font-medium text-ink/50">免責聲明：</strong
          >本程式僅供個人研究與自用，未與臺灣集中保管結算所、財政部、金融監督管理委員會、各銀行或任何金融機構合作，亦未獲前述機構授權或背書。本程式所呈現的資料以您自行提供之憑證取得，作者不保證資料的即時性、正確性與完整性，亦不對因使用本程式所產生的任何直接或間接損失負責。請勿將本程式用於任何商業用途。
        </p>
      </footer>
    </div>

    <nav
      aria-label="主要導覽"
      class="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 gap-1 border-t border-ink/10 bg-inverse px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 text-white shadow-[0_-8px_28px_rgba(31,41,51,0.12)] md:hidden"
    >
      {#each mobilePrimaryViews as mobileView (mobileView)}
        {@const item = navItems.find(
          (candidate) => candidate.view === mobileView,
        )!}{@const NavIcon = item.icon}
        <button
          class={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition ${primaryView === item.view ? "bg-white/10 text-white" : "text-white/65"}`}
          onclick={() => navigate(item.view)}
          ><NavIcon class="size-5" />{item.shortLabel}</button
        >
      {/each}
      <button
        class={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition ${view === "more" || !mobilePrimaryViews.includes(primaryView) ? "bg-white/10 text-white" : "text-white/65"}`}
        onclick={() => navigate("more")}><Ellipsis class="size-5" />更多</button
      >
    </nav>
  </div>
</QueryClientProvider>
