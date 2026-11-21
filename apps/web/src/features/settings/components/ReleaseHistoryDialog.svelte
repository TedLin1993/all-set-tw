<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    ExternalLink,
    NotebookText,
    X,
  } from "@lucide/svelte";
  import { Dialog } from "bits-ui";
  import { currentVersion, type Release } from "@/data/releases/queries";
  import { cn } from "@/shared/utils/cn";
  import { cloudflareUpdateTarget } from "../model/release-update";

  let {
    history,
    variant = "menu",
    class: className = "",
  }: {
    history: Release[];
    variant?: "sidebar" | "menu";
    class?: string;
  } = $props();

  const newVersion = $derived(
    history[0].version === currentVersion ? undefined : history[0].version,
  );
  const updateMethod = __BUILD_INFO__.updateMethod;
  const triggerStyles = {
    sidebar:
      "w-full border border-transparent text-white/85 hover:bg-white/5 focus-visible:outline-white data-[update-available]:border-cyan-200/25 data-[update-available]:bg-cyan-200/10 data-[update-available]:text-white data-[update-available]:hover:bg-cyan-200/15",
    menu: "text-ink hover:bg-ink/5 focus-visible:outline-steel data-[update-available]:bg-accent data-[update-available]:text-accent-foreground data-[update-available]:hover:bg-accent/80",
  };
</script>

<Dialog.Root>
  <Dialog.Trigger
    data-update-available={newVersion ? "" : undefined}
    class={cn(
      "group flex min-h-11 max-w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
      triggerStyles[variant],
      className,
    )}
  >
    <span
      class={cn(
        "grid shrink-0 place-items-center",
        variant === "sidebar"
          ? "size-[22px] group-data-[update-available]:text-cyan-100"
          : "size-9 rounded-lg bg-steel/10 text-steel group-data-[update-available]:text-accent-foreground",
      )}
    >
      <NotebookText aria-hidden="true" class="size-5 stroke-[1.8]" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block text-sm leading-5 font-semibold">更新紀錄</span>
      <span
        class={cn(
          "block truncate text-xs leading-4 tabular-nums",
          variant === "sidebar"
            ? "text-white/65 group-data-[update-available]:text-cyan-100"
            : "text-subtle group-data-[update-available]:text-accent-foreground",
        )}
      >
        {newVersion ? `新版 v${newVersion}` : `目前版本 v${currentVersion}`}
      </span>
    </span>
    <ChevronRight aria-hidden="true" class="size-4 shrink-0 opacity-60" />
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[70] bg-inverse/45" />
    <Dialog.Content
      class="fixed inset-x-0 bottom-0 z-[70] flex h-[90dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-card text-card-foreground shadow-2xl outline-none md:inset-auto md:top-1/2 md:left-1/2 md:h-auto md:max-h-[80dvh] md:w-[calc(100%-3rem)] md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
    >
      <header
        class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 md:px-5"
      >
        <div>
          <Dialog.Title level={2} class="text-lg font-semibold">
            更新紀錄
          </Dialog.Title>
          <p class="mt-0.5 text-xs text-muted-foreground">
            目前版本 v{currentVersion}
          </p>
        </div>
        <Dialog.Close
          aria-label="關閉更新紀錄"
          class="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" class="size-5" />
        </Dialog.Close>
      </header>
      {#if newVersion && updateMethod === "cloudflare"}
        {@const target = cloudflareUpdateTarget(
          window.location.hostname,
          __BUILD_INFO__,
        )}
        <section
          aria-label="更新版本"
          class="shrink-0 border-b border-border bg-muted/50 px-4 py-3 md:px-5"
        >
          <p class="text-sm font-semibold">可更新至 v{newVersion}</p>
          <p class="mt-1 text-sm leading-6 text-muted-foreground">
            {#if target.page === "workers"}
              選擇你的 Worker，開啟 Deployments → View build history。
            {/if}
            {#if target.page === "details"}
              在 Build Details 按
            {:else}
              在最近一次正式分支的 build 右側點 ⋯，選擇
            {/if}
            <strong class="font-semibold text-foreground">Retry build</strong>。
            建置成功後，重新整理此頁。
          </p>
          <a
            href={target.url}
            target="_blank"
            rel="noreferrer"
            class="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >{target.page === "details"
              ? "前往 Cloudflare 更新"
              : "查看 Cloudflare 建置紀錄"}<ExternalLink
              aria-hidden="true"
              class="size-4"
            /></a
          >
          <details class="mt-2 text-sm text-muted-foreground">
            <summary class="cursor-pointer">找不到 Retry build？</summary>
            <p class="mt-1 leading-6">
              Cloudflare 保留建置紀錄 90 天，首次一鍵部署也可能無法重試。可到
              Deployments → View build history
              選其他正式分支的建置。若沒有可重試的紀錄，在部署用 GitHub
              repository 的正式分支提交一筆小修改（例如在 README
              加一行文字），即可觸發新建置。
            </p>
          </details>
        </section>
      {:else if newVersion && updateMethod === "repository"}
        <p
          class="shrink-0 border-b border-border bg-muted/50 px-4 py-3 text-sm leading-6 text-muted-foreground md:px-5"
        >
          此部署由 GitHub repository 管理版本，請從 GitHub 更新。
        </p>
      {/if}
      <ol
        role="list"
        class="min-h-0 divide-y divide-border overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5"
      >
        {#each history as release, index (release.version)}
          <li class="py-1">
            <details class="group" open={index === 0}>
              <summary
                class="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-2 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden"
              >
                <span class="font-semibold">v{release.version}</span>
                {#if release.version === currentVersion}
                  <span
                    class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                    >目前版本</span
                  >
                {:else if release.version === newVersion}
                  <span
                    class="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground"
                    >新版</span
                  >
                {/if}
                <time
                  class="ml-auto text-sm tabular-nums text-muted-foreground"
                  datetime={release.date}>{release.date}</time
                >
                <ChevronDown
                  aria-hidden="true"
                  class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <ul
                class="list-disc space-y-1 pr-2 pb-3 pl-7 text-sm leading-6 wrap-break-word"
              >
                {#each release.changes as change, changeIndex (changeIndex)}
                  <li>{change}</li>
                {/each}
              </ul>
            </details>
          </li>
        {/each}
      </ol>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
