/**
 * Builds Workers AI Clef requests that classify one bank transaction into the
 * user's categories, and reads the answer. Pure: no D1, bindings or Env.
 */

export const AI_CLASSIFICATION_MODEL = "@cf/cloudflare/clef-flash";
/** Below this top probability the transaction stays unclassified. */
export const AI_CLASSIFICATION_MIN_PROBABILITY = 0.35;

/**
 * Definitions the model classifies against. They are the single source of
 * truth for borderline cases, so a merchant does not depend on past choices.
 */
export const SYSTEM_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  salary: "薪資、獎金與勞務報酬",
  transfer:
    "自己名下帳戶之間的資金移動，例如信用卡繳款、電子支付儲值與提領、換匯",
  food: "食物與飲料，含餐廳、小吃、飲料、咖啡與外送；超商與超市消費歸購物",
  transport:
    "大眾運輸、計程車與叫車、加油、停車、過路費、交通卡儲值、機票與租車",
  shopping:
    "商品購買，含日用品、服飾、3C、家具、網購，以及超商、超市與量販店（不論購買品項）",
  housing: "房租、房貸、管理費，以及旅館、民宿等住宿",
  health: "醫院、診所、藥局與健康檢查",
  education: "課程、學費、書籍與電子書",
  entertainment: "影音串流、遊戲、電影、展覽、門票、旅遊行程與體驗",
  investment: "股票、基金、證券交割、股息與投資相關款項",
  fee: "銀行手續費、跨行或跨境手續費、信用卡年費與利息支出",
  insurance: "保險費",
  tax: "所得稅、牌照稅、地價稅、房屋稅與罰單",
  software: "工具類軟體與訂閱、AI 工具、雲端主機與網域",
  utilities: "電費、水費、瓦斯費、電信與網路費，含出國上網的 eSIM 與漫遊",
  donation: "公益團體、宗教團體與政治獻金",
  "other-income": "不屬於其他類別的收入，例如存款利息、中獎",
  reward: "銀行或信用卡給的回饋金、消費折抵、點數折抵與年費減免",
};

const UNCLASSIFIED_CATEGORY_ID = "other";
// System categories that only describe money coming in.
const INCOME_ONLY = new Set(["salary", "other-income", "reward"]);
// System categories offered for money coming in; user categories are offered
// for both directions because their direction is unknown.
const INCOME_CHOICES = new Set([
  "salary",
  "transfer",
  "investment",
  "reward",
  "other-income",
]);

const INSTRUCTIONS =
  "這是一筆台灣個人金融帳戶的交易。依錢的用途判斷最適合的分類，不看付款管道；交易摘要看不出用途時，以電子發票的賣方與品項為準。";

export type AiCategory = { id: string; label: string; isSystem: boolean };

export type AiClassificationInput = {
  date: string;
  accountType: string | null;
  amount: number;
  currency: string;
  description: string | null;
  counterparty: string | null;
  invoice?: { sellerName: string | null; items: string[] };
};

export type AiClassificationAnswer = {
  categoryId: string | null;
  probability: number;
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  credit: "信用卡",
  deposit: "存款帳戶",
  savings: "存款帳戶",
  checking: "支票帳戶",
  time_deposit: "定存",
};

/** Transactions with no text at all cannot be classified. */
export function hasClassifiableText(input: AiClassificationInput) {
  return Boolean(
    input.description?.trim() ||
    input.counterparty?.trim() ||
    input.invoice?.sellerName?.trim() ||
    input.invoice?.items.length,
  );
}

export function aiCategoryChoices(
  categories: AiCategory[],
  amount: number,
): Record<string, string> {
  const choices = categories.filter((category) => {
    if (category.id === UNCLASSIFIED_CATEGORY_ID) return false;
    if (!category.isSystem) return true;
    return amount > 0
      ? INCOME_CHOICES.has(category.id)
      : !INCOME_ONLY.has(category.id);
  });
  return Object.fromEntries(
    choices.map((category) => {
      const description = SYSTEM_CATEGORY_DESCRIPTIONS[category.id];
      return [
        category.id,
        category.isSystem && description
          ? `${category.label}：${description}`
          : category.label,
      ];
    }),
  );
}

export function buildAiClassificationRequest(
  input: AiClassificationInput,
  categories: AiCategory[],
) {
  const state: Record<string, unknown> = {
    日期: input.date.slice(0, 10),
    帳戶類型: input.accountType
      ? (ACCOUNT_TYPE_LABELS[input.accountType] ?? input.accountType)
      : undefined,
    方向: input.amount < 0 ? "支出" : "入帳",
    金額: Math.abs(input.amount),
    幣別: input.currency,
    交易摘要: input.description ?? undefined,
  };
  if (input.counterparty && input.counterparty !== input.description)
    state.交易對象 = input.counterparty;
  if (input.invoice)
    state.對應電子發票 = {
      賣方: input.invoice.sellerName ?? undefined,
      品項: input.invoice.items,
    };
  return {
    model: "clef-flash",
    state,
    questions: {
      category: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: aiCategoryChoices(categories, input.amount),
      },
    },
  };
}

export class AiClassificationResponseError extends Error {}

export function readAiClassificationAnswer(
  response: unknown,
  offeredCategoryIds: Iterable<string>,
): AiClassificationAnswer {
  const probabilities = (
    response as {
      answers?: { category?: { probabilities?: Record<string, unknown> } };
    }
  )?.answers?.category?.probabilities;
  if (!probabilities || typeof probabilities !== "object")
    throw new AiClassificationResponseError("Clef response has no category.");
  const offered = new Set(offeredCategoryIds);
  let best: AiClassificationAnswer = { categoryId: null, probability: 0 };
  for (const [categoryId, value] of Object.entries(probabilities)) {
    if (
      offered.has(categoryId) &&
      typeof value === "number" &&
      value > best.probability
    )
      best = { categoryId, probability: value };
  }
  return best.probability >= AI_CLASSIFICATION_MIN_PROBABILITY
    ? best
    : { categoryId: null, probability: best.probability };
}

/** Stable digest of everything sent to the model, to skip unchanged input. */
export async function aiClassificationInputHash(input: AiClassificationInput) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.accountType,
        Math.sign(input.amount),
        Math.abs(input.amount),
        input.currency,
        input.description,
        input.counterparty,
        input.invoice?.sellerName ?? null,
        input.invoice?.items ?? null,
      ]),
    ),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function errorCode(error: unknown) {
  const code =
    typeof error === "object" && error !== null
      ? String((error as { internalCode?: unknown }).internalCode ?? "")
      : "";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Workers AI daily free allocation is used up (resets at 00:00 UTC). */
export function isAiQuotaExceededError(error: unknown) {
  const { code, message } = errorCode(error);
  return code === "3036" || /\b3036\b|daily free allocation/i.test(message);
}

export function isTransientAiError(error: unknown) {
  const { code, message } = errorCode(error);
  if (["3007", "3040", "3046"].includes(code)) return true;
  return /\b(?:3007|3040|3046)\b|request timeout|timed? out|capacity temporarily exceeded|temporarily unavailable/i.test(
    message,
  );
}
