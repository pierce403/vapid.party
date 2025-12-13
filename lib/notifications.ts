import webPush, { PushSubscription } from 'web-push';
import type { App, Subscription, SendNotificationRequest } from './types';
import {
  getSubscriptionsByApp,
  getSubscriptionsByIds,
  deleteSubscription,
  checkAndIncrementRateLimit,
} from './db';
import logger, { logNotificationSent, logRateLimitExceeded } from './logger';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@vapid.party';

function normalizeBase64UrlMaybe(input: string): string {
  const compact = input.replace(/\s+/g, '');
  if (!compact) return input;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return input;

  const asBase64 = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = asBase64 + '='.repeat((4 - (asBase64.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length === 0) return input;

  return bytes.toString('base64url');
}

export interface SendResult {
  subscriptionId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface BatchSendResult {
  sent: number;
  failed: number;
  total: number;
  results: SendResult[];
}

async function sendToSubscription(
  app: App,
  subscription: Subscription,
  payload: string
): Promise<SendResult> {
  // Configure VAPID for this specific app
  webPush.setVapidDetails(
    VAPID_SUBJECT,
    app.vapidPublicKey,
    app.vapidPrivateKey
  );

  const pushSubscription: PushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: normalizeBase64UrlMaybe(subscription.p256dh),
      auth: normalizeBase64UrlMaybe(subscription.auth),
    },
  };

  try {
    const result = await webPush.sendNotification(pushSubscription, payload, {
      TTL: 86400, // 24 hours
      urgency: 'normal',
    });

    logNotificationSent(app.id, subscription.id, true, result.statusCode);

    return {
      subscriptionId: subscription.id,
      success: true,
      statusCode: result.statusCode,
    };
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };

    // Handle expired/invalid subscriptions (404 or 410)
    if (err.statusCode === 404 || err.statusCode === 410) {
      logger.warn('Subscription expired, removing', {
        subscriptionId: subscription.id,
        appId: app.id,
        statusCode: err.statusCode,
      });
      await deleteSubscription(subscription.id);
    }

    logNotificationSent(app.id, subscription.id, false, err.statusCode);

    return {
      subscriptionId: subscription.id,
      success: false,
      statusCode: err.statusCode,
      error: err.message || 'Push failed',
    };
  }
}

export async function sendNotifications(
  app: App,
  request: SendNotificationRequest
): Promise<BatchSendResult> {
  const { payload, userId, channelId, subscriptionIds } = request;
  const payloadString = JSON.stringify(payload);

  // Get target subscriptions
  let subscriptions: Subscription[];

  if (subscriptionIds && subscriptionIds.length > 0) {
    // Target specific subscriptions
    subscriptions = await getSubscriptionsByIds(subscriptionIds);
    // Filter to only subscriptions belonging to this app
    subscriptions = subscriptions.filter((s) => s.appId === app.id);
  } else {
    // Get subscriptions based on userId/channelId filters
    subscriptions = await getSubscriptionsByApp(app.id, {
      userId,
      channelId,
    });
  }

  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, total: 0, results: [] };
  }

  // Check rate limit
  const rateLimitCheck = await checkAndIncrementRateLimit(
    app.id,
    subscriptions.length > 1 ? 'broadcast' : 'notification',
    app.rateLimit.maxNotificationsPerMinute
  );

  if (!rateLimitCheck.allowed) {
    logRateLimitExceeded(
      app.id,
      'notifications',
      rateLimitCheck.current,
      rateLimitCheck.limit
    );
    throw new Error('Rate limit exceeded');
  }

  // Send notifications in parallel (with concurrency limit)
  const CONCURRENCY_LIMIT = 50;
  const results: SendResult[] = [];

  for (let i = 0; i < subscriptions.length; i += CONCURRENCY_LIMIT) {
    const batch = subscriptions.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map((sub) => sendToSubscription(app, sub, payloadString))
    );
    results.push(...batchResults);
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info('Batch notification complete', {
    appId: app.id,
    sent,
    failed,
    total: subscriptions.length,
  });

  return {
    sent,
    failed,
    total: subscriptions.length,
    results,
  };
}

// Direct send without rate limiting (for testing or internal use)
export async function sendDirectNotification(
  app: App,
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: Record<string, unknown>
): Promise<SendResult> {
  webPush.setVapidDetails(
    VAPID_SUBJECT,
    app.vapidPublicKey,
    app.vapidPrivateKey
  );

  const pushSubscription: PushSubscription = {
    endpoint,
    keys: {
      p256dh: normalizeBase64UrlMaybe(p256dh),
      auth: normalizeBase64UrlMaybe(auth),
    },
  };

  try {
    const result = await webPush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      { TTL: 86400, urgency: 'normal' }
    );

    return {
      subscriptionId: 'direct',
      success: true,
      statusCode: result.statusCode,
    };
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    return {
      subscriptionId: 'direct',
      success: false,
      statusCode: err.statusCode,
      error: err.message || 'Push failed',
    };
  }
}
