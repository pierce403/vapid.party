import {
  claimPushDeliveryAttempt,
  completePushDeliveryAttempt,
  disableXmtpCallbackRegistration,
  getPushJobContext,
  releasePushDeliveryAttempt,
} from './db';
import { handleTerminalPushFailure, sendWebPush } from './push';
import type { WebPushResult } from './push';
import { sendXmtpCallback } from './callback';
import type { Env, PushQueueJob } from './types';

const MIN_PUSH_RETRY_SECONDS = 30;
const MAX_PUSH_RETRY_SECONDS = 300;

async function handleTerminalDeliveryFailure(
  env: Env,
  job: PushQueueJob,
  deliveryKind: 'web_push' | 'https_callback'
): Promise<void> {
  if (deliveryKind === 'https_callback') {
    if (!job.xmtpSubscriptionId) {
      throw new Error('Callback Queue job is missing its logical XMTP registration id');
    }
    await disableXmtpCallbackRegistration(env.DB, {
      appId: job.appId,
      subscriptionId: job.subscriptionId,
      xmtpSubscriptionId: job.xmtpSubscriptionId,
    });
    return;
  }
  await handleTerminalPushFailure(env.DB, job.subscriptionId);
}

export function pushDeliveryOptions(source: PushQueueJob['source']): {
  ttl?: number;
  urgency?: 'high';
} {
  return source === 'diagnostic' ? { ttl: 60, urgency: 'high' } : {};
}

export function isRetryablePushFailure(statusCode?: number): boolean {
  return statusCode === undefined
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500;
}

export function pushRetryDelaySeconds(
  result: WebPushResult,
  queueAttempt: number
): number {
  const exponent = Math.max(0, Math.min(4, Math.floor(queueAttempt) - 1));
  const backoff = MIN_PUSH_RETRY_SECONDS * (2 ** exponent);
  const providerDelay = Number.isFinite(result.retryAfterSeconds)
    ? Math.max(0, Math.ceil(result.retryAfterSeconds ?? 0))
    : 0;
  return Math.min(MAX_PUSH_RETRY_SECONDS, Math.max(backoff, providerDelay));
}

export async function handleQueue(batch: MessageBatch<PushQueueJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const claim = await claimPushDeliveryAttempt(env.DB, job);

    if (claim.outcome === 'ignored') {
      // An earlier terminal 404/410 may have committed before endpoint cleanup
      // failed. Retrying cleanup is safe and never calls the push provider.
      if (claim.terminalStatus === 'expired') {
        await handleTerminalDeliveryFailure(
          env,
          job,
          job.deliveryKind ?? 'web_push'
        );
      }
      message.ack();
      continue;
    }

    if (claim.outcome === 'busy') {
      message.retry({ delaySeconds: claim.retryAfterSeconds });
      continue;
    }

    const context = await getPushJobContext(env.DB, job);

    if (!context) {
      await completePushDeliveryAttempt(env.DB, job, claim.generation, {
        status: 'failed',
        deleteAttempt: job.source === 'generic',
      });
      message.ack();
      continue;
    }

    const result: WebPushResult = context.subscription.deliveryKind === 'https_callback'
      ? job.source === 'xmtp'
        ? await sendXmtpCallback(
            context.app,
            context.subscription,
            job.payload,
            job.deliveryAttemptId
          )
        : { success: false, statusCode: 422, error: 'Callbacks accept XMTP events only' }
      : await sendWebPush(context.app, context.subscription, job.payload, {
          vapidSubject: env.VAPID_SUBJECT,
          ...pushDeliveryOptions(job.source),
        });

    if (result.success) {
      // The provider request and D1 cannot share one atomic transaction. A
      // crash after provider acceptance but before this terminal commit leaves
      // an expiring processing lease; reclaiming it can cause an unavoidable
      // duplicate delivery under Cloudflare Queue's at-least-once contract.
      await completePushDeliveryAttempt(env.DB, job, claim.generation, {
        status: 'sent',
        pushStatus: result.statusCode,
        deleteAttempt: job.source === 'generic',
      });
      message.ack();
      continue;
    }

    if (result.terminal || result.statusCode === 404 || result.statusCode === 410) {
      const completed = await completePushDeliveryAttempt(env.DB, job, claim.generation, {
        status: 'expired',
        pushStatus: result.statusCode,
      });
      if (completed) {
        await handleTerminalDeliveryFailure(
          env,
          job,
          context.subscription.deliveryKind
        );
      }
      message.ack();
      continue;
    }

    if (isRetryablePushFailure(result.statusCode)) {
      const released = await releasePushDeliveryAttempt(
        env.DB,
        job,
        claim.generation,
        result.statusCode
      );
      if (released) {
        message.retry({
          delaySeconds: pushRetryDelaySeconds(result, message.attempts),
        });
      } else {
        // A newer lease generation owns recovery now; do not add another
        // competing retry for this stale consumer.
        message.ack();
      }
      continue;
    }

    await completePushDeliveryAttempt(env.DB, job, claim.generation, {
      status: 'failed',
      pushStatus: result.statusCode,
      deleteAttempt: job.source === 'generic',
    });
    message.ack();
  }
}
