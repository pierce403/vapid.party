import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDatabase } from './database';
import logger from '../utils/logger';
import type { App } from '../types';

export function generateApiKey(): string {
  return `vp_${crypto.randomBytes(24).toString('hex')}`;
}

export function createApp(name: string): App {
  const db = getDatabase();
  const id = uuidv4();
  const apiKey = generateApiKey();
  
  db.prepare('INSERT INTO apps (id, name, api_key) VALUES (?, ?, ?)').run(id, name, apiKey);
  
  const app = getAppById(id);
  if (!app) {
    throw new Error('Failed to create app');
  }
  
  logger.info('Created new app', { appId: id, name });
  return app;
}

export function getAppById(id: string): App | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id, name, api_key, created_at FROM apps WHERE id = ?').get(id) as {
    id: string;
    name: string;
    api_key: string;
    created_at: string;
  } | undefined;
  
  if (!row) return null;
  
  return {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    createdAt: row.created_at
  };
}

export function getAppByApiKey(apiKey: string): App | null {
  const db = getDatabase();
  const row = db.prepare('SELECT id, name, api_key, created_at FROM apps WHERE api_key = ?').get(apiKey) as {
    id: string;
    name: string;
    api_key: string;
    created_at: string;
  } | undefined;
  
  if (!row) return null;
  
  return {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    createdAt: row.created_at
  };
}

export function listApps(): App[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT id, name, api_key, created_at FROM apps ORDER BY created_at DESC').all() as Array<{
    id: string;
    name: string;
    api_key: string;
    created_at: string;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    createdAt: row.created_at
  }));
}

export function deleteApp(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  
  if (result.changes > 0) {
    logger.info('Deleted app', { appId: id });
    return true;
  }
  return false;
}
