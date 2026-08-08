<script lang="ts">
  import { onMount } from "svelte";
  import { Ellipsis, Eye, EyeOff } from "@lucide/svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import Activity from "@/features/activity/ActivityPage.svelte";
  import Assets from "@/features/assets/AssetsPage.svelte";
  import Investments from "@/features/assets/Investments.svelte";
  import ManualAssets from "@/features/assets/ManualAssets.svelte";
  import Invoices from "@/features/invoices/InvoicesPage.svelte";
  import Overview from "@/features/overview/OverviewPage.svelte";
  import SettingsView from "@/features/settings/SettingsPage.svelte";
  import { createApiClient } from "@/shared/api/client";
  import { swipeBack } from "@/shared/actions/swipe-back";
  import { moneyState } from "@/shared/state/money-visibility.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Icon from "@/shared/ui/Icon.svelte";
  import {
    detailLabels,
    mobilePrimaryViews,
    mobileSettingsLabels,
    navItems,
  } from "./navigation-config";
  import { parseViewHash, viewHash } from "./navigation";
  import { queryClient } from "./query-client";
  import type {
    DetailView,
    MobileSettingsView,
    PrimaryView,
    RuntimeInfo,
    View,
  } from "./types";
  import "../styles.css";

  const api = createApiClient();
  let view = $state<View>("overview");
  let runtime = $state<RuntimeInfo>({ demoMode: false });
  const isDetail = (v: View): v is DetailView => Object.hasOwn(detailLabels, v);
  const isMobileSetting = (v: View): v is MobileSettingsView =>
    Object.hasOwn(mobileSettingsLabels, v);
  const primaryView = $derived(
    view === "more" || isMobileSetting(view)
      ? "settings"
      : isDetail(view)
        ? "assets"
        : (view as PrimaryView),
  );
  const currentView = $derived(
    navItems.find((item) => item.view === primaryView) ?? navItems[0]!,
  );
  const detail = $derived(isDetail(view) ? detailLabels[view] : undefined);
  const mobileSetting = $derived(
    isMobileSetting(view) ? mobileSettingsLabels[view] : undefined,
  );

  const isStandalone = () =>
    document.documentElement.classList.contains("is-standalone");
  function scrollToTop() {
    const options: ScrollToOptions = { top: 0, behavior: "smooth" };
    if (isStandalone()) document.getElementById("root")?.scrollTo(options);
    else window.scrollTo(options);
  }

  onMount(() => {
    const routeView = parseViewHash(window.location.hash);
    if (routeView) view = routeView;
    else
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
  function navigate(next: View) {
    view = next;
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
    if (isDetail(view)) navigate("assets");
    else if (isMobileSetting(view)) navigate("more");
  }
  function toggleMoneyVisibility() {
    moneyState.hidden = !moneyState.hidden;
    localStorage.setItem(
      "taiwan-fin-hub-money-hidden",
      String(moneyState.hidden),
    );
  }
</script>

<QueryClientProvider client={queryClient}>
  <div
    class="min-h-screen bg-paper text-ink xl:grid xl:grid-cols-[240px_minmax(0,1fr)]"
    use:swipeBack={{
      enabled: isStandalone() && (isDetail(view) || isMobileSetting(view)),
      onBack: navigateBack,
    }}
  >
    <aside
      class="hidden border-r border-white/10 bg-ink px-6 py-7 text-white xl:sticky xl:top-0 xl:flex xl:h-screen xl:flex-col"
    >
      <div class="px-2">
        <h1 class="text-xl font-semibold tracking-normal">Taiwan Fin Hub</h1>
        <p
          class="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-steel/90"
        >
          Wealth OS
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

    <div class="min-w-0 pb-20">
      <div
        class="no-scrollbar hidden border-b border-ink/10 bg-white px-4 py-2 md:flex md:gap-1 md:overflow-x-auto xl:hidden"
      >
        {#each navItems as item (item.view)}
          {@const NavIcon = item.icon}
          <button
            class={`flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium ${primaryView === item.view ? "bg-ink text-white" : "text-ink/60 hover:bg-ink/5"}`}
            onclick={() => navigate(item.view)}
            ><NavIcon class="size-4" />{item.label}</button
          >
        {/each}
      </div>
      <header
        class="sticky top-0 z-20 border-b border-ink/10 bg-white/95 backdrop-blur-sm xl:static xl:bg-transparent xl:backdrop-blur-0"
      >
        <div
          class="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-4 sm:px-6 xl:px-8 xl:py-6"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              {#if mobileSetting}
                <div class="flex items-center gap-2 md:block">
                  <button
                    aria-label="返回更多"
                    class="flex size-10 shrink-0 items-center justify-center rounded-full text-xl text-ink hover:bg-ink/5 md:hidden"
                    onclick={() => navigate("more")}>←</button
                  >
                  <h1
                    class="truncate text-2xl font-semibold tracking-tight xl:text-3xl"
                  >
                    <span class="md:hidden">{mobileSetting.label}</span>
                    <span class="hidden md:inline">設定</span>
                  </h1>
                </div>
              {:else}
                {#if detail}<button
                    class="mb-1 inline-flex items-center gap-1 text-xs font-medium text-steel"
                    onclick={() => navigate("assets")}>← 返回資產</button
                  >{/if}
                <h1
                  class="truncate text-2xl font-semibold tracking-tight xl:text-3xl"
                >
                  <span class="md:hidden"
                    >{view === "more"
                      ? "更多"
                      : primaryView === "overview"
                        ? "資產總覽"
                        : primaryView === "activity"
                          ? "所有活動"
                          : currentView.label}</span
                  ><span class="hidden md:inline"
                    >{detail?.label ?? currentView.label}</span
                  >
                </h1>
              {/if}
              <p class="mt-1 hidden text-sm text-ink/55 md:block">
                {detail?.description ??
                  mobileSetting?.description ??
                  currentView.description}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Button
                class={mobileSetting
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
          </div>
        </div>
      </header>

      <main
        class="mx-auto max-w-[1440px] px-4 pb-5 pt-0 sm:px-6 md:py-5 xl:px-8 xl:py-6"
      >
        {#if view === "overview"}<Overview {api} {navigate} />
        {:else if view === "assets"}<Assets {api} {navigate} />
        {:else if view === "activity"}<Activity {api} {navigate} />
        {:else if view === "invoices"}<Invoices {api} />
        {:else if view === "investments"}<Investments {api} />
        {:else if view === "manual-assets"}<ManualAssets {api} />
        {:else}<SettingsView
            {api}
            demoMode={runtime.demoMode}
            mobileView={view === "more"
              ? "more"
              : isMobileSetting(view)
                ? view
                : undefined}
            {navigate}
          />{/if}
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
      class="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 gap-1 border-t border-ink/10 bg-ink px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 text-white shadow-[0_-8px_28px_rgba(31,41,51,0.12)] md:hidden"
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
