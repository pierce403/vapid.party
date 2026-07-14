import { getPushJobContext, updateDeliveryAttempt } from './db';
import { handleTerminalPushFailure, sendWebPush } from './push';
import type { Env, PushQueueJob } from './types';

export function pushDeliveryOptions(source: PushQueueJob['source']): {
  ttl?: number;
  urgency?: 'high';
} {
  return source === 'diagnostic' ? { ttl: 60, urgency: 'high' } : {};
}

export async function handleQueue(batch: MessageBatch<PushQueueJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const context = await getPushJobContext(env.DB, job);

    if (!context) {
      await updateDeliveryAttempt(env.DB, job.deliveryAttemptId, {
        status: 'failed',
        error: 'App or subscription no longer exists',
      });
      message.ack();
      continue;
    }

    const result = await sendWebPush(context.app, context.subscription, job.payload, {
      vapidSubject: env.VAPID_SUBJECT,
      ...pushDeliveryOptions(job.source),
    });

    if (result.success) {
      await updateDeliveryAttempt(env.DB, job.deliveryAttemptId, {
        status: 'sent',
        pushStatus: result.statusCode,
      });
      message.ack();
      continue;
    }

    if (result.terminal) {
      await updateDeliveryAttempt(env.DB, job.deliveryAttemptId, {
        status: 'expired',
        error: result.error,
        pushStatus: result.statusCode,
      });
      await handleTerminalPushFailure(env.DB, job.subscriptionId);
      message.ack();
      continue;
    }

    await updateDeliveryAttempt(env.DB, job.deliveryAttemptId, {
      status: 'failed',
      error: result.error,
      pushStatus: result.statusCode,
    });
    message.retry({ delaySeconds: 30 });
  }
}
