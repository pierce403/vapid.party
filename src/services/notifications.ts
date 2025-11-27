import webPush, { PushSubscription } from 'web-push';
import { getOrCreateVapidKeys } from '../db/vapidKeys';
import { getSubscriptionById, deleteSubscription } from '../db/subscriptions';
import logger from '../utils/logger';
import type { NotificationPayload, Subscription } from '../types';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@vapid.party';

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (!vapidConfigured) {
    const keys = getOrCreateVapidKeys();
    webPush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    vapidConfigured = true;
    logger.info('VAPID details configured');
  }
}

export function resetVapidConfig(): void {
  vapidConfigured = false;
}

export interface SendNotificationResult {
  success: boolean;
  subscriptionId?: string;
  endpoint: string;
  error?: string;
  statusCode?: number;
}

export async function sendNotification(
  subscription: Subscription,
  payload: NotificationPayload
): Promise<SendNotificationResult> {
  ensureVapidConfigured();
  
  const pushSubscription: PushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth
    }
  };
  
  try {
    const result = await webPush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      {
        TTL: 86400, // 24 hours
        urgency: 'normal'
      }
    );
    
    logger.info('Notification sent successfully', {
      subscriptionId: subscription.id,
      endpoint: subscription.endpoint,
      statusCode: result.statusCode
    });
    
    return {
      success: true,
      subscriptionId: subscription.id,
      endpoint: subscription.endpoint,
      statusCode: result.statusCode
    };
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    
    // Handle expired/invalid subscriptions
    if (err.statusCode === 404 || err.statusCode === 410) {
      logger.warn('Subscription expired or invalid, removing', {
        subscriptionId: subscription.id,
        endpoint: subscription.endpoint,
        statusCode: err.statusCode
      });
      deleteSubscription(subscription.id);
    }
    
    logger.error('Failed to send notification', {
      subscriptionId: subscription.id,
      endpoint: subscription.endpoint,
      error: err.message,
      statusCode: err.statusCode
    });
    
    return {
      success: false,
      subscriptionId: subscription.id,
      endpoint: subscription.endpoint,
      error: err.message || 'Unknown error',
      statusCode: err.statusCode
    };
  }
}

export async function sendNotificationToSubscriptionId(
  subscriptionId: string,
  payload: NotificationPayload
): Promise<SendNotificationResult> {
  const subscription = getSubscriptionById(subscriptionId);
  
  if (!subscription) {
    return {
      success: false,
      subscriptionId,
      endpoint: 'unknown',
      error: 'Subscription not found'
    };
  }
  
  return sendNotification(subscription, payload);
}

export async function sendNotificationDirect(
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: NotificationPayload
): Promise<SendNotificationResult> {
  ensureVapidConfigured();
  
  const pushSubscription: PushSubscription = {
    endpoint,
    keys: {
      p256dh,
      auth
    }
  };
  
  try {
    const result = await webPush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      {
        TTL: 86400,
        urgency: 'normal'
      }
    );
    
    logger.info('Direct notification sent successfully', {
      endpoint,
      statusCode: result.statusCode
    });
    
    return {
      success: true,
      endpoint,
      statusCode: result.statusCode
    };
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    
    logger.error('Failed to send direct notification', {
      endpoint,
      error: err.message,
      statusCode: err.statusCode
    });
    
    return {
      success: false,
      endpoint,
      error: err.message || 'Unknown error',
      statusCode: err.statusCode
    };
  }
}
