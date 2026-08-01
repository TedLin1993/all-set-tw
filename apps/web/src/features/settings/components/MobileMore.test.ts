import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { connectorDefinitions } from "@/data/connectors/definitions";
import type { ApiClient } from "@/shared/api/client";
import MobileMore from "./MobileMore.svelte";

describe("MobileMore", () => {
  it("shows unconfigured connectors without counting them as healthy or actionable", () => {
    const api = {} as ApiClient;
    const { getAllByText, getByText } = render(MobileMore, {
      props: {
        api,
        demoMode: false,
        jobs: [],
        rules: [],
        bank: { accounts: [], transactions: [] },
        navigate: vi.fn(),
      },
    });

    const connectorCount = connectorDefinitions.length;
    expect(getByText("0 / 0 已設定來源正常")).toBeInTheDocument();
    expect(
      getByText(new RegExp(`${connectorCount} 個\\s*›`)),
    ).toBeInTheDocument();
    expect(getByText("同步與通知")).toBeInTheDocument();
    expect(getByText("中國信託銀行")).toBeInTheDocument();
    expect(getAllByText("未設定")).toHaveLength(connectorCount);
  });
});
