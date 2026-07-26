import { QueryClient } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

if (typeof window !== "undefined") {
  window.addEventListener("taiwan-fin-hub:sync-jobs-completed", () => {
    void queryClient.invalidateQueries();
  });
}