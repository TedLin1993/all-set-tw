import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createDrizzle } from "../../db/client";
import { oauthStates, sessions } from "../../db/schema";

export type SessionRow = {
  id: string;
  oauthSub: string;
  selectedAccountId: string | null;
  encryptedAccessToken: string;
  tokenExpiresAt: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export async function insertOAuthState(
  db: D1Database,
  input: {
    state: string;
    codeVerifier: string;
    redirectPath: string;
    createdAt: string;
    expiresAt: string;
  },
) {
  await createDrizzle(db).insert(oauthStates).values(input).run();
}

export async function consumeOAuthState(
  db: D1Database,
  state: string,
  now: Date,
) {
  const database = createDrizzle(db);
  const row = await database
    .select({
      state: oauthStates.state,
      codeVerifier: oauthStates.codeVerifier,
      redirectPath: oauthStates.redirectPath,
      expiresAt: oauthStates.expiresAt,
    })
    .from(oauthStates)
    .where(eq(oauthStates.state, state))
    .get();
  if (!row) return null;
  await database.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  if (row.expiresAt <= now.toISOString()) return null;
  return row;
}

export async function insertSession(db: D1Database, row: SessionRow) {
  await createDrizzle(db)
    .insert(sessions)
    .values({
      id: row.id,
      oauthSub: row.oauthSub,
      selectedAccountId: row.selectedAccountId,
      encryptedAccessToken: row.encryptedAccessToken,
      tokenExpiresAt: row.tokenExpiresAt,
      csrfToken: row.csrfToken,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    })
    .run();
}

export async function getSession(db: D1Database, id: string, now: Date) {
  const row = await createDrizzle(db)
    .select({
      id: sessions.id,
      oauthSub: sessions.oauthSub,
      selectedAccountId: sessions.selectedAccountId,
      encryptedAccessToken: sessions.encryptedAccessToken,
      tokenExpiresAt: sessions.tokenExpiresAt,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now.toISOString()),
      ),
    )
    .get();
  return row ?? null;
}

export async function updateSelectedAccount(
  db: D1Database,
  sessionId: string,
  accountId: string | null,
) {
  await createDrizzle(db)
    .update(sessions)
    .set({ selectedAccountId: accountId })
    .where(eq(sessions.id, sessionId))
    .run();
}

export async function revokeSession(
  db: D1Database,
  sessionId: string,
  now: Date,
) {
  await createDrizzle(db)
    .update(sessions)
    .set({ revokedAt: now.toISOString() })
    .where(eq(sessions.id, sessionId))
    .run();
}

export async function findLatestActiveSessionForOwner(
  db: D1Database,
  oauthSub: string,
  now: Date,
) {
  const nowIso = now.toISOString();
  return (
    (await createDrizzle(db)
      .select({
        id: sessions.id,
        oauthSub: sessions.oauthSub,
        selectedAccountId: sessions.selectedAccountId,
        encryptedAccessToken: sessions.encryptedAccessToken,
        tokenExpiresAt: sessions.tokenExpiresAt,
        csrfToken: sessions.csrfToken,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.oauthSub, oauthSub),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, nowIso),
          gt(sessions.tokenExpiresAt, nowIso),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .get()) ?? null
  );
}
