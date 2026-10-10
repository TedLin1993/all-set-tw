export class ValidateNumberImageTooLargeError extends Error {}
export class ValidateNumberEmptyImageError extends Error {}
export class ValidateNumberOcrError extends Error {}
export class ValidateNumberOcrUnavailableError extends Error {}

export const VALIDATE_NUMBER_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const TRANSIENT_AI_RETRY_DELAY_MS = 500;
const TRANSIENT_AI_MAX_ATTEMPTS = 2;

export async function recognizeValidateNumber(
  ai: Ai,
  imageBytes: ArrayBuffer,
  contentType: string | undefined,
) {
  return recognizeNumericCaptcha(ai, imageBytes, contentType, 6);
}

export async function recognizeNumericCaptcha(
  ai: Ai,
  imageBytes: ArrayBuffer,
  contentType: string | undefined,
  digitCount: number,
) {
  const result = await recognizeCaptcha(
    ai,
    imageBytes,
    contentType,
    digitCount,
    `digits in this CAPTCHA`,
    new RegExp(`^\\d{${digitCount}}$`),
  );
  return { number: result.value, model: result.model };
}

export async function recognizeAlphanumericCaptcha(
  ai: Ai,
  imageBytes: ArrayBuffer,
  contentType: string | undefined,
  characterCount: number,
) {
  const result = await recognizeCaptcha(
    ai,
    imageBytes,
    contentType,
    characterCount,
    `case-sensitive ASCII letters or digits in this CAPTCHA`,
    new RegExp(`^[A-Za-z0-9]{${characterCount}}$`),
  );
  return { code: result.value, model: result.model };
}

async function recognizeCaptcha(
  ai: Ai,
  imageBytes: ArrayBuffer,
  contentType: string | undefined,
  characterCount: number,
  characterDescription: string,
  expectedPattern: RegExp,
) {
  if (imageBytes.byteLength === 0) throw new ValidateNumberEmptyImageError();
  if (imageBytes.byteLength > 256_000)
    throw new ValidateNumberImageTooLargeError();
  if (
    !contentType ||
    !["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(
      contentType,
    )
  )
    throw new ValidateNumberOcrError();
  if (
    !Number.isInteger(characterCount) ||
    characterCount < 4 ||
    characterCount > 8
  )
    throw new ValidateNumberOcrError();

  const model: string = VALIDATE_NUMBER_MODEL;
  const startedAt = Date.now();
  const input = {
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `Read the ${characterCount} ${characterDescription}. Return exactly ${characterCount} ${characterDescription.startsWith("digits") ? "digits" : "characters"} and nothing else.`,
          },
          {
            type: "image_url" as const,
            image_url: {
              url: `data:${contentType};base64,${arrayBufferToBase64(imageBytes)}`,
            },
          },
        ],
      },
    ],
    chat_template_kwargs: {
      enable_thinking: false,
      clear_thinking: true,
    },
    skip_special_tokens: true,
    temperature: 0,
    max_completion_tokens: 16,
    stream: false,
  };
  let response: Record<string, unknown> | undefined;
  for (let attempt = 1; attempt <= TRANSIENT_AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await ai.run(model, input);
      break;
    } catch (error) {
      const transient = isTransientAiError(error);
      if (transient && attempt < TRANSIENT_AI_MAX_ATTEMPTS) {
        console.warn(
          `[ocr] Workers AI CAPTCHA recognition failed temporarily; retrying (${attempt}/${TRANSIENT_AI_MAX_ATTEMPTS})`,
          error,
        );
        await delay(TRANSIENT_AI_RETRY_DELAY_MS);
        continue;
      }
      console.error("[ocr] Workers AI CAPTCHA recognition unavailable", error);
      throw new ValidateNumberOcrUnavailableError(
        transient
          ? "驗證碼辨識服務暫時逾時，請稍後重試。"
          : "驗證碼辨識服務暫時無法使用，請稍後重試。",
      );
    }
  }
  if (!response)
    throw new ValidateNumberOcrUnavailableError(
      "驗證碼辨識服務暫時無法使用，請稍後重試。",
    );

  const content = readMessageContent(response);
  const value = content?.trim() ?? "";
  if (!expectedPattern.test(value)) {
    const choice = Array.isArray(response.choices)
      ? response.choices[0]
      : undefined;
    const finishReason = isRecord(choice)
      ? safeFinishReason(choice.finish_reason)
      : "missing";
    const characterPattern = characterDescription.startsWith("digits")
      ? /^\d+$/
      : /^[A-Za-z0-9]+$/;
    const reason =
      content === undefined
        ? "invalid_response"
        : finishReason === "length"
          ? "truncated_output"
          : value.length === 0
            ? "empty_output"
            : characterPattern.test(value)
              ? "wrong_length"
              : "unexpected_characters";
    console.warn(
      JSON.stringify({
        event: "captcha_ocr_failed",
        model: VALIDATE_NUMBER_MODEL,
        reason,
        expectedLength: characterCount,
        outputLength: value.length,
        finishReason,
        imageByteLength: imageBytes.byteLength,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    throw new ValidateNumberOcrError();
  }
  return {
    value,
    model: VALIDATE_NUMBER_MODEL,
  };
}

function readMessageContent(response: Record<string, unknown>) {
  const choices = response.choices;
  if (!Array.isArray(choices)) return undefined;
  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  const content = choice.message.content;
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (!Array.isArray(content)) return undefined;
  if (
    content.length > 0 &&
    !content.some((part) => isRecord(part) && typeof part.text === "string")
  )
    return undefined;
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function safeFinishReason(value: unknown) {
  if (value === undefined || value === null) return "missing";
  return typeof value === "string" &&
    [
      "stop",
      "length",
      "tool_calls",
      "content_filter",
      "function_call",
    ].includes(value)
    ? value
    : "unknown";
}

function arrayBufferToBase64(bytes: ArrayBuffer) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1)
    binary += String.fromCharCode(view[index] ?? 0);
  return btoa(binary);
}

function isTransientAiError(error: unknown) {
  const code = isRecord(error) ? String(error.internalCode ?? "") : "";
  if (["3007", "3040", "3046"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:3007|3040|3046)\b|request timeout|timed? out|capacity temporarily exceeded|no more data centers|temporarily unavailable/i.test(
    message,
  );
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
