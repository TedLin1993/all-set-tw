import { bankTransactionExists } from "./calculation-repository";
import { BankTransactionNotFoundError } from "./calculation-service";
import { clearTransactionNote, upsertTransactionNote } from "./note-repository";

/** 寫入或清除交易備註；內容已由 route 去除前後空白，空字串表示清除。 */
export async function setTransactionNote(
  db: D1Database,
  transactionId: string,
  note: string,
) {
  if (!(await bankTransactionExists(db, transactionId))) {
    throw new BankTransactionNotFoundError();
  }
  const now = new Date().toISOString();
  if (!note) {
    await clearTransactionNote(db, transactionId, now);
    return null;
  }
  await upsertTransactionNote(db, transactionId, note, now);
  return note;
}
