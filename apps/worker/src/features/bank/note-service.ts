import { bankTransactionExists } from "./calculation-repository";
import { BankTransactionNotFoundError } from "./calculation-service";
import {
  deleteTransactionNote,
  upsertTransactionNote,
} from "./note-repository";

/** 寫入或清除交易備註；內容已由 route 去除前後空白，空字串表示清除。 */
export async function setTransactionNote(
  db: D1Database,
  transactionId: string,
  note: string,
) {
  if (!(await bankTransactionExists(db, transactionId))) {
    throw new BankTransactionNotFoundError();
  }
  if (!note) {
    await deleteTransactionNote(db, transactionId);
    return null;
  }
  await upsertTransactionNote(
    db,
    transactionId,
    note,
    new Date().toISOString(),
  );
  return note;
}
