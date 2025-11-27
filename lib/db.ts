import { sql } from '@vercel/postgres';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import webPush from 'web-push';
import type { App, AppMetadata, RateLimitConfig, Subscription } from './types';
import logger from './logger';

// ============================================================================
// Database Initialization
// ============================================================================

export async function initializeDatabase(): Promise<void> {
  try {
    // Apps table with per-app VAPID keys
    await sql`
      CREATE TABLE IF NOT EXISTS apps (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_wallet VARCHAR(42) NOT NULL,
        api_key VARCHAR(64) UNIQUE NOT NULL,
        vapid_public_key TEXT NOT NULL,
        vapid_private_key TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        rate_limit JSONB DEFAULT '{"maxNotificationsPerMinute": 60, "maxNotificationsPerDay": 10000, "maxSubscriptions": 10000}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Index for owner wallet lookups
    await sql`
      CREATE INDEX IF NOT EXISTS idx_apps_owner_wallet ON apps(owner_wallet)
    `;

    // Index for API key lookups
    await sql`
      CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key)
    `;

    // Subscriptions table with userId/channelId support
    await sql`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY,
        app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_id VARCHAR(255),
        channel_id VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE(app_id, endpoint)
      )
    `;

    // Indexes for efficient querying
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_app_id ON subscriptions(app_id)
    `;
    
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(app_id, user_id)
    `;
    
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_channel_id ON subscriptions(app_id, channel_id)
    `;

    // Rate limiting logs
    await sql`
      CREATE TABLE IF NOT EXISTS rate_limit_logs (
        id UUID PRIMARY KEY,
        app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        count INTEGER DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL,
        UNIQUE(app_id, action, window_start)
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_app_window ON rate_limit_logs(app_id, window_start)
    `;

    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database', error);
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateApiKey(): string {
  return `vp_${crypto.randomBytes(24).toString('hex')}`;
}

function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webPush.generateVAPIDKeys();
}

function mapRowToApp(row: Record<string, unknown>): App {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerWallet: row.owner_wallet as string,
    apiKey: row.api_key as string,
    vapidPublicKey: row.vapid_public_key as string,
    vapidPrivateKey: row.vapid_private_key as string,
    metadata: (row.metadata || {}) as AppMetadata,
    rateLimit: (row.rate_limit || {
      maxNotificationsPerMinute: 60,
      maxNotificationsPerDay: 10000,
      maxSubscriptions: 10000,
    }) as RateLimitConfig,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapRowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    appId: row.app_id as string,
    endpoint: row.endpoint as string,
    p256dh: row.p256dh as string,
    auth: row.auth as string,
    userId: row.user_id as string | undefined,
    channelId: row.channel_id as string | undefined,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
  };
}

// ============================================================================
// App CRUD Operations
// ============================================================================

export async function createApp(
  ownerWallet: string,
  name: string,
  metadata?: AppMetadata
): Promise<App> {
  const id = uuidv4();
  const apiKey = generateApiKey();
  const vapidKeys = generateVapidKeys();
  const metadataJson = JSON.stringify(metadata || {});

  const result = await sql`
    INSERT INTO apps (id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key, metadata)
    VALUES (${id}, ${name}, ${ownerWallet.toLowerCase()}, ${apiKey}, ${vapidKeys.publicKey}, ${vapidKeys.privateKey}, ${metadataJson}::jsonb)
    RETURNING *
  `;

  logger.info('Created new app', { appId: id, ownerWallet: ownerWallet.toLowerCase() });
  return mapRowToApp(result.rows[0]);
}

export async function getAppById(id: string): Promise<App | null> {
  const result = await sql`
    SELECT * FROM apps WHERE id = ${id}
  `;
  
  if (result.rows.length === 0) return null;
  return mapRowToApp(result.rows[0]);
}

export async function getAppByApiKey(apiKey: string): Promise<App | null> {
  const result = await sql`
    SELECT * FROM apps WHERE api_key = ${apiKey}
  `;
  
  if (result.rows.length === 0) return null;
  return mapRowToApp(result.rows[0]);
}

export async function getAppsByOwner(ownerWallet: string): Promise<App[]> {
  const result = await sql`
    SELECT * FROM apps 
    WHERE owner_wallet = ${ownerWallet.toLowerCase()}
    ORDER BY created_at DESC
  `;
  
  return result.rows.map(mapRowToApp);
}

