import { SYNC_MAX_DURATION_MS } from "./lock";

export const SYNC_STALLED_AFTER_MS = 3 * 60 * 1000;

export function durableRunState(
  run: {
    id: string;
    status: string;
    phase?: string;
    created_at: string;
    updated_at: string;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
    chunk_lease_owner?: string | null;
    chunk_lease_expires_at?: string | null;
  },
  now = Date.now(),
) {
  const leaseUntil = run.chunk_lease_expires_at ?? run.lease_expires_at;
  const leased = Boolean(
    (run.chunk_lease_owner ?? run.lease_owner) &&
    leaseUntil &&
    Date.parse(leaseUntil) > now,
  );
  const expired = now >= Date.parse(run.created_at) + SYNC_MAX_DURATION_MS;
  const stalled =
    !leased &&
    (expired || now - Date.parse(run.updated_at) >= SYNC_STALLED_AFTER_MS);
  return {
    runId: run.id,
    phase: stalled
      ? "stalled"
      : run.status === "processing"
        ? (run.phase ?? run.status)
        : run.status,
    lastProgressAt: run.updated_at,
    retryAfterSeconds: leased
      ? Math.max(1, Math.ceil((Date.parse(leaseUntil!) - now) / 1000))
      : 0,
    leased,
    expired,
    stalled,
  };
}
