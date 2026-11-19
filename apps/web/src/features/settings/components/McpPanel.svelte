<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import {
    ChevronRight,
    CircleCheckBig,
    ExternalLink,
    Info,
    LoaderCircle,
    RefreshCw,
    TriangleAlert,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Icon from "@/shared/ui/Icon.svelte";
  import TabsList from "@/shared/ui/TabsList.svelte";
  import TabsTrigger from "@/shared/ui/TabsTrigger.svelte";
  import CopyField from "./CopyField.svelte";
  import {
    MANAGED_OAUTH_SCREENSHOT,
    MCP_EXAMPLE_PROMPTS,
    MCP_TROUBLESHOOTING,
    managedOauthSteps,
    mcpClientGuides,
    mcpDocsUrl,
    mcpEndpoint,
    type McpClientGuide,
    type McpLink,
    type McpScreenshot,
  } from "../model/mcp";
  import { mcpAuthStatusQuery } from "../model/mcp-auth";

  let { demoMode }: { demoMode: boolean } = $props();

  const repository = __BUILD_INFO__.repository;
  const endpoint = mcpEndpoint(window.location.origin);
  const guides = mcpClientGuides(endpoint);
  const authStatus = createQuery(() =>
    mcpAuthStatusQuery(endpoint, window.location.hostname, !demoMode),
  );
  const enableSteps = managedOauthSteps(window.location.host);
  const authView = $derived.by<{
    icon: Component;
    tone: string;
    title: string;
    description: string;
    showSetup: boolean;
  }>(() => {
    if (authStatus.isPending)
      return {
        icon: LoaderCircle,
        tone: "text-muted-foreground animate-spin",
        title: "正在檢查 MCP 是否可以使用…",
        description: "以尚未登入的 AI 助理身分測試 MCP 端點。",
        showSetup: false,
      };
    const status = authStatus.data ?? {
      kind: "unknown" as const,
      detail: "檢查失敗",
    };
    switch (status.kind) {
      case "ready":
        return {
          icon: CircleCheckBig,
          tone: "text-moss",
          title: "MCP 可以使用",
          description:
            "Cloudflare Access 已開啟 Managed OAuth，AI 助理連線時會開啟瀏覽器完成登入。連接 ChatGPT 等網頁型助理時，仍需把它的回呼網址加入 Allowed redirect URIs。",
          showSetup: false,
        };
      case "not_enabled":
        return {
          icon: TriangleAlert,
          tone: "text-amber-700",
          title: "MCP 尚未啟用",
          description:
            "AI 助理無法使用網頁版的登入轉址，需要在 Cloudflare Access 開啟 Managed OAuth，改用 OAuth 登入。",
          showSetup: true,
        };
      case "not_protected":
        return {
          icon: TriangleAlert,
          tone: "text-coral",
          title: "MCP 無法使用",
          description:
            "MCP 端點收到未經 Cloudflare Access 驗證的請求。請先確認 Access Application 的網址涵蓋此網域，再依下列步驟開啟 Managed OAuth。",
          showSetup: true,
        };
      case "local":
        return {
          icon: Info,
          tone: "text-steel",
          title: "本機開發模式",
          description:
            "本機略過 Cloudflare Access，MCP 客戶端可直接連線，不需要 Managed OAuth。",
          showSetup: false,
        };
      default:
        return {
          icon: TriangleAlert,
          tone: "text-coral",
          title: "無法確認 MCP 是否可以使用",
          description: `檢查時發生問題（${status.detail}）。若尚未設定，請依下列步驟開啟 Managed OAuth。`,
          showSetup: true,
        };
    }
  });
  let activeId = $state<McpClientGuide["id"]>("codex");
  const activeGuide = $derived(
    guides.find((guide) => guide.id === activeId) ?? guides[0]!,
  );
</script>

{#snippet externalLink(link: McpLink)}
  <a
    class="inline-flex w-fit min-h-8 items-center gap-1 text-sm font-semibold text-steel transition hover:text-steel/80"
    href={link.href}
    target="_blank"
    rel="noreferrer">{link.label}<Icon icon={ExternalLink} size="sm" /></a
  >
{/snippet}

{#snippet screenshot(shot: McpScreenshot)}
  <!-- 收合時不渲染圖片，搭配 lazy 只在展開後才下載。 -->
  <details class="group min-w-0">
    <summary
      class="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-steel transition hover:text-steel/80 [&::-webkit-details-marker]:hidden"
      ><Icon
        icon={ChevronRight}
        size="sm"
        class="transition-transform group-open:rotate-90"
      />{shot.label}</summary
    >
    <a
      class="mt-2 block"
      href={shot.src}
      target="_blank"
      rel="noreferrer"
      title="開啟原尺寸圖片"
      ><img
        src={shot.src}
        alt={shot.alt}
        width={shot.width}
        height={shot.height}
        loading="lazy"
        decoding="async"
        class="h-auto w-full rounded-lg border border-border"
      /></a
    >
  </details>
{/snippet}

{#if demoMode}
  <Card>
    <CardContent class="grid gap-2 pt-5 sm:p-6">
      <h3 class="text-lg font-bold">Demo 模式不開放 MCP</h3>
      <p class="text-sm leading-relaxed text-muted-foreground">
        Demo 部署不提供 MCP 端點。部署自己的版本並開啟 Cloudflare Access
        後，即可讓 AI 助理連線。
      </p>
      {@render externalLink({
        label: "查看 AI 助理連線說明",
        href: mcpDocsUrl(repository),
      })}
    </CardContent>
  </Card>
{:else}
  <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,690px)_minmax(0,1fr)]">
    <div class="grid min-w-0 content-start gap-4">
      <Card as="section">
        <CardContent class="grid gap-4 pt-5 sm:p-6">
          <div
            class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3"
            role="status"
            aria-live="polite"
          >
            <span
              class="flex size-10 items-center justify-center rounded-xl bg-muted"
              ><Icon
                icon={authView.icon}
                size="lg"
                class={authView.tone}
              /></span
            >
            <div class="grid min-w-0 gap-1">
              <h3 class="text-lg font-bold">{authView.title}</h3>
              <p class="text-sm leading-relaxed text-muted-foreground">
                {authView.description}
              </p>
            </div>
          </div>
          {#if authView.showSetup}
            <div class="grid gap-3 rounded-lg bg-muted p-4">
              <p class="text-sm font-bold">如何啟用（一次性）</p>
              <ol class="grid gap-2.5">
                {#each enableSteps as step, index (index)}
                  <li
                    class="grid grid-cols-[auto_minmax(0,1fr)] gap-2.5 text-sm leading-relaxed"
                  >
                    <span
                      aria-hidden="true"
                      class="flex size-6 items-center justify-center rounded-full bg-steel/10 text-xs font-bold text-steel"
                      >{index + 1}</span
                    >
                    <div class="grid min-w-0 gap-1">
                      <span
                        class="text-muted-foreground [overflow-wrap:anywhere]"
                        >{step.text}</span
                      >
                      {#if step.link}
                        {@render externalLink(step.link)}
                      {/if}
                    </div>
                  </li>
                {/each}
              </ol>
              {@render screenshot(MANAGED_OAUTH_SCREENSHOT)}
              <p class="text-sm text-muted-foreground">
                完成後回到此頁會自動重新檢查。
              </p>
            </div>
          {/if}
          {#if !authStatus.isPending}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                class="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-steel transition hover:text-steel/80 disabled:opacity-60"
                disabled={authStatus.isFetching}
                onclick={() => authStatus.refetch()}
                ><Icon
                  icon={RefreshCw}
                  size="sm"
                  class={authStatus.isFetching ? "animate-spin" : ""}
                />{authStatus.isFetching ? "檢查中…" : "重新檢查"}</button
              >
            </div>
          {/if}
        </CardContent>
      </Card>

      <Card as="section">
        <CardContent class="grid gap-4 pt-5 sm:p-6">
          <h3 class="text-lg font-bold">連接 AI 助理</h3>
          <TabsList
            aria-label="AI 助理"
            class="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4"
          >
            {#each guides as guide (guide.id)}
              <TabsTrigger
                id={`mcp-tab-${guide.id}`}
                aria-controls="mcp-guide-panel"
                class="min-h-9 min-w-0 px-2"
                active={activeId === guide.id}
                onclick={() => (activeId = guide.id)}>{guide.label}</TabsTrigger
              >
            {/each}
          </TabsList>
          <div
            id="mcp-guide-panel"
            role="tabpanel"
            aria-labelledby={`mcp-tab-${activeGuide.id}`}
            class="grid min-w-0 gap-4"
          >
            {#if activeGuide.prompt}
              {@const prompt = activeGuide.prompt}
              <div class="grid min-w-0 gap-3">
                <p class="text-sm leading-relaxed text-muted-foreground">
                  把這段話貼給 {prompt.audience}，它會自己完成新增、登入與確認：
                </p>
                <CopyField label="設定提示詞" text={prompt.text} mono={false} />
                <div class="grid gap-1">
                  <p class="text-sm font-semibold">過程中需要你：</p>
                  <ul
                    class="grid list-disc gap-1 pl-5 text-sm leading-relaxed text-muted-foreground"
                  >
                    {#each prompt.userActions as action (action)}
                      <li>{action}</li>
                    {/each}
                  </ul>
                </div>
                {#each prompt.screenshots ?? [] as shot (shot.label)}
                  {@render screenshot(shot)}
                {/each}
              </div>
            {/if}
            {#if activeGuide.steps}
              {#if activeGuide.stepsTitle}
                <p
                  class="border-t border-border pt-4 text-sm font-semibold leading-relaxed"
                >
                  {activeGuide.stepsTitle}
                </p>
              {/if}
              <ol class="grid min-w-0 gap-5">
                {#each activeGuide.steps as step, index (step.title)}
                  <li class="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                    <span
                      aria-hidden="true"
                      class="flex size-7 items-center justify-center rounded-full bg-steel/10 text-sm font-bold text-steel"
                      >{index + 1}</span
                    >
                    <div class="grid min-w-0 gap-2">
                      <p class="font-semibold leading-7">{step.title}</p>
                      {#if step.detail}
                        <p
                          class="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                        >
                          {step.detail}
                        </p>
                      {/if}
                      {#if step.link}
                        {@render externalLink(step.link)}
                      {/if}
                      {#if step.copy}
                        <CopyField
                          label={step.copy.label}
                          text={step.copy.text}
                          mono={step.copy.mono ?? true}
                        />
                      {/if}
                      {#each step.screenshots ?? [] as shot (shot.label)}
                        {@render screenshot(shot)}
                      {/each}
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
            {#if activeGuide.note}
              <p class="text-sm leading-relaxed text-muted-foreground">
                {activeGuide.note}
              </p>
            {/if}
            <details class="group min-w-0 border-t border-border pt-4">
              <summary
                class="flex min-h-8 cursor-pointer list-none items-center gap-1 text-sm font-semibold [&::-webkit-details-marker]:hidden"
                ><Icon
                  icon={ChevronRight}
                  size="sm"
                  class="text-muted-foreground transition-transform group-open:rotate-90"
                />連線失敗時</summary
              >
              <dl class="mt-2 grid gap-3 text-sm leading-relaxed">
                {#each MCP_TROUBLESHOOTING as item (item.problem)}
                  <div>
                    <dt class="font-semibold [overflow-wrap:anywhere]">
                      {item.problem}
                    </dt>
                    <dd class="text-muted-foreground">{item.fix}</dd>
                  </div>
                {/each}
              </dl>
            </details>
          </div>
        </CardContent>
      </Card>
    </div>

    <div class="grid min-w-0 content-start gap-4">
      <Card as="section">
        <CardContent class="grid gap-3 pt-5 sm:p-6">
          <div>
            <h3 class="text-base font-bold">接上後可以這樣問</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              AI 助理會自行挑選工具，不需要說明端點或步驟。
            </p>
          </div>
          {#each MCP_EXAMPLE_PROMPTS as prompt (prompt)}
            <CopyField label="範例問題" text={prompt} mono={false} />
          {/each}
        </CardContent>
      </Card>

      <Card as="section">
        <CardContent class="grid gap-3 pt-5 sm:p-6">
          <h3 class="text-base font-bold">隱私與權限</h3>
          <ul
            class="grid list-disc gap-2 pl-5 text-sm leading-relaxed text-muted-foreground"
          >
            <li>
              權限與網頁版登入相同，可以查詢、編輯資料與觸發同步。修改資料前，工具會要求
              AI 助理先向你確認，實際是否詢問由各 AI 助理的設定決定。
            </li>
            <li>查到的資料會送到你使用的 AI 服務，請只連接你信任的服務。</li>
            <li>
              要撤銷授權，可在 Authorize Client 頁面下方撤銷已授權的用戶端；從
              Access policy 移除帳號後，最遲 15 分鐘失效。
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  </div>
{/if}
