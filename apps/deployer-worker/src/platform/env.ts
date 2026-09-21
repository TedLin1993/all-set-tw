export type DeployQueueMessage = { type: "run-deploy-job"; jobId: string };

export interface Env {
  DB: D1Database;
  DEPLOY_QUEUE: Queue<DeployQueueMessage>;
  RELEASE_BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  SESSION_ENCRYPTION_KEY?: string;
  LOCAL_DEV_MODE?: string | boolean;
}

export type PublicSession = {
  id: string;
  oauthSub: string;
  selectedAccountId: string | null;
  tokenExpiresAt: string;
  csrfToken: string;
  expiresAt: string;
};

export type Variables = {
  session: PublicSession | null;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};
