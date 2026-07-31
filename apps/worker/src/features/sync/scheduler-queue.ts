import type { Env, ScheduledSyncQueueMessage } from "../../platform/env";
import { runSchedulerTick } from "./scheduler";

const queueController = {
  cron: "queue:scheduled-sync",
} as ScheduledController;

export async function enqueueScheduledSync(env: Env) {
  await env.SYNC_QUEUE.send({ type: "run-next-scheduled-sync" });
}

export async function consumeScheduledSyncQueue(
  batch: MessageBatch<ScheduledSyncQueueMessage>,
  env: Env,
) {
  for (const message of batch.messages) {
    if (message.body.type !== "run-next-scheduled-sync") {
      console.error(
        JSON.stringify({
          event: "scheduled_sync_queue_message_rejected",
          messageId: message.id,
        }),
      );
      message.ack();
      continue;
    }

    const processed = await runSchedulerTick(env, queueController);
    if (processed) await enqueueScheduledSync(env);
    message.ack();
  }
}
