<script lang="ts">
  import { onMount } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { Mail, ShieldCheck, Smartphone } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import { ApiRequestError, type ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";

  let {
    api,
    pending = false,
    channel = null,
    expiresAt = null,
    disabled = false,
    busy = $bindable(false),
    onSuccess,
  }: {
    api: ApiClient;
    pending?: boolean;
    channel?: "app" | "email" | "sms" | null;
    expiresAt?: string | null;
    disabled?: boolean;
    busy?: boolean;
    onSuccess: () => void;
  } = $props();
  const qc = useQueryClient();
  let otp = $state("");
  let error = $state("");
  let expired = $state(false);
  let now = $state(Date.now());
  const seconds = $derived(
    expiresAt
      ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
      : 0,
  );
  const active = $derived(pending && seconds > 0);
  const countdown = $derived(
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
  );

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const verify = createMutation(() => ({
    onMutate: () => {
      busy = true;
      error = "";
    },
    mutationFn: (options: {
      verification?: "check" | "email" | "restart";
      otp?: string;
    }) => {
      if (disabled) throw new Error("目前無法進行登入驗證。");
      return api.post("/api/connectors/ctbc/sync", options);
    },
    onSuccess: () => {
      otp = "";
      error = "";
      expired = false;
      onSuccess();
    },
    onError: (failure) => {
      otp = "";
      if (
        failure instanceof ApiRequestError &&
        (failure.code === "CTBC_APP_APPROVAL_REQUIRED" ||
          failure.code === "CTBC_EMAIL_OTP_REQUIRED")
      ) {
        expired = false;
        return;
      }
      expired =
        failure instanceof ApiRequestError &&
        failure.code === "CTBC_VERIFICATION_EXPIRED";
      error =
        failure instanceof Error ? failure.message : "驗證未完成，請重新操作。";
    },
    onSettled: () => {
      busy = false;
      qc.invalidateQueries({ queryKey: queryKeys.connectorSettings("ctbc") });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
  }));
</script>

{#if expiresAt || expired || error}
  <section
    aria-label="中信兩階段登入驗證"
    class="mt-3 rounded-xl border border-steel/20 bg-steel/[0.055] p-4"
  >
    <p class="flex items-center gap-2 text-sm font-semibold">
      <ShieldCheck class="size-4" />兩階段登入驗證
    </p>
    {#if active}
      <p class="mt-2 text-sm text-muted-foreground">
        {channel === "email"
          ? "請輸入中國信託寄送的 Email 四位數驗證碼。"
          : "請開啟已綁定的中國信託 App，確認這次登入後回到此處繼續同步。"}
      </p>
      <p class="mt-1 text-sm text-steel" role="status">剩餘時間：{countdown}</p>
      {#if channel === "email"}
        <form
          class="mt-3 flex flex-wrap items-end gap-3"
          onsubmit={(event) => {
            event.preventDefault();
            if (!disabled && !busy && /^\d{4}$/.test(otp.trim()))
              verify.mutate({ otp: otp.trim() });
          }}
        >
          <label class="grid gap-1 text-sm">
            Email 驗證碼
            <Input
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={4}
              pattern={"[0-9]{4}"}
              placeholder="四位數字"
              bind:value={otp}
              disabled={disabled || busy}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={disabled || busy || !/^\d{4}$/.test(otp.trim())}
          >
            <ShieldCheck class="size-4" />驗證並同步
          </Button>
        </form>
      {:else}
        <div class="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={disabled || busy}
            onclick={() => verify.mutate({ verification: "check" })}
          >
            <Smartphone class="size-4" />我已確認，繼續同步
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onclick={() => verify.mutate({ verification: "email" })}
          >
            <Mail class="size-4" />改用 Email 驗證
          </Button>
        </div>
      {/if}
    {:else if expiresAt || expired}
      <p class="mt-2 text-sm text-muted-foreground">
        這次驗證已過期，請重新開始。
      </p>
      <Button
        class="mt-3"
        size="sm"
        disabled={disabled || busy}
        onclick={() => verify.mutate({ verification: "restart" })}
      >
        重新開始驗證
      </Button>
    {/if}
    {#if busy}<p class="mt-2 text-sm" role="status">
        正在確認登入並接續同步…
      </p>{/if}
    {#if error}<p class="mt-2 text-sm text-coral" role="alert">{error}</p>{/if}
    <p class="mt-3 text-xs text-muted-foreground">
      核准適用於這次登入，目前尚未支援網銀的「信任此瀏覽器」；下次同步仍可能需要再次核准。驗證完成前，自動同步會暫停。
    </p>
  </section>
{/if}
