import webPush from 'web-push';
import type { AppRecord, SubscriptionRecord } from './types';
import { disableSubscription } from './db';

export interface WebPushResult {
  success: boolean;
  statusCode?: number;
  terminal?: boolean;
  error?: string;
  retryAfterSeconds?: number;
}

const MAX_RETRY_AFTER_SECONDS = 300;
const WEB_PUSH_SOCKET_TIMEOUT_MS = 45_000;

function boundedRetryAfterSeconds(
  headers: Record<string, string | string[] | undefined> | undefined
): number | undefined {
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;

  const seconds = /^\d+$/.test(raw.trim())
    ? Number(raw)
    : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
}

export async function sendWebPush(
  app: AppRecord,
  subscription: SubscriptionRecord,
  payload: Record<string, unknown>,
  options: {
    vapidSubject?: string;
    ttl?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
  } = {}
): Promise<WebPushResult> {
  try {
    const result = await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      JSON.stringify(payload),
      {
        timeout: WEB_PUSH_SOCKET_TIMEOUT_MS,
        TTL: options.ttl ?? 86400,
        urgency: options.urgency ?? 'normal',
        vapidDetails: {
          subject: options.vapidSubject || 'mailto:admin@vapid.party',
          publicKey: app.vapidPublicKey,
          privateKey: app.vapidPrivateKey,
        },
      }
    );

    return { success: true, statusCode: result.statusCode };
  } catch (error) {
    const err = error as {
      statusCode?: number;
      message?: string;
      headers?: Record<string, string | string[] | undefined>;
    };
    const terminal = err.statusCode === 404 || err.statusCode === 410;
    const retryAfterSeconds = boundedRetryAfterSeconds(err.headers);
    return {
      success: false,
      statusCode: err.statusCode,
      terminal,
      error: err.message || 'Push failed',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
}

export async function handleTerminalPushFailure(db: D1Database, subscriptionId: string): Promise<void> {
  await disableSubscription(db, subscriptionId);
}
