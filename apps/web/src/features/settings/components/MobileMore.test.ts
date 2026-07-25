import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
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

    expect(getByText("6 / 6 來源正常")).toBeInTheDocument();
    expect(getByText(/6 個\s*›/)).toBeInTheDocument();
    expect(getByText("同步與通知")).toBeInTheDocument();
    expect(getByText("台新銀行")).toBeInTheDocument();
  });
});
