import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BrowserBankConnectionHelp from "./BrowserBankConnectionHelp.svelte";

describe("BrowserBankConnectionHelp", () => {
  it("shows Taishin session guidance and uses the server-provided digit count", async () => {
    const onVerify = vi.fn();
    const onRefresh = vi.fn();
    const { getByRole, getByText, getByPlaceholderText } = render(
      BrowserBankConnectionHelp,
      {
        props: {
          bankName: "台新",
          captchaImage: "data:image/jpeg;base64,AQID",
          captcha: "",
          digitCount: 4,
          preparing: false,
          verifying: false,
          onVerify,
          onRefresh,
        },
      },
    );

    expect(
      getByText(/可能會讓新的自動登入取代當下正在使用的網銀 session/),
    ).toBeInTheDocument();
    expect(getByPlaceholderText("4 位數字驗證碼")).toHaveAttribute(
      "maxlength",
      "4",
    );

    await fireEvent.click(getByRole("button", { name: "驗證並同步" }));
    expect(onVerify).toHaveBeenCalledOnce();
  });

  it("describes the O-Bank App API alphanumeric CAPTCHA flow", () => {
    const { getByText } = render(BrowserBankConnectionHelp, {
      props: {
        bankName: "王道",
        captchaImage: "",
        captcha: "",
        digitCount: 4,
        captchaKind: "alphanumeric",
        preparing: false,
        verifying: false,
        onVerify: vi.fn(),
        onRefresh: vi.fn(),
      },
    });

    expect(getByText(/透過王道 App API/)).toBeInTheDocument();
    expect(getByText(/改用人工輸入/)).toBeInTheDocument();
    expect(
      getByText(/手動與排程同步.*接管其他登入中的裝置/),
    ).toBeInTheDocument();
  });

  it("disables CAPTCHA actions while a sync is running", () => {
    const { getByRole } = render(BrowserBankConnectionHelp, {
      props: {
        bankName: "王道",
        captchaImage: "data:image/png;base64,AQID",
        captcha: "",
        digitCount: 4,
        captchaKind: "alphanumeric",
        preparing: false,
        verifying: false,
        syncing: true,
        onVerify: vi.fn(),
        onRefresh: vi.fn(),
      },
    });

    expect(getByRole("button", { name: "驗證並同步" })).toBeDisabled();
    expect(getByRole("button", { name: "換一張" })).toBeDisabled();
  });
});
