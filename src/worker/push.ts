import webPush from 'web-push';
import type { AppRecord, SubscriptionRecord } from './types';
import { disableSubscription } from './db';

export interface WebPushResult {
  success: boolean;
  statusCode?: number;
  terminal?: boolean;
  error?: string;
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
    const err = error as { statusCode?: number; message?: string };
    const terminal = err.statusCode === 404 || err.statusCode === 410;
    return {
      success: false,
      statusCode: err.statusCode,
      terminal,
      error: err.message || 'Push failed',
    };
  }
}

export async function handleTerminalPushFailure(db: D1Database, subscriptionId: string): Promise<void> {
  await disableSubscription(db, subscriptionId);
}
