import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { connectorDefinitions } from "@/data/connectors/definitions";
import type { ApiClient } from "@/shared/api/client";
import MobileMore from "./MobileMore.svelte";

describe("MobileMore", () => {
  it("uses the shared connector definitions in its health summary", () => {
    const api = {} as ApiClient;
    const { getByText } = render(MobileMore, {
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
    expect(
      getByText(`${connectorCount} / ${connectorCount} 來源正常`),
    ).toBeInTheDocument();
    expect(
      getByText(new RegExp(`${connectorCount} 個\\s*›`)),
    ).toBeInTheDocument();
    expect(getByText("同步與通知")).toBeInTheDocument();
    expect(getByText("中國信託銀行")).toBeInTheDocument();
  });
});
