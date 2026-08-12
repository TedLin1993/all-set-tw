import { fireEvent, render } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";
import { connectorFields } from "@/data/connectors/definitions";
import type { ConnectorField, SyncJobRow } from "@/data/connectors/types";
import type { ApiClient } from "@/shared/api/client";
import ConnectorPanel from "./ConnectorPanel.svelte";

function syncJob(overrides: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "einvoice:all",
    connectorId: "einvoice",
    configured: true,
    scope: "all",
    enabled: true,
    intervalMinutes: 1440,
    nextRunAt: "2026-08-13T00:00:00.000Z",
    scheduleMode: "inherit",
    preferredTime: "08:00",
    preferredWeekday: 1,
    lockedUntil: null,
    lockedBy: null,
    lockTrigger: null,
    lockScope: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    lastError: null,
    updatedAt: "2026-08-12T00:00:00.000Z",
    running: false,
    ...overrides,
  };
}

function renderEinvoicePanel(syncJobs: SyncJobRow[][]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  let syncJobRequest = 0;
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs")
        return Promise.resolve(
          syncJobs[Math.min(syncJobRequest++, syncJobs.length - 1)] ?? [],
        );
      return Promise.resolve({});
    }),
    post: vi.fn().mockResolvedValue({
      success: true,
      connectorId: "einvoice",
      scope: "all",
      status: "queued",
      runId: "run-1",
    }),
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "einvoice",
        demoMode: false,
        title: "電子發票",
        fields: connectorFields.einvoice as ConnectorField[],
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
  return { ...result, api, queryClient };
}

describe("ConnectorPanel", () => {
  it("shows a fallback when a failed sync has an empty stored error", async () => {
    const { findByText } = renderEinvoicePanel([
      [syncJob({ lastStatus: "failed", lastError: "" })],
    ]);

    expect(
      await findByText("上次同步失敗，但未取得錯誤原因。"),
    ).toBeInTheDocument();
  });

  it("polls an e-invoice run and refreshes financial data only after success", async () => {
    vi.useFakeTimers();
    const running = syncJob({ running: true });
    const completed = syncJob({
      lastRunAt: "2026-08-12T00:01:00.000Z",
      lastSuccessAt: "2026-08-12T00:01:00.000Z",
      lastStatus: "success",
    });
    const { api, getByRole, queryByText, queryClient } = renderEinvoicePanel([
      [],
      [running],
      [completed],
    ]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    expect(queryByText("同步品項明細")).not.toBeInTheDocument();
    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(api.post).toHaveBeenCalledWith("/api/connectors/einvoice/sync", {});
    expect(getByRole("button", { name: "已排入同步" })).toBeDisabled();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(
      (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === "/api/sync-jobs",
      ),
    ).toHaveLength(4);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
    expect(getByRole("button", { name: "已排入同步" })).toBeEnabled();
    vi.useRealTimers();
  });

  it("stops polling without refreshing data when an e-invoice run fails", async () => {
    vi.useFakeTimers();
    const { api, getByRole, queryClient } = renderEinvoicePanel([
      [],
      [syncJob({ running: true })],
      [
        syncJob({
          lastRunAt: "2026-08-12T00:01:00.000Z",
          lastStatus: "failed",
          lastError: "連線失敗",
        }),
      ],
    ]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getByRole("button", { name: "已排入同步" })).toBeEnabled();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["summary"],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
    vi.useRealTimers();
  });

  it("cancels e-invoice polling when the panel is destroyed", async () => {
    vi.useFakeTimers();
    const { api, getByRole, unmount } = renderEinvoicePanel([
      [],
      [syncJob({ running: true })],
    ]);

    await fireEvent.click(getByRole("button", { name: "同步" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledOnce();
    const syncJobRequestsBeforeUnmount = (
      api.get as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([path]) => path === "/api/sync-jobs").length;

    unmount();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(
      (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => path === "/api/sync-jobs",
      ),
    ).toHaveLength(syncJobRequestsBeforeUnmount);
    vi.useRealTimers();
  });
});
