import { describe, expect, it, vi } from "vitest";
import {
  recognizeAlphanumericCaptcha,
  recognizeNumericCaptcha,
  recognizeValidateNumber,
  VALIDATE_NUMBER_MODEL,
  ValidateNumberOcrError,
  ValidateNumberOcrUnavailableError,
} from "../../../src/features/ocr/service";

const image = new Uint8Array([1, 2, 3]).buffer;

describe("Gemma 4 validation number OCR", () => {
  it("sends the original JPEG and accepts an exact six-digit response", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "575831" } }],
    });

    await expect(
      recognizeValidateNumber({ run } as unknown as Ai, image, "image/jpeg"),
    ).resolves.toEqual({
      number: "575831",
      model: VALIDATE_NUMBER_MODEL,
    });

    expect(run).toHaveBeenCalledWith(
      VALIDATE_NUMBER_MODEL,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "image_url",
                image_url: { url: "data:image/jpeg;base64,AQID" },
              }),
            ]),
          }),
        ],
        chat_template_kwargs: {
          enable_thinking: false,
          clear_thinking: true,
        },
        skip_special_tokens: true,
        temperature: 0,
        max_completion_tokens: 16,
        stream: false,
      }),
    );
  });

  it("rejects prose or a non-six-digit answer", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "The number is 575831." } }],
      }),
    } as unknown as Ai;

    await expect(
      recognizeValidateNumber(ai, image, "image/jpeg"),
    ).rejects.toBeInstanceOf(ValidateNumberOcrError);
  });

  it("retries a Workers AI capacity error once and returns the recovered result", async () => {
    const capacityError = Object.assign(new Error("AI unavailable"), {
      internalCode: 3040,
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(capacityError)
      .mockResolvedValueOnce({
        choices: [{ message: { content: "575831" } }],
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      recognizeValidateNumber({ run } as unknown as Ai, image, "image/jpeg"),
    ).resolves.toMatchObject({ number: "575831" });

    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("maps an exhausted Workers AI timeout to a localized unavailable error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("3046: Request timeout"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      recognizeValidateNumber({ run } as unknown as Ai, image, "image/jpeg"),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "驗證碼辨識服務暫時逾時，請稍後重試。",
      }),
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "[ocr] Workers AI CAPTCHA recognition unavailable",
      expect.any(Error),
    );
    warn.mockRestore();
    error.mockRestore();
  });

  it("does not retry a non-transient Workers AI failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Invalid model input"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      recognizeValidateNumber({ run } as unknown as Ai, image, "image/jpeg"),
    ).rejects.toBeInstanceOf(ValidateNumberOcrUnavailableError);

    expect(run).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("supports a connector-specified numeric captcha length", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "3842" } }],
    });

    await expect(
      recognizeNumericCaptcha({ run } as unknown as Ai, image, "image/jpeg", 4),
    ).resolves.toMatchObject({ number: "3842" });

    expect(JSON.stringify(run.mock.calls[0]?.[1])).toContain(
      "exactly 4 digits",
    );
  });

  it("accepts an exact case-sensitive alphanumeric CAPTCHA", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "A1b2" } }],
    });

    await expect(
      recognizeAlphanumericCaptcha(
        { run } as unknown as Ai,
        image,
        "image/png",
        4,
      ),
    ).resolves.toMatchObject({ code: "A1b2" });

    expect(JSON.stringify(run.mock.calls[0]?.[1])).toContain(
      "case-sensitive ASCII letters or digits",
    );
  });
});
