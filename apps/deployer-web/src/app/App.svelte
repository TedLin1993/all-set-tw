<script lang="ts">
  import { onMount } from "svelte";
  import { fetchAuthStatus, fetchSession } from "@/data/deployer";
  import type { AuthSession, AuthStatus } from "@/data/types";
  import { ApiRequestError } from "@/shared/api/client";
  import StartPage from "@/features/start/StartPage.svelte";
  import SetupPage from "@/features/setup/SetupPage.svelte";
  import "../styles.css";

  let status = $state<AuthStatus | null>(null);
  let session = $state<AuthSession | null>(null);
  let loadError = $state("");

  function currentHash() {
    return window.location.hash.replace(/^#/, "") || "start";
  }

  let view = $state(currentHash());

  onMount(() => {
    const onHash = () => {
      view = currentHash();
    };
    window.addEventListener("hashchange", onHash);
    void (async () => {
      try {
        status = await fetchAuthStatus();
        try {
          session = await fetchSession();
          if (view === "start") {
            window.location.hash = "setup";
            view = "setup";
          }
        } catch (error) {
          if (!(error instanceof ApiRequestError && error.status === 401)) {
            throw error;
          }
        }
      } catch (error) {
        loadError =
          error instanceof Error ? error.message : "無法載入部署網站。";
      }
    })();
    return () => window.removeEventListener("hashchange", onHash);
  });
</script>

<main>
  {#if loadError}
    <p class="px-4 py-10 text-sm">{loadError}</p>
  {:else if !status}
    <p class="px-4 py-10 text-sm">載入中…</p>
  {:else if view === "setup" && session}
    <SetupPage {session} />
  {:else}
    <StartPage {status} />
  {/if}
</main>
