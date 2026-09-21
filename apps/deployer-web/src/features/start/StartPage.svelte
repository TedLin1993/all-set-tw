<script lang="ts">
  import {
    oauthLoginPath,
    requestedPermissions,
    trustPoints,
  } from "./model/trust-copy";
  import type { AuthStatus } from "@/data/types";

  let { status }: { status: AuthStatus } = $props();
</script>

<section class="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10">
  <header class="flex flex-col gap-3">
    <p class="text-sm font-medium text-steel">不用記帳 · 部署網站</p>
    <h1 class="text-3xl font-semibold tracking-tight">
      用瀏覽器把私人財務網站裝到你的 Cloudflare
    </h1>
    <p class="text-base leading-7 text-ink/80">
      不需要 GitHub
      帳號，也不必下載安裝器。金融資料會建立在你自己的帳戶。目前可完成授權、預檢、首次安裝與網頁更新編排；正式
      OAuth 登入驗證與 R2 版本發布尚未完成，不能當成已上線的一鍵部署。
    </p>
  </header>

  <ul class="flex flex-col gap-4">
    {#each trustPoints as point}
      <li class="rounded-xl border border-ink/10 bg-white p-4 shadow-xs">
        <h2 class="font-medium">{point.title}</h2>
        <p class="mt-2 text-sm leading-6 text-ink/75">{point.body}</p>
      </li>
    {/each}
  </ul>

  <div class="rounded-xl border border-ink/10 bg-white p-4">
    <h2 class="font-medium">此次授權會請求的權限</h2>
    <ul class="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-ink/75">
      {#each requestedPermissions as permission}
        <li>{permission}</li>
      {/each}
    </ul>
  </div>

  {#if status.oauthConfigured}
    <a
      href={oauthLoginPath}
      class="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white"
    >
      使用 Cloudflare 繼續
    </a>
  {:else}
    <p class="rounded-md bg-ink/5 px-4 py-3 text-sm leading-6">
      維護者尚未設定 OAuth client，因此無法開始授權。一般使用者暫時請繼續使用
      README 的 GitHub 部署方式。
    </p>
  {/if}
</section>
