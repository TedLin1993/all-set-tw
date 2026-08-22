import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";
import { connectorFields } from "@/data/connectors/definitions";
import type { ConnectorField, SyncJobRow } from "@/data/connectors/types";
import { ApiRequestError, type ApiClient } from "@/shared/api/client";
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

function renderCathayPanel(
  post: ReturnType<typeof vi.fn>,
  connectorSettings: Record<string, unknown> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const api = {
    get: vi.fn((path: string) => {
      if (path === "/api/sync-jobs")
        return Promise.resolve([
          syncJob({
            id: "cathaybk:all",
            connectorId: "cathaybk",
          }),
        ]);
      if (path === "/api/connectors/cathaybk/settings")
        return Promise.resolve(connectorSettings);
      return Promise.resolve({});
    }),
    post,
  } as unknown as ApiClient;
  const result = render(
    ConnectorPanel,
    {
      props: {
        api,
        connectorId: "cathaybk",
        demoMode: false,
        title: "國泰世華銀行",
        fields: connectorFields.cathaybk as ConnectorField[],
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
      queryKey: ["sync-reports", "latest"],
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

  it("guides Cathay through channel selection and OTP verification", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_CHANNEL_REQUIRED",
          "需要選擇驗證方式。",
          400,
        ),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_EMAIL_OTP_REQUIRED",
          "Email 驗證碼已寄出。",
          400,
        ),
      )
      .mockResolvedValueOnce({ success: true });
    const { getByLabelText, getByRole, findByText, getByPlaceholderText } =
      renderCathayPanel(post);
    const progress = getByLabelText("國泰世華連線進度");

    expect(
      within(progress).getByText("確認網銀帳密").parentElement,
    ).toHaveClass("bg-steel/[0.07]");

    await fireEvent.click(getByRole("button", { name: "同步" }));
    expect(await findByText("需要額外驗證")).toBeInTheDocument();
    expect(
      within(progress).getByText("驗證這台裝置").parentElement,
    ).toHaveClass("bg-steel/[0.07]");
    expect(getByRole("button", { name: "使用 Email" })).toBeInTheDocument();
    expect(getByRole("button", { name: "使用簡訊" })).toBeInTheDocument();

    await fireEvent.click(getByRole("button", { name: "使用 Email" }));
    expect(await findByText("Email 驗證碼已寄出")).toBeInTheDocument();
    expect(post).toHaveBeenNthCalledWith(2, "/api/connectors/cathaybk/sync", {
      otpChannel: "email",
    });

    await fireEvent.input(getByPlaceholderText("例如 310307（不含英文前綴）"), {
      target: { value: "123456" },
    });
    await fireEvent.click(getByRole("button", { name: "驗證並完成首次同步" }));
    expect(post).toHaveBeenNthCalledWith(3, "/api/connectors/cathaybk/sync", {
      otp: "123456",
      otpChannel: "email",
    });
    await waitFor(() =>
      expect(
        within(progress).getByText("完成首次同步").parentElement,
      ).toHaveClass("bg-moss/[0.07]"),
    );
  });

  it("restores a pending Cathay Email verification after remount", async () => {
    const { findByText, getByPlaceholderText } = renderCathayPanel(vi.fn(), {
      connectorId: "cathaybk",
      configured: true,
      credentialsComplete: true,
      sessionAvailable: false,
      verificationPending: true,
      verificationChannel: "email",
      verificationExpiresAt: "2099-08-22T08:08:00.000Z",
    });

    expect(await findByText("Email 驗證碼已寄出")).toBeInTheDocument();
    expect(
      getByPlaceholderText("例如 310307（不含英文前綴）"),
    ).toBeInTheDocument();
  });

  it("keeps the Cathay Email step open after an incorrect OTP", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_INVALID",
          "國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。",
          400,
        ),
      );
    const {
      findByPlaceholderText,
      findByText,
      getByPlaceholderText,
      getByRole,
    } = renderCathayPanel(post, {
      connectorId: "cathaybk",
      configured: true,
      credentialsComplete: true,
      sessionAvailable: false,
      verificationPending: true,
      verificationChannel: "email",
      verificationExpiresAt: "2099-08-22T08:08:00.000Z",
    });

    const input = await findByPlaceholderText("例如 310307（不含英文前綴）");
    await fireEvent.input(input, { target: { value: "123456" } });
    await fireEvent.click(getByRole("button", { name: "驗證並完成首次同步" }));

    expect(
      await findByText("國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。"),
    ).toBeInTheDocument();
    expect(
      getByPlaceholderText("例如 310307（不含英文前綴）"),
    ).toBeInTheDocument();
    expect(getByRole("button", { name: "重新寄送 Email" })).toBeInTheDocument();
  });

  it("closes an expired Cathay verification flow and restarts it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T08:00:00.000Z"));
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_SESSION_EXPIRED",
          "驗證工作階段已逾時，請重新同步。",
          400,
        ),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CATHAY_OTP_CHANNEL_REQUIRED",
          "需要選擇驗證方式。",
          400,
        ),
      );

    try {
      const { getByRole, getByText } = renderCathayPanel(post, {
        connectorId: "cathaybk",
        configured: true,
        credentialsComplete: true,
        sessionAvailable: false,
        verificationPending: true,
        verificationChannel: "email",
        verificationExpiresAt: "2026-08-22T08:02:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(getByText("請於 2:00 內完成驗證")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(getByText("驗證工作階段已逾時")).toBeInTheDocument();

      await fireEvent.click(getByRole("button", { name: "重新開始驗證" }));
      await vi.advanceTimersByTimeAsync(0);

      expect(post).toHaveBeenCalledTimes(2);
      expect(getByText("需要額外驗證")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
