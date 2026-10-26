import type { ManualActivityFx } from "@taiwan-fin-hub/shared";
import { parseManualFx } from "./payload";
import {
  categoryExists,
  deleteManualTransaction,
  getManualTransaction,
  insertManualTransaction,
  updateManualTransactionRow,
  upsertOverride,
} from "./repository";

export type { ManualActivityFx } from "@taiwan-fin-hub/shared";

export type ManualActivityInput = {
  date: string;
  kind: "expense" | "income";
  categoryId: string;
  name: string;
  /** 台幣金額（正數）；正負號由 kind 決定。 */
  amount: number;
  fx?: ManualActivityFx | null;
};

export type ManualActivityPatchInput = Partial<ManualActivityInput>;

export class ManualActivityCategoryNotFoundError extends Error {
  constructor(readonly categoryId: string) {
    super(`Category not found: ${categoryId}`);
  }
}
export class ManualActivityNotFoundError extends Error {}

type RawPayload = { origin: "manual"; fx: ManualActivityFx | null };

export async function createManualActivity(
  db: D1Database,
  input: ManualActivityInput,
) {
  if (!(await categoryExists(db, input.categoryId)))
    throw new ManualActivityCategoryNotFoundError(input.categoryId);

  const id = `manual:${crypto.randomUUID()}`;
  const payload: RawPayload = { origin: "manual", fx: input.fx ?? null };
  await insertManualTransaction(db, {
    id,
    date: input.date,
    amount: input.kind === "expense" ? -input.amount : input.amount,
    description: input.name,
    rawPayload: JSON.stringify(payload),
    categoryId: input.categoryId,
    now: new Date().toISOString(),
  });
  return id;
}

export async function updateManualActivity(
  db: D1Database,
  id: string,
  patch: ManualActivityPatchInput,
) {
  const current = await getManualTransaction(db, id);
  if (!current) throw new ManualActivityNotFoundError();
  if (
    patch.categoryId !== undefined &&
    !(await categoryExists(db, patch.categoryId))
  )
    throw new ManualActivityCategoryNotFoundError(patch.categoryId);

  const now = new Date().toISOString();
  const kind = patch.kind ?? (current.amount < 0 ? "expense" : "income");
  const magnitude = patch.amount ?? Math.abs(current.amount);
  const fx =
    patch.fx !== undefined ? patch.fx : parseManualFx(current.rawPayload);
  const payload: RawPayload = { origin: "manual", fx: fx ?? null };

  await updateManualTransactionRow(
    db,
    id,
    {
      date: patch.date,
      amount: kind === "expense" ? -magnitude : magnitude,
      description: patch.name,
      rawPayload: JSON.stringify(payload),
    },
    now,
  );
  if (patch.categoryId !== undefined)
    await upsertOverride(db, id, patch.categoryId, now);
}

export async function removeManualActivity(db: D1Database, id: string) {
  if (!(await getManualTransaction(db, id)))
    throw new ManualActivityNotFoundError();
  await deleteManualTransaction(db, id);
}
