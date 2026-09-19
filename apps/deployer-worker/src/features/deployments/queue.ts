import type { Env } from "../../platform/env";

export async function enqueueDeployJob(env: Env, jobId: string) {
  await env.DEPLOY_QUEUE.send({ type: "run-deploy-job", jobId });
}
