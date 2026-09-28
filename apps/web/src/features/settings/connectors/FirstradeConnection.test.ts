import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { expect, it, vi } from "vitest";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import FirstradeConnection from "./FirstradeConnection.svelte";

it("requires an explicit delivery choice and clears the OTP after syncing", async () => {
  const post = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "delivery",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      options: [{ index: 0, channel: "sms", recipientMask: "***1234" }],
    })
    .mockResolvedValueOnce({
      kind: "code",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    })
    .mockResolvedValueOnce({
      success: true,
      warnings: ["餘額與持倉使用不同報價來源"],
    });
  const api = { post } as unknown as ApiClient;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = render(
    FirstradeConnection,
    { props: { api } },
    { wrapper: QueryClientProvider, wrapperProps: { client: qc } },
  );
  await fireEvent.click(ui.getByRole("button", { name: "開始驗證" }));
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "寄送驗證碼" })).toBeTruthy(),
  );
  expect(post).toHaveBeenCalledTimes(1);
  await fireEvent.click(ui.getByRole("button", { name: "寄送驗證碼" }));
  await waitFor(() =>
    expect(ui.getByLabelText("收到的六位驗證碼")).toBeTruthy(),
  );
  await fireEvent.input(ui.getByLabelText("收到的六位驗證碼"), {
    target: { value: "123456" },
  });
  await fireEvent.click(ui.getByRole("button", { name: "驗證並同步" }));
  await waitFor(() =>
    expect(ui.getByRole("status").textContent).toContain("同步完成"),
  );
  expect(ui.getByRole("status").textContent).toContain("不同報價來源");
  expect(post.mock.calls).toEqual([
    ["/api/connectors/firstrade/challenge", {}],
    ["/api/connectors/firstrade/challenge", { recipientIndex: 0 }],
    ["/api/connectors/firstrade/sync", { otp: "123456" }],
  ]);
  expect(ui.queryByLabelText("收到的六位驗證碼")).toBeNull();
  ui.unmount();
  qc.clear();
});
it("does not attempt another login automatically after a rejection", async () => {
  const post = vi.fn().mockRejectedValue(new Error("驗證未完成，請重新開始"));
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.syncJobs, [
    { connectorId: "firstrade", lastStatus: "success" },
  ]);
  const ui = render(
    FirstradeConnection,
    { props: { api: { post } as unknown as ApiClient } },
    { wrapper: QueryClientProvider, wrapperProps: { client: qc } },
  );
  await fireEvent.click(ui.getByRole("button", { name: "開始驗證" }));
  await waitFor(() =>
    expect(ui.getByRole("status").textContent).toContain("驗證未完成"),
  );
  expect(post).toHaveBeenCalledTimes(1);
  expect(qc.getQueryState(queryKeys.syncJobs)?.isInvalidated).toBe(true);
  ui.unmount();
  qc.clear();
});
