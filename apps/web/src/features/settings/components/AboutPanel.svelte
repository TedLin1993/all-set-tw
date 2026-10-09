<script lang="ts">
  import { Check, Copy } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Icon from "@/shared/ui/Icon.svelte";
  import Textarea from "@/shared/ui/Textarea.svelte";

  const buildInfo = __BUILD_INFO__;
  const buildTime = `${buildInfo.builtAt.slice(0, 19).replace("T", " ")} UTC`;
  const details = [
    {
      label: "Commit",
      value: buildInfo.commit.slice(0, 7),
      title: buildInfo.commit,
    },
    { label: "分支", value: buildInfo.branch, title: buildInfo.branch },
    { label: "組建時間", value: buildTime, title: buildTime },
  ];
  const diagnostics = [
    "不用記帳 ALL SET",
    `上游專案: ${buildInfo.repository}`,
    `Commit: ${buildInfo.commit}`,
    `分支: ${buildInfo.branch}`,
    `組建時間: ${buildTime}`,
  ].join("\n");
  let copyStatus = $state<"idle" | "copying" | "copied" | "error">("idle");

  async function copyDiagnostics() {
    copyStatus = "copying";
    try {
      await navigator.clipboard.writeText(diagnostics);
      copyStatus = "copied";
    } catch {
      copyStatus = "error";
    }
  }
</script>

<Card>
  <CardContent class="pt-5 sm:p-6">
    <dl class="divide-y divide-border">
      {#each details as detail (detail.label)}
        <div
          class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-4 py-5 first:pt-0 sm:gap-6"
        >
          <dt class="font-semibold text-muted-foreground">{detail.label}</dt>
          <dd
            class="min-w-0 text-right font-mono text-sm font-medium [overflow-wrap:anywhere] sm:text-base"
            title={detail.title}
          >
            {detail.value}
          </dd>
        </div>
      {/each}
    </dl>
    <div
      class="flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <p class="text-sm leading-6 text-muted-foreground">
        提出支援問題時，請複製診斷資訊，讓維護者能確認你正在執行的組建版本。
      </p>
      <Button
        variant="outline"
        size="touch"
        disabled={copyStatus === "copying"}
        onclick={copyDiagnostics}
      >
        <Icon icon={copyStatus === "copied" ? Check : Copy} />
        {copyStatus === "copied"
          ? "已複製"
          : copyStatus === "copying"
            ? "複製中…"
            : "複製診斷資訊"}
      </Button>
    </div>
    <p
      role="status"
      aria-live="polite"
      class={`text-sm ${copyStatus === "error" ? "mt-3 text-coral" : copyStatus === "copied" ? "mt-3 text-moss" : ""}`}
    >
      {#if copyStatus === "error"}
        無法自動複製，請選取下方診斷資訊手動複製。
      {:else if copyStatus === "copied"}
        診斷資訊已複製到剪貼簿。
      {/if}
    </p>
    {#if copyStatus === "error"}
      <Textarea
        aria-label="診斷資訊"
        value={diagnostics}
        readonly
        rows={7}
        class="mt-3 font-mono"
      />
    {/if}
  </CardContent>
</Card>
