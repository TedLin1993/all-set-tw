import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recognizeNumericCaptcha,
  ValidateNumberOcrError,
  VALIDATE_NUMBER_MODEL,
} from "../../../src/features/ocr/service";

const imageBytes = new TextEncoder().encode("synthetic-captcha-image").buffer;

function aiResponse(content: unknown, finishReason = "stop") {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
  };
}

describe("驗證碼辨識的安全診斷", () => {
  afterEach(() => vi.restoreAllMocks());

  it("保留純數字答案的前導零", async () => {
    const run = vi.fn().mockResolvedValue(aiResponse("012345"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recognizeNumericCaptcha(
        { run } as unknown as Ai,
        imageBytes,
        "image/jpeg",
        6,
      ),
    ).resolves.toEqual({ number: "012345", model: VALIDATE_NUMBER_MODEL });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      response: { choices: [{ message: {} }] },
      reason: "invalid_response",
      outputLength: 0,
      finishReason: "missing",
    },
    {
      response: aiResponse(null),
      reason: "empty_output",
      outputLength: 0,
      finishReason: "stop",
    },
    {
      response: aiResponse("012", "length"),
      reason: "truncated_output",
      outputLength: 3,
      finishReason: "length",
    },
    {
      response: aiResponse("01234", "synthetic-private-finish-reason"),
      reason: "wrong_length",
      outputLength: 5,
      finishReason: "unknown",
    },
    {
      response: aiResponse("驗證碼是012345"),
      reason: "unexpected_characters",
      outputLength: 10,
      finishReason: "stop",
    },
  ])("拒絕 $reason 且診斷不包含答案或圖片內容", async (testCase) => {
    const run = vi.fn().mockResolvedValue(testCase.response);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recognizeNumericCaptcha(
        { run } as unknown as Ai,
        imageBytes,
        "image/jpeg",
        6,
      ),
    ).rejects.toBeInstanceOf(ValidateNumberOcrError);
    expect(warn).toHaveBeenCalledOnce();
    const log = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(log)).toEqual({
      event: "captcha_ocr_failed",
      model: VALIDATE_NUMBER_MODEL,
      reason: testCase.reason,
      expectedLength: 6,
      outputLength: testCase.outputLength,
      finishReason: testCase.finishReason,
      imageByteLength: imageBytes.byteLength,
      elapsedMs: expect.any(Number),
    });
    expect(log).not.toMatch(/012345|01234|synthetic-private|synthetic-captcha/);
    expect(log).not.toContain(btoa("synthetic-captcha-image"));
  });
});
