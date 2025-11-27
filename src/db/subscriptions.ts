import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from './database';
import logger from '../utils/logger';
import type { Subscription } from '../types';

export interface CreateSubscriptionInput {
  appId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function createSubscription(input: CreateSubscriptionInput): Subscription {
  const db = getDatabase();
  const id = uuidv4();
  
  // Use INSERT OR REPLACE to handle duplicate endpoint for same app
  db.prepare(`
    INSERT OR REPLACE INTO subscriptions (id, app_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.appId, input.endpoint, input.p256dh, input.auth);
  
  const subscription = getSubscriptionById(id);
  if (!subscription) {
    throw new Error('Failed to create subscription');
  }
  
  logger.info('Created subscription', { subscriptionId: id, appId: input.appId });
  return subscription;
}

export function getSubscriptionById(id: string): Subscription | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id, app_id, endpoint, p256dh, auth, created_at FROM subscriptions WHERE id = ?').get(id) as {
    id: string;
    app_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    created_at: string;
  } | undefined;
  
  if (!row) return null;
  
  return {
    id: row.id,
    appId: row.app_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at
  };
}

export function getSubscriptionByEndpoint(appId: string, endpoint: string): Subscription | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id, app_id, endpoint, p256dh, auth, created_at FROM subscriptions WHERE app_id = ? AND endpoint = ?').get(appId, endpoint) as {
    id: string;
    app_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    created_at: string;
  } | undefined;
  
  if (!row) return null;
  
  return {
    id: row.id,
    appId: row.app_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at
  };
}

export function listSubscriptionsByApp(appId: string): Subscription[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT id, app_id, endpoint, p256dh, auth, created_at FROM subscriptions WHERE app_id = ? ORDER BY created_at DESC').all(appId) as Array<{
    id: string;
    app_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    created_at: string;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    appId: row.app_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at
  }));
}

export function deleteSubscription(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  
  if (result.changes > 0) {
    logger.info('Deleted subscription', { subscriptionId: id });
    return true;
  }
  return false;
}

export function deleteSubscriptionByEndpoint(appId: string, endpoint: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM subscriptions WHERE app_id = ? AND endpoint = ?').run(appId, endpoint);
  
  if (result.changes > 0) {
    logger.info('Deleted subscription by endpoint', { appId, endpoint });
    return true;
  }
  return false;
}
