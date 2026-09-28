<script lang="ts">
  import { onDestroy } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  let { api, disabled = false }: { api: ApiClient; disabled?: boolean } =
    $props();
  type Challenge = {
    kind: "delivery" | "code" | "authenticator" | "ready";
    expiresAt: string;
    options?: { index: number; channel: string; recipientMask: string }[];
  };
  let challenge = $state<Challenge | null>(null);
  let selected = $state("0"),
    otp = $state(""),
    message = $state(""),
    busy = $state(false),
    expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const qc = useQueryClient();
  onDestroy(() => clearTimeout(timer));
  async function run(action: "start" | "send" | "sync") {
    if (busy || disabled) return;
    busy = true;
    message = "";
    try {
      if (action === "sync") {
        const code = otp;
        otp = "";
        const result = await api.post<{ warnings?: string[] }>(
          "/api/connectors/firstrade/sync",
          challenge?.kind === "ready" ? {} : { otp: code },
        );
        challenge = null;
        clearTimeout(timer);
        message = [
          "同步完成，已更新美股持倉與美元現金。",
          ...(result.warnings ?? []),
        ].join(" ");
        await qc.invalidateQueries();
      } else {
        challenge = await api.post<Challenge>(
          "/api/connectors/firstrade/challenge",
          action === "start" ? {} : { recipientIndex: Number(selected) },
        );
        selected = String(challenge.options?.[0]?.index ?? 0);
        expired = false;
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            expired = true;
            otp = "";
          },
          Math.max(0, Date.parse(challenge.expiresAt) - Date.now()),
        );
      }
    } catch (error) {
      challenge = null;
      otp = "";
      clearTimeout(timer);
      message =
        error instanceof Error
          ? error.message
          : "Firstrade 操作失敗，請重新開始。";
      void qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      void qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings("firstrade"),
      });
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="mt-4 rounded-xl border border-border p-4"
  aria-label="Firstrade 驗證"
>
  <h3 class="font-semibold">Firstrade 驗證與同步</h3>
  <p class="my-2 text-sm text-muted-foreground">
    先儲存帳密，再開始驗證。每次同步需人工完成一次性驗證；只讀取美股、ETF
    與美元現金。股票與 ETF 合併列於股票類別。期權與其他商品目前不支援。
  </p>
  {#if !challenge || expired}
    {#if expired}<p class="my-2 text-sm text-coral">
        驗證已逾時，請重新開始。
      </p>{/if}
    <Button disabled={disabled || busy} onclick={() => run("start")}
      >{busy ? "登入中…" : "開始驗證"}</Button
    >
  {:else if challenge.kind === "delivery"}
    <label class="my-3 grid gap-2"
      >接收驗證碼方式
      <Select bind:value={selected} disabled={busy || disabled}>
        {#each challenge.options ?? [] as option (option.index)}<option
            value={String(option.index)}
            >{option.channel === "sms" ? "簡訊" : "Email"}
            {option.recipientMask}</option
          >{/each}
      </Select>
    </label>
    <Button disabled={disabled || busy} onclick={() => run("send")}
      >{busy ? "寄送中…" : "寄送驗證碼"}</Button
    >
  {:else}
    {#if challenge.kind !== "ready"}
      <label class="my-3 grid gap-2"
        >{challenge.kind === "authenticator"
          ? "驗證器 App 六位驗證碼"
          : "收到的六位驗證碼"}
        <Input
          bind:value={otp}
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={6}
          disabled={busy || disabled}
        />
      </label>
    {/if}
    <Button
      disabled={disabled ||
        busy ||
        (challenge.kind !== "ready" && !/^\d{6}$/.test(otp))}
      onclick={() => run("sync")}
      >{busy ? "驗證與同步中…" : "驗證並同步"}</Button
    >
  {/if}
  <p class="mt-3 text-xs text-muted-foreground">
    資產總額採持倉明細市值加現金；券商餘額頁可能使用不同報價來源。
  </p>
  {#if message}<p class="mt-3 text-sm" role="status">{message}</p>{/if}
</section>
