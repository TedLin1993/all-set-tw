<script lang="ts">
  import { onMount } from "svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import {
    BellRing,
    Check,
    Send,
    Smartphone,
    TriangleAlert,
  } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Badge from "@/shared/ui/Badge.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { notificationConfigQuery } from "@/data/notifications/queries";
  import type {
    NotificationPreferences,
    PushSubscriptionRegistration,
  } from "@/data/notifications/types";
  import { queryKeys } from "@/shared/api/query-keys";
  import {
    getPushSubscription,
    pushSupport,
    registerPushServiceWorker,
    subscribeToPush,
    subscriptionInput,
    type PushSupport,
  } from "@/shared/pwa/push";

  let {
    api,
    demoMode,
    variant = "default",
  }: {
    api: ApiClient;
    demoMode: boolean;
    variant?: "default" | "desktop";
  } = $props();

  const queryClient = useQueryClient();
  const config = createQuery(notificationConfigQuery(() => api));
  const defaults: NotificationPreferences = {
    success: false,
    failed: true,
    needsUserAction: true,
  };
  let support = $state<PushSupport>({ supported: false });
  let subscription = $state<PushSubscription | null>(null);
  let busy = $state(false);
  let preferenceBusy = $state(false);
  let feedback = $state<{ tone: "success" | "error"; text: string } | null>(
    null,
  );
  const preferences = $derived($config.data?.preferences ?? defaults);
  const serverEnabled = $derived($config.data?.enabled ?? false);
  const subscribed = $derived(Boolean(subscription));

  onMount(() => {
    support = pushSupport();
    if (support.supported) void hydrateSubscription();
  });

  async function hydrateSubscription() {
    try {
      const notificationConfig = await queryClient.ensureQueryData(
        notificationConfigQuery(() => api),
      );
      if (!notificationConfig.publicKey) return;
      await registerPushServiceWorker();
      const current = await getPushSubscription(notificationConfig.publicKey);
      if (!current) {
        const storedId = localStorage.getItem("taiwan-fin-hub-push-id");
        if (storedId) await removeStoredSubscription(storedId);
      }
      subscription = current;
    } catch {
      subscription = null;
    }
  }

  async function removeStoredSubscription(id: string) {
    await api.delete(`/api/notifications/subscriptions/${id}`);
    if (localStorage.getItem("taiwan-fin-hub-push-id") === id) {
      localStorage.removeItem("taiwan-fin-hub-push-id");
    }
  }

  async function enablePush() {
    if (!serverEnabled || !$config.data?.publicKey) return;
    busy = true;
    feedback = null;
    try {
      const previousId = localStorage.getItem("taiwan-fin-hub-push-id");
      await registerPushServiceWorker();
      const current = await subscribeToPush($config.data.publicKey);
      const registered = await api.post<PushSubscriptionRegistration>(
        "/api/notifications/subscriptions",
        subscriptionInput(current),
      );
      if (previousId && previousId !== registered.id) {
        try {
          await removeStoredSubscription(previousId);
        } catch (error) {
          console.warn("[pwa] stale push subscription cleanup failed", error);
        }
      }
      localStorage.setItem("taiwan-fin-hub-push-id", registered.id);
      subscription = current;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
      });
      feedback = { tone: "success", text: "這個裝置已開啟同步推播。" };
    } catch (error) {
      feedback = {
        tone: "error",
        text:
          error instanceof Error ? error.message : "推播開啟失敗，請稍後再試。",
      };
    } finally {
      busy = false;
    }
  }

  async function disablePush() {
    busy = true;
    feedback = null;
    try {
      const id = localStorage.getItem("taiwan-fin-hub-push-id");
      if (id) await removeStoredSubscription(id);
      await subscription?.unsubscribe();
      subscription = null;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
      });
      feedback = { tone: "success", text: "這個裝置已關閉同步推播。" };
    } catch (error) {
      feedback = {
        tone: "error",
        text:
          error instanceof Error ? error.message : "推播關閉失敗，請稍後再試。",
      };
    } finally {
      busy = false;
    }
  }

  async function savePreferences(
    key: keyof NotificationPreferences,
    value: boolean,
  ) {
    preferenceBusy = true;
    feedback = null;
    const next = { ...preferences, [key]: value };
    try {
      await api.put("/api/notifications/preferences", next);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
      });
    } catch (error) {
      feedback = {
        tone: "error",
        text: error instanceof Error ? error.message : "通知偏好儲存失敗。",
      };
    } finally {
      preferenceBusy = false;
    }
  }

  async function sendTest() {
    busy = true;
    feedback = null;
    try {
      const result = await api.post<{
        delivered: number;
        failed: number;
        attempted: number;
        removed: number;
      }>("/api/notifications/test");
      const text =
        result.delivered > 0
          ? "測試通知已送出，請查看你的裝置。"
          : result.attempted === 0
            ? "目前沒有已登錄的推播裝置。"
            : result.removed === result.attempted
              ? "推播訂閱已失效，請重新開啟此裝置的推播。"
              : result.failed > 0
                ? "推播裝置已登錄，但測試通知送出失敗；請重新開啟此裝置的推播後再試。"
                : "測試通知未送達，請稍後再試。";
      feedback = {
        tone: result.delivered > 0 ? "success" : "error",
        text,
      };
    } catch (error) {
      feedback = {
        tone: "error",
        text: error instanceof Error ? error.message : "測試通知送出失敗。",
      };
    } finally {
      busy = false;
    }
  }

  function toggleButton(
    label: string,
    description: string,
    key: keyof NotificationPreferences,
  ) {
    const checked = preferences[key];
    return { label, description, key, checked };
  }