export async function updateApp(
  id: string,
  updates: { name?: string; metadata?: AppMetadata; rateLimit?: RateLimitConfig }
): Promise<App | null> {
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: (string | null)[] = [];

  if (updates.name !== undefined) {
    values.push(updates.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (updates.metadata !== undefined) {
    values.push(JSON.stringify(updates.metadata));
    setClauses.push(`metadata = $${values.length}::jsonb`);
  }
  if (updates.rateLimit !== undefined) {
    values.push(JSON.stringify(updates.rateLimit));
    setClauses.push(`rate_limit = $${values.length}::jsonb`);
  }

  // For simplicity, using parameterized approach
  const result = await sql`
    UPDATE apps 
    SET 
      name = COALESCE(${updates.name ?? null}, name),
      metadata = COALESCE(${updates.metadata ? JSON.stringify(updates.metadata) : null}::jsonb, metadata),
      rate_limit = COALESCE(${updates.rateLimit ? JSON.stringify(updates.rateLimit) : null}::jsonb, rate_limit),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  if (result.rows.length === 0) return null;
  logger.info('Updated app', { appId: id });
  return mapRowToApp(result.rows[0]);
}

export async function deleteApp(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM apps WHERE id = ${id}
  `;
  
  if (result.rowCount && result.rowCount > 0) {
    logger.info('Deleted app', { appId: id });
    return true;
  }
  return false;
}

export async function regenerateApiKey(id: string): Promise<string | null> {
  const newApiKey = generateApiKey();
  
  const result = await sql`
    UPDATE apps 
    SET api_key = ${newApiKey}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING api_key
  `;

  if (result.rows.length === 0) return null;
  logger.info('Regenerated API key', { appId: id });
  return result.rows[0].api_key as string;
}

// ============================================================================
// Subscription CRUD Operations
// ============================================================================

export async function createSubscription(
  appId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  options?: {
    userId?: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
    expirationTime?: number | null;
  }
): Promise<Subscription> {
  const id = uuidv4();
  const expiresAt = options?.expirationTime
    ? new Date(options.expirationTime)
    : null;
  const metadataJson = JSON.stringify(options?.metadata || {});

  // Use upsert to handle duplicate endpoints
  const result = await sql`
    INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth, user_id, channel_id, metadata, expires_at)
    VALUES (${id}, ${appId}, ${endpoint}, ${p256dh}, ${auth}, ${options?.userId ?? null}, ${options?.channelId ?? null}, ${metadataJson}::jsonb, ${expiresAt?.toISOString() ?? null})
    ON CONFLICT (app_id, endpoint) 
    DO UPDATE SET 
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_id = EXCLUDED.user_id,
      channel_id = EXCLUDED.channel_id,
      metadata = EXCLUDED.metadata,
      expires_at = EXCLUDED.expires_at
    RETURNING *
  `;

  logger.info('Created/updated subscription', { subscriptionId: result.rows[0].id, appId });
  return mapRowToSubscription(result.rows[0]);
}

export async function getSubscriptionById(id: string): Promise<Subscription | null> {
  const result = await sql`
    SELECT * FROM subscriptions WHERE id = ${id}
  `;
  
  if (result.rows.length === 0) return null;
  return mapRowToSubscription(result.rows[0]);
}

export async function getSubscriptionsByApp(
  appId: string,
  options?: {
    userId?: string;
    channelId?: string;
    limit?: number;
    offset?: number;
  }
): Promise<Subscription[]> {
  let result;
  
  if (options?.userId && options?.channelId) {
    result = await sql`
      SELECT * FROM subscriptions 
      WHERE app_id = ${appId} 
        AND user_id = ${options.userId}
        AND channel_id = ${options.channelId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT ${options.limit || 1000}
      OFFSET ${options.offset || 0}
    `;
  } else if (options?.userId) {
    result = await sql`
      SELECT * FROM subscriptions 
      WHERE app_id = ${appId} 
        AND user_id = ${options.userId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT ${options.limit || 1000}
      OFFSET ${options.offset || 0}
    `;
  } else if (options?.channelId) {
    result = await sql`
      SELECT * FROM subscriptions 
      WHERE app_id = ${appId} 
        AND channel_id = ${options.channelId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT ${options.limit || 1000}
      OFFSET ${options.offset || 0}
    `;
  } else {
    result = await sql`
      SELECT * FROM subscriptions 
      WHERE app_id = ${appId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT ${options?.limit || 1000}
      OFFSET ${options?.offset || 0}
    `;
  }

  return result.rows.map(mapRowToSubscription);
}

export async function getSubscriptionsByIds(ids: string[]): Promise<Subscription[]> {
  if (ids.length === 0) return [];
  
  // For Vercel Postgres, we need to construct the array properly
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const result = await sql.query(
    `SELECT * FROM subscriptions WHERE id IN (${placeholders})`,
    ids
  );
  
  return result.rows.map(mapRowToSubscription);
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM subscriptions WHERE id = ${id}
  `;
  
  if (result.rowCount && result.rowCount > 0) {
    logger.info('Deleted subscription', { subscriptionId: id });
    return true;
  }
  return false;
}

export async function deleteSubscriptionByEndpoint(appId: string, endpoint: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM subscriptions WHERE app_id = ${appId} AND endpoint = ${endpoint}
  `;
  
  if (result.rowCount && result.rowCount > 0) {
    logger.info('Deleted subscription by endpoint', { appId, endpoint });
    return true;
  }
  return false;
}

export async function countSubscriptionsByApp(appId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM subscriptions WHERE app_id = ${appId}
  `;
  
  return parseInt(result.rows[0].count as string, 10);
}

// ============================================================================
// Rate Limiting
// ============================================================================

export async function checkAndIncrementRateLimit(
  appId: string,
  action: 'notification' | 'subscription' | 'broadcast',
  limit: number,
  windowMs: number = 60000
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  
  // Upsert and get current count
  const result = await sql`
    INSERT INTO rate_limit_logs (id, app_id, action, count, window_start)
    VALUES (${uuidv4()}, ${appId}, ${action}, 1, ${windowStart.toISOString()})
    ON CONFLICT (app_id, action, window_start)
    DO UPDATE SET count = rate_limit_logs.count + 1
    RETURNING count
  `;

  const current = result.rows[0].count as number;
  const allowed = current <= limit;

  if (!allowed) {
    logger.warn('Rate limit exceeded', { appId, action, current, limit });
  }

  return { allowed, current, limit };
}

export async function cleanupOldRateLimitLogs(): Promise<void> {
  await sql`
    DELETE FROM rate_limit_logs WHERE window_start < NOW() - INTERVAL '1 day'
  `;
}

