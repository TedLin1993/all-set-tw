import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTdccClient,
  ensureTdccSession,
  parseTdccConfig,
  TdccVerificationRequiredError,
} from "../../src/sources/tdcc/protocol";

function mockTdcc(login: Record<string, string>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const endpoint = String(input).split("/rest/")[1] ?? "";
    const sendType = (
      JSON.parse(String(init?.body ?? "{}")) as {
        requestBody?: { sendType?: string };
      }
    ).requestBody?.sendType;
    calls.push(sendType ? `${endpoint}:${sendType}` : endpoint);
    const body: Record<string, unknown> =
      endpoint === "CM001"
        ? { tokenID: "t1" }
        : endpoint === "AU001"
          ? { tokenID: "t2", richUrl: "r", ...login }
          : {};
    return new Response(
      JSON.stringify({
        responseHeader: { returnCode: "0000" },
        responseBody: body,
      }),
    );
  });
  return calls;
}

const base = { userId: "A123456789", password: "pw", deviceId: "dev" };

async function run(config: Record<string, unknown>) {
  const parsed = parseTdccConfig({ ...base, ...config });
  const { client } = createTdccClient(parsed);
  return ensureTdccSession(client, parsed).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("集保換機驗證", () => {
  afterEach(() => vi.restoreAllMocks());

  it("AU001 未回報手機已驗證時，Email OTP 通過後接著要求簡訊 OTP", async () => {
    const calls = mockTdcc({ isDiffDevice: "Y", isEmailValid: "N" });

    const first = await run({ requestOtp: true });
    expect(calls).toEqual(["CM001", "AU001", "AU013"]);
    expect((first as TdccVerificationRequiredError).channel).toBe("email");

    calls.length = 0;
    const second = await run({
      requestOtp: true,
      otp: "123456",
      otpChannel: "email",
    });
    expect(calls).toEqual(["CM001", "AU001", "AU015:EMAIL", "AU014"]);
    expect(second).toBeInstanceOf(TdccVerificationRequiredError);
    expect((second as TdccVerificationRequiredError).channel).toBe("sms");

    calls.length = 0;
    const third = await run({
      requestOtp: true,
      otp: "654321",
      otpChannel: "sms",
    });
    expect(calls).toContain("AU015:MOBILE");
    expect(calls).not.toContain("AU014");
    expect(third).toBeUndefined();
  });

  it("Email 已驗證、手機未驗證時直接寄簡訊 OTP", async () => {
    const calls = mockTdcc({ isDiffDevice: "Y", isEmailValid: "Y" });

    const error = await run({ requestOtp: true });
    expect(calls).toEqual(["CM001", "AU001", "AU014"]);
    expect(error).toBeInstanceOf(TdccVerificationRequiredError);
    expect((error as TdccVerificationRequiredError).channel).toBe("sms");
  });

  it("排程同步不寄送簡訊 OTP", async () => {
    const calls = mockTdcc({ isDiffDevice: "Y", isEmailValid: "Y" });

    const error = await run({ requestOtp: false });
    expect(calls).toEqual(["CM001", "AU001"]);
    expect(error).toBeInstanceOf(TdccVerificationRequiredError);
  });

  it("手機已驗證時只需要 Email OTP", async () => {
    const calls = mockTdcc({
      isDiffDevice: "Y",
      isEmailValid: "N",
      isMobileValid: "Y",
    });

    const first = await run({ requestOtp: true });
    expect(calls).toEqual(["CM001", "AU001", "AU013"]);
    expect((first as TdccVerificationRequiredError).channel).toBe("email");

    calls.length = 0;
    const second = await run({
      requestOtp: true,
      otp: "123456",
      otpChannel: "email",
    });
    expect(calls).toContain("AU015:EMAIL");
    expect(calls).not.toContain("AU014");
    expect(second).toBeUndefined();
  });
});
