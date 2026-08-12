import type { ConnectorId } from "@taiwan-fin-hub/core";

export type ScheduledSyncQueueMessage =
  | { type: "run-next-scheduled-sync" }
  | { type: "run-einvoice-chunk"; runId: string };

export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<ScheduledSyncQueueMessage>;
  ASSETS: Fetcher;
  BROWSER: Fetcher;
  AI: Ai;
  CONFIG_ENCRYPTION_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  POLICY_AUDS?: string;
  DEMO_MODE?: string | boolean;
  LOCAL_DEV_MODE?: string | boolean;
  CTBC_API_RELAY_URL?: string;
  CTBC_API_RELAY_TOKEN?: string;
}

export type Variables = {
  connectorId: ConnectorId;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};
