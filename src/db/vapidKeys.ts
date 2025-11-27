import webPush from 'web-push';
import { getDatabase } from './database';
import logger from '../utils/logger';
import type { VapidKeys } from '../types';

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeyPair {
  const vapidKeys = webPush.generateVAPIDKeys();
  logger.info('Generated new VAPID keypair');
  return vapidKeys;
}

export function getOrCreateVapidKeys(): VapidKeyPair {
  const db = getDatabase();
  
  // Try to get existing keys
  const existing = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get() as { public_key: string; private_key: string } | undefined;
  
  if (existing) {
    logger.debug('Using existing VAPID keys');
    return {
      publicKey: existing.public_key,
      privateKey: existing.private_key
    };
  }
  
  // Generate and store new keys
  const newKeys = generateVapidKeys();
  
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(
    newKeys.publicKey,
    newKeys.privateKey
  );
  
  logger.info('Stored new VAPID keypair in database');
  return newKeys;
}

export function getVapidPublicKey(): string {
  const keys = getOrCreateVapidKeys();
  return keys.publicKey;
}

export function getAllVapidKeys(): VapidKeys[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT id, public_key, private_key, created_at FROM vapid_keys ORDER BY id DESC').all() as Array<{
    id: number;
    public_key: string;
    private_key: string;
    created_at: string;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    publicKey: row.public_key,
    privateKey: row.private_key,
    createdAt: row.created_at
  }));
}
