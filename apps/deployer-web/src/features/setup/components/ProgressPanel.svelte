<script lang="ts">
  import {
    nextAction,
    phaseState,
    phasesFor,
    publicSiteUrl,
  } from "../model/progress";
  import type { DeployJob, Installation } from "@/data/types";

  let {
    installation,
    job,
    busy = false,
    onRetry,
  }: {
    installation: Installation;
    job: DeployJob;
    busy?: boolean;
    onRetry: () => void;
  } = $props();

  const terminal = $derived(
    job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "awaiting_reauth" ||
      job.status === "awaiting_release",
  );
  const action = $derived(nextAction(job.errorCode));
  const siteUrl = $derived(
    publicSiteUrl(installation.workerName, job.createdResources),
  );
  const phases = $derived(phasesFor(job.kind));
</script>

<section
  class="flex flex-col gap-4 rounded-xl border border-ink/10 bg-white p-4"
>
  <header class="flex flex-col gap-1">
    <h2 class="text-lg font-semibold">
      {job.kind === "update" ? "更新進度" : "安裝進度"}
    </h2>
    <p class="text-sm leading-6 text-ink/70">
      目標版本 {job.targetVersion}。重新整理不會重複建立資源。
    </p>
  </header>

  <ol class="flex flex-col gap-2">
    {#each phases as phase}
      {@const state = phaseState(phase.id, job, job.kind)}
      <li
        class="flex min-h-11 items-center justify-between rounded-md border border-ink/10 px-3 py-2 text-sm"
      >
        <span class="font-medium">{phase.label}</span>
        <span class="text-ink/70">
          {#if state === "done"}完成{:else if state === "active"}進行中{:else if state === "error"}失敗{:else}等待{/if}
        </span>
      </li>
    {/each}
  </ol>

  {#if job.status === "succeeded" && siteUrl}
    <a class="text-sm text-steel underline" href={siteUrl}>開啟私人網站</a>
  {:else if action}
    <p class="text-sm leading-6 text-ink/80">{action}</p>
  {/if}

  {#if job.status === "awaiting_reauth"}
    <a
      class="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white"
      href="/api/auth/login"
    >
      重新授權
    </a>
  {:else if terminal && job.status !== "succeeded"}
    <button
      type="button"
      class="min-h-11 rounded-md border border-ink/20 px-4 text-sm font-medium disabled:opacity-50"
      disabled={busy}
      onclick={onRetry}
    >
      重試
    </button>
  {/if}
</section>