</script>

<Card
  as="section"
  class={`overflow-hidden ${variant === "desktop" ? "border-border shadow-xs" : ""}`}
>
  <div
    class={`flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4 ${variant === "desktop" ? "border-border bg-card text-foreground" : "border-white/10 bg-steel text-white"}`}
  >
    <div class="flex items-start gap-3">
      <span
        class={`flex size-10 shrink-0 items-center justify-center rounded-xl ${variant === "desktop" ? "bg-steel/10 text-steel" : "bg-white/15 text-white"}`}
      >
        <BellRing class="size-5" />
      </span>
      <div>
        <h2 class="font-semibold">
          {variant === "desktop" ? "通知設定" : "同步推播"}
        </h2>
        <p
          class={`mt-1 text-sm ${variant === "desktop" ? "text-muted-foreground" : "text-white/65"}`}
        >
          {variant === "desktop"
            ? "選擇需要收到推播的同步事件。"
            : "排程同步完成、失敗或需要驗證時提醒你。"}
        </p>
      </div>
    </div>
    {#if subscribed}
      <Badge
        variant="success"
        class={variant === "desktop"
          ? "text-sm"
          : "bg-white/15 text-white text-sm"}>已啟用</Badge
      >
    {:else}
      <span
        class={`rounded-full px-3 py-1.5 text-sm ${variant === "desktop" ? "bg-muted text-muted-foreground" : "bg-white/10 text-white/70"}`}
      >
        尚未啟用
      </span>
    {/if}
  </div>

  <div class="grid gap-5 p-5">
    {#if demoMode}
      <div
        class="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-4"
      >
        <TriangleAlert class="mt-0.5 size-5 shrink-0 text-steel" />
        <p class="text-sm leading-relaxed text-muted-foreground">
          Demo 模式僅供檢視，無法登記推播裝置。
        </p>
      </div>
    {:else if !serverEnabled}
      <div
        class="flex items-start gap-3 rounded-lg border border-coral/20 bg-coral/5 p-4"
      >
        <TriangleAlert class="mt-0.5 size-5 shrink-0 text-coral" />
        <p class="text-sm leading-relaxed text-coral">
          Worker 尚未設定 VAPID 推播金鑰。完成部署設定後，這裡就能開啟通知。
        </p>
      </div>
    {:else if support.reason === "ios-home-screen"}
      <div
        class="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-4"
      >
        <Smartphone class="mt-0.5 size-5 shrink-0 text-steel" />
        <p class="text-sm leading-relaxed text-muted-foreground">
          請先將 Taiwan Fin Hub 加入 iPhone／iPad
          主畫面，再從主畫面開啟並啟用推播。
        </p>
      </div>
    {:else if !support.supported}
      <div
        class="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-4"
      >
        <TriangleAlert class="mt-0.5 size-5 shrink-0 text-steel" />
        <p class="text-sm leading-relaxed text-muted-foreground">
          目前的瀏覽器不支援 Web Push，請改用最新版 Chrome、Edge、Firefox 或
          Safari。
        </p>
      </div>
    {:else}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="font-medium">
            {subscribed ? "這個裝置會收到同步狀態" : "在背景同步完成時收到提醒"}
          </p>
          <p class="mt-1 text-sm text-muted-foreground">
            可在多個瀏覽器或裝置各自開啟；通知不會包含金額或交易內容。
          </p>
        </div>
        {#if subscribed}
          <div class="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={sendTest}
            >
              <Send class="size-4" />{busy ? "送出中…" : "測試通知"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={disablePush}
            >
              關閉此裝置
            </Button>
          </div>
        {:else}
          <Button variant="primary" disabled={busy} onclick={enablePush}>
            <BellRing class="size-4" />{busy ? "開啟中…" : "開啟推播"}
          </Button>
        {/if}
      </div>

      {#if subscribed}
        <div class="grid gap-2 border-t border-border pt-4">
          <p
            class="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            通知內容
          </p>
          {#each [toggleButton("同步失敗", "連接器暫時無法完成同步", "failed"), toggleButton("需要重新驗證", "需要 OTP、CAPTCHA 或重新登入", "needsUserAction"), toggleButton("同步完成", "排程同步成功完成（預設關閉）", "success")] as item (item.key)}
            <button
              type="button"
              role="switch"
              aria-checked={item.checked}
              disabled={preferenceBusy}
              class="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-border px-3 text-left transition-colors hover:bg-muted/45 disabled:opacity-60"
              onclick={() => savePreferences(item.key, !item.checked)}
            >
              <span>
                <span class="block text-sm font-medium">{item.label}</span>
                <span class="mt-0.5 block text-sm text-muted-foreground"
                  >{item.description}</span
                >
              </span>
              <span
                class={`relative block h-6 w-11 shrink-0 rounded-full transition-colors ${item.checked ? "bg-primary" : "bg-input"}`}
              >
                <span
                  class={`absolute top-0.5 block size-5 rounded-full bg-background shadow-sm transition-transform ${item.checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
                ></span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if feedback}
      <p
        class={`border-t border-border pt-3 text-sm font-medium ${feedback.tone === "success" ? "text-moss" : "text-coral"}`}
      >
        {#if feedback.tone === "success"}<Check
            class="mr-1 inline size-4"
          />{/if}{feedback.text}
      </p>
    {/if}
  </div>
</Card>
