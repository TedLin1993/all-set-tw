import { render } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";
import type { SyncJobRow } from "@/data/connectors/types";
import type { ApiClient } from "@/shared/api/client";
import { formatDateTime } from "@/shared/format/financial";
import SourceCard from "./SourceCard.svelte";

function renderSourceCard(job: SyncJobRow) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api = {
    get: vi.fn().mockResolvedValue({ configured: true }),
  } as unknown as ApiClient;

  return render(
    SourceCard,
    {
      props: {
        api,
        id: "sinopac",
        title: "永豐行動銀行",
        description: "信用卡帳務、近期帳單與消費",
        selected: false,
        onConfigure: vi.fn(),
        jobs: [job],
        compact: true,
        compactCard: true,
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: { client: queryClient },
    },
  );
}

describe("SourceCard", () => {
  it("keeps the last successful sync time visible after a later failure", () => {
    const lastSuccessAt = "2026-08-20T22:00:00.000Z";
    const { getByText } = renderSourceCard({
      id: "sinopac:all",
      connectorId: "sinopac",
      configured: true,
      scope: "all",
      enabled: true,
      intervalMinutes: 1440,
      nextRunAt: "2026-08-22T02:00:00.000Z",
      scheduleMode: "inherit",
      preferredTime: "02:00",
      preferredWeekday: 1,
      lockedUntil: null,
      lockedBy: null,
      lockTrigger: null,
      lockScope: null,
      lastRunAt: "2026-08-21T22:00:00.000Z",
      lastSuccessAt,
      lastStatus: "failed",
      lastError: "同步失敗",
      updatedAt: "2026-08-21T22:00:00.000Z",
      running: false,
    });

    expect(
      getByText(`上次成功 ${formatDateTime(lastSuccessAt)}`),
    ).toBeInTheDocument();
    expect(getByText("需要處理")).toBeInTheDocument();
  });
});
