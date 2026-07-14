import type {
  AppRecord,
  Env,
  PushPayload,
  PushQueueJob,
  RateLimitConfig,
  SubscriptionRecord,
  XmtpTopicMatch,
} from './types';
import { DEFAULT_RATE_LIMIT } from './types';
import type {
  NormalizedXmtpRegistration,
  XmtpRegistrationResult,
  XmtpRegistrationStore,
  XmtpRelayStore,
  XmtpUnsubscribeResult,
} from './core';
import { buildXmtpPushPayload } from './core';
import {
  markXmtpListenerRouteDirty,
  recordXmtpListenerChange,
} from './listener-registry';
import { generateApiKey, generateVapidKeys } from './vapid';

type JsonValue = Record<string, unknown> | unknown[];

export class XmtpAppIsolationPendingError extends Error {
  constructor() {
    super('XMTP app-scoped identity migration is pending; retry after the contract migration');
    this.name = 'XmtpAppIsolationPendingError';
  }
}

interface AppRow {
  id: string;
  name: string;
  owner_wallet: string;
  api_key: string;
  vapid_public_key: string;
  vapid_private_key: string;
  metadata: string | null;
  rate_limit: string | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  app_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string | null;
  channel_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  disabled_at: string | null;
}

interface TopicMatchRow {
  topic_id: string;
  subscription_id: string;
  app_id: string;
  installation_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  conversation_id: string | null;
  inbox_handle: string | null;
}

function parseJsonObject(input: string | null, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseRateLimit(input: string | null): RateLimitConfig {
  return {
    ...DEFAULT_RATE_LIMIT,
    ...parseJsonObject(input, DEFAULT_RATE_LIMIT as unknown as Record<string, unknown>),
  };
}

function json(input: JsonValue | Record<string, unknown> | undefined): string {
  return JSON.stringify(input ?? {});
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapApp(row: AppRow): AppRecord {
  return {
    id: row.id,
    name: row.name,
    ownerWallet: row.owner_wallet,
    apiKey: row.api_key,
    vapidPublicKey: row.vapid_public_key,
    vapidPrivateKey: row.vapid_private_key,
    metadata: parseJsonObject(row.metadata, {}),
    rateLimit: parseRateLimit(row.rate_limit),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    appId: row.app_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userId: row.user_id ?? undefined,
    channelId: row.channel_id ?? undefined,
    metadata: parseJsonObject(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    disabledAt: row.disabled_at ?? undefined,
  };
}

export async function getAppById(db: D1Database, id: string): Promise<AppRecord | null> {
  const row = await db.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>();
  return row ? mapApp(row) : null;
}

export async function getAppByApiKey(db: D1Database, apiKey: string): Promise<AppRecord | null> {
  const row = await db.prepare('SELECT * FROM apps WHERE api_key = ?').bind(apiKey).first<AppRow>();
  return row ? mapApp(row) : null;
}

export async function getAppsByOwner(db: D1Database, ownerWallet: string): Promise<AppRecord[]> {
  const result = await db
    .prepare('SELECT * FROM apps WHERE owner_wallet = ? ORDER BY created_at DESC')
    .bind(ownerWallet.toLowerCase())
    .all<AppRow>();

  return result.results.map(mapApp);
}

export async function createApp(
  db: D1Database,
  ownerWallet: string,
  name: string,
  metadata?: Record<string, unknown>
): Promise<AppRecord> {
  const id = crypto.randomUUID();
  const apiKey = generateApiKey();
  const vapidKeys = await generateVapidKeys();
  const timestamp = nowIso();

  await db.prepare(`
    INSERT INTO apps (id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    name,
    ownerWallet.toLowerCase(),
    apiKey,
    vapidKeys.publicKey,
    vapidKeys.privateKey,
    json(metadata),
    timestamp,
    timestamp
  ).run();

  const app = await getAppById(db, id);
  if (!app) throw new Error('Created app could not be loaded');
  return app;
}

export async function updateApp(
  db: D1Database,
  id: string,
  updates: { name?: string; metadata?: Record<string, unknown>; rateLimit?: Record<string, unknown> }
): Promise<AppRecord | null> {
  const current = await getAppById(db, id);
  if (!current) return null;

  await db.prepare(`
    UPDATE apps
    SET name = ?, metadata = ?, rate_limit = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    updates.name ?? current.name,
    json(updates.metadata ?? current.metadata),
    JSON.stringify(updates.rateLimit ?? current.rateLimit),
    nowIso(),
    id
  ).run();

  return getAppById(db, id);
}

export async function deleteApp(db: D1Database, id: string): Promise<boolean> {
  const app = await db.prepare('SELECT id FROM apps WHERE id = ?')
    .bind(id)
    .first<{ id: string }>();
  if (!app) return false;

  const routes = await db.prepare(`
    SELECT DISTINCT installation_id
    FROM xmtp_identities
    WHERE app_id = ?
  `).bind(id).all<{ installation_id: string }>();

  const dirtyVersions = new Map<string, string>();
  for (const route of routes.results) {
    dirtyVersions.set(
      route.installation_id,
      await markXmtpListenerRouteDirty(db, id, route.installation_id)
    );
  }

  // Expansion migration 0003 cannot add an app FK without rebuilding this
  // table. Delete explicitly so app removal is safe both before and after 0004.
  await db.batch([
    db.prepare('DELETE FROM xmtp_identities WHERE app_id = ?').bind(id),
    db.prepare('DELETE FROM apps WHERE id = ?').bind(id),
  ]);
  for (const route of routes.results) {
    await recordXmtpListenerChange(
      db,
      id,
      route.installation_id,
      'registration-deleted',
      dirtyVersions.get(route.installation_id)
    );
  }
  return true;
}

export async function regenerateApiKey(db: D1Database, id: string): Promise<string | null> {
  const apiKey = generateApiKey();
  const result = await db
    .prepare('UPDATE apps SET api_key = ?, updated_at = ? WHERE id = ?')
    .bind(apiKey, nowIso(), id)
    .run();

  return result.meta.changes > 0 ? apiKey : null;
}

export async function countSubscriptions(db: D1Database, appId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE app_id = ? AND disabled_at IS NULL')
    .bind(appId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function upsertSubscription(
  db: D1Database,
  appId: string,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userId?: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
    expirationTime?: number | null;
  }
): Promise<SubscriptionRecord> {
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const expiresAt = input.expirationTime ? new Date(input.expirationTime).toISOString() : null;

  await db.prepare(`
    INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth, user_id, channel_id, metadata, expires_at, created_at, updated_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(app_id, endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_id = excluded.user_id,
      channel_id = excluded.channel_id,
      metadata = excluded.metadata,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      disabled_at = NULL
  `).bind(
    id,
    appId,
    input.endpoint,
    input.p256dh,
    input.auth,
    input.userId ?? null,
    input.channelId ?? null,
    json(input.metadata),
    expiresAt,
    timestamp,
    timestamp
  ).run();

  const row = await db
    .prepare('SELECT * FROM subscriptions WHERE app_id = ? AND endpoint = ?')
    .bind(appId, input.endpoint)
    .first<SubscriptionRow>();

  if (!row) throw new Error('Subscription upsert could not be loaded');
  return mapSubscription(row);
}

export async function getSubscriptionsByApp(
  db: D1Database,
  appId: string,
  filters: { userId?: string; channelId?: string } = {}
): Promise<SubscriptionRecord[]> {
  const clauses = ['app_id = ?', 'disabled_at IS NULL'];
  const values: unknown[] = [appId];

  if (filters.userId) {
    clauses.push('user_id = ?');
    values.push(filters.userId);
  }

  if (filters.channelId) {
    clauses.push('channel_id = ?');
    values.push(filters.channelId);
  }

  const result = await db
    .prepare(`SELECT * FROM subscriptions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
    .bind(...values)
    .all<SubscriptionRow>();

  return result.results.map(mapSubscription);
}

export async function getSubscriptionsByIds(
  db: D1Database,
  appId: string,
  ids: string[]
): Promise<SubscriptionRecord[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT * FROM subscriptions WHERE app_id = ? AND id IN (${placeholders}) AND disabled_at IS NULL`)
    .bind(appId, ...ids)
    .all<SubscriptionRow>();

  return result.results.map(mapSubscription);
}

export async function disableSubscription(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE subscriptions SET disabled_at = ?, updated_at = ? WHERE id = ?')
    .bind(nowIso(), nowIso(), id)
    .run();
}

export async function checkAndIncrementRateLimit(
  db: D1Database,
  appId: string,
  action: string,
  limit: number
): Promise<{ allowed: boolean; current: number; limit: number; resetAt: string }> {
  const windowStart = new Date();
  windowStart.setSeconds(0, 0);
  const windowIso = windowStart.toISOString();

  await db.prepare(`
    INSERT INTO rate_limit_logs (id, app_id, action, count, window_start)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(app_id, action, window_start) DO UPDATE SET count = count + 1
  `).bind(crypto.randomUUID(), appId, action, windowIso).run();

  const row = await db.prepare(`
    SELECT count FROM rate_limit_logs WHERE app_id = ? AND action = ? AND window_start = ?
  `).bind(appId, action, windowIso).first<{ count: number }>();

  const current = row?.count ?? 0;
  const reset = new Date(windowStart.getTime() + 60_000).toISOString();
  return { allowed: current <= limit, current, limit, resetAt: reset };
}

export async function ensureConvergeApp(env: Env): Promise<AppRecord | null> {
  const appId = env.CONVERGE_APP_ID || 'converge';
  const current = await getAppById(env.DB, appId);
  if (current) {
    if (env.CONVERGE_API_KEY && current.apiKey !== env.CONVERGE_API_KEY) {
      await env.DB.prepare('UPDATE apps SET api_key = ?, updated_at = ? WHERE id = ?')
        .bind(env.CONVERGE_API_KEY, nowIso(), appId)
        .run();
      return getAppById(env.DB, appId);
    }
    return current;
  }

  if (!env.CONVERGE_VAPID_PUBLIC_KEY || !env.CONVERGE_VAPID_PRIVATE_KEY || !env.CONVERGE_API_KEY) {
    return null;
  }

  const timestamp = nowIso();
  await env.DB.prepare(`
    INSERT INTO apps (id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(
    appId,
    'Converge',
    'converge',
    env.CONVERGE_API_KEY,
    env.CONVERGE_VAPID_PUBLIC_KEY,
    env.CONVERGE_VAPID_PRIVATE_KEY,
    json({ source: 'env' }),
    timestamp,
    timestamp
  ).run();

  return getAppById(env.DB, appId);
}

export class D1XmtpStore implements XmtpRegistrationStore, XmtpRelayStore {
  constructor(
    private readonly env: Env,
    private readonly appId?: string
  ) {}

  private async resolveApp(): Promise<AppRecord | null> {
    return this.appId ? getAppById(this.env.DB, this.appId) : ensureConvergeApp(this.env);
  }

  async upsertRegistration(input: NormalizedXmtpRegistration): Promise<XmtpRegistrationResult> {
    const app = await this.resolveApp();
    if (!app) {
      throw new Error('XMTP VAPID app is not configured');
    }

    const { identityId, dirtyVersion } = await this.upsertIdentity(input);
    const subscription = await upsertSubscription(this.env.DB, app.id, {
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userId: input.inboxId,
      channelId: input.installationId,
      metadata: { source: 'xmtp', address: input.address ?? null },
      expirationTime: input.expirationTime,
    });

    const existing = await this.env.DB.prepare(`
      SELECT id FROM xmtp_subscriptions WHERE identity_id = ? AND subscription_id = ?
    `).bind(identityId, subscription.id).first<{ id: string }>();

    const xmtpSubscriptionId = existing?.id ?? crypto.randomUUID();
    await this.env.DB.prepare(`
      INSERT INTO xmtp_subscriptions (id, identity_id, subscription_id, preferences, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(identity_id, subscription_id) DO UPDATE SET
        preferences = excluded.preferences,
        active = 1,
        updated_at = excluded.updated_at
    `).bind(
      xmtpSubscriptionId,
      identityId,
      subscription.id,
      JSON.stringify(input.preferences),
      nowIso(),
      nowIso()
    ).run();

    await this.replaceTopics(identityId, input.topics);
    await recordXmtpListenerChange(
      this.env.DB,
      app.id,
      input.installationId,
      'registration-upserted',
      dirtyVersion
    );

    return {
      subscriptionId: subscription.id,
      identityId,
      topicsRegistered: input.topics.length,
      hmacKeysRegistered: input.topics.reduce((count, topic) => count + topic.hmacKeys.length, 0),
      created: !existing,
    };
  }

  async disableRegistration(input: { endpoint: string; inboxId: string; installationId: string }): Promise<XmtpUnsubscribeResult> {
    const app = await this.resolveApp();
    if (!app) return { disabled: false };
    const row = await this.env.DB.prepare(`
      SELECT
        xs.id AS xmtp_subscription_id,
        xs.identity_id AS identity_id,
        s.id AS subscription_id
      FROM xmtp_subscriptions xs
      JOIN xmtp_identities xi ON xi.id = xs.identity_id
      JOIN subscriptions s ON s.id = xs.subscription_id
      WHERE s.endpoint = ? AND xi.app_id = ? AND xi.inbox_id = ? AND xi.installation_id = ? AND xs.active = 1
    `).bind(input.endpoint, app.id, input.inboxId, input.installationId).first<{
      xmtp_subscription_id: string;
      identity_id: string;
      subscription_id: string;
    }>();

    if (!row) return { disabled: false };

    const dirtyVersion = await markXmtpListenerRouteDirty(
      this.env.DB,
      app.id,
      input.installationId
    );

    await this.env.DB.prepare(`
      UPDATE xmtp_subscriptions SET active = 0, updated_at = ? WHERE id = ?
    `).bind(nowIso(), row.xmtp_subscription_id).run();

    const activeIdentityRegistrations = await this.env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_subscriptions
      WHERE identity_id = ? AND active = 1
    `).bind(row.identity_id).first<{ count: number }>();

    if ((activeIdentityRegistrations?.count ?? 0) === 0) {
      // Explicit unsubscribe must not retain an inbox's topic/HMAC secrets.
      // Cascades remove its logical registrations, topics, and epoch keys.
      await this.env.DB.prepare('DELETE FROM xmtp_identities WHERE id = ?')
        .bind(row.identity_id)
        .run();
    }

    const activeEndpointRegistrations = await this.env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_subscriptions
      WHERE subscription_id = ? AND active = 1
    `).bind(row.subscription_id).first<{ count: number }>();

    if ((activeEndpointRegistrations?.count ?? 0) === 0) {
      // Remove endpoint keys as soon as the last logical inbox stops using them.
      await this.env.DB.prepare('DELETE FROM subscriptions WHERE id = ?')
        .bind(row.subscription_id)
        .run();
    }

    await recordXmtpListenerChange(
      this.env.DB,
      app.id,
      input.installationId,
      'registration-deleted',
      dirtyVersion
    );

    return { disabled: true };
  }

  async findDeliveryMatches(
    installationId: string,
    topic: string,
    deliveryToken: string
  ): Promise<XmtpTopicMatch[]> {
    const result = await this.env.DB.prepare(`
      SELECT
        xt.id AS topic_id,
        s.id AS subscription_id,
        s.app_id AS app_id,
        xi.installation_id AS installation_id,
        s.endpoint AS endpoint,
        s.p256dh AS p256dh,
        s.auth AS auth,
        xt.conversation_id AS conversation_id,
        xi.inbox_handle AS inbox_handle
      FROM xmtp_topics xt
      JOIN xmtp_identities xi ON xi.id = xt.identity_id
      JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
      JOIN subscriptions s ON s.id = xs.subscription_id AND s.disabled_at IS NULL
      JOIN xmtp_listener_installations li
        ON li.app_id = xi.app_id AND li.installation_id = xi.installation_id
      WHERE xi.installation_id = ? AND xt.topic = ?
        AND li.delivery_token = ?
    `).bind(installationId, topic, deliveryToken).all<TopicMatchRow>();

    return result.results.map((row) => ({
      topicId: row.topic_id,
      subscriptionId: row.subscription_id,
      appId: row.app_id,
      installationId: row.installation_id,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      conversationId: row.conversation_id ?? undefined,
      inboxHandle: row.inbox_handle ?? undefined,
    }));
  }

  async enqueueXmtpPush(
    match: XmtpTopicMatch,
    payload: PushPayload = buildXmtpPushPayload(match),
    idempotencyKey: string
  ): Promise<boolean> {
    const eventId = crypto.randomUUID();
    const claimed = await this.env.DB.prepare(`
      INSERT OR IGNORE INTO xmtp_delivery_events (
        id, installation_id, topic, idempotency_key, subscription_id
      ) VALUES (?, ?, (SELECT topic FROM xmtp_topics WHERE id = ?), ?, ?)
    `).bind(
      eventId,
      match.installationId,
      match.topicId,
      idempotencyKey,
      match.subscriptionId
    ).run();

    if (claimed.meta.changes === 0) return false;

    try {
      const deliveryAttemptId = await insertDeliveryAttempt(this.env.DB, {
        appId: match.appId,
        subscriptionId: match.subscriptionId,
        xmtpTopicId: match.topicId,
        eventType: 'xmtp.new_message',
        payload,
      });

      await this.env.PUSH_QUEUE.send({
        deliveryAttemptId,
        appId: match.appId,
        subscriptionId: match.subscriptionId,
        payload,
        source: 'xmtp',
      });
      return true;
    } catch (error) {
      await this.env.DB.prepare('DELETE FROM xmtp_delivery_events WHERE id = ?').bind(eventId).run();
      throw error;
    }
  }

  private async upsertIdentity(input: NormalizedXmtpRegistration): Promise<{
    identityId: string;
    dirtyVersion: string;
  }> {
    const app = await this.resolveApp();
    if (!app) throw new Error('XMTP VAPID app is not configured');
    const existing = await this.env.DB.prepare(`
      SELECT id FROM xmtp_identities WHERE app_id = ? AND inbox_id = ? AND installation_id = ?
    `).bind(app.id, input.inboxId, input.installationId).first<{ id: string }>();

    if (!existing) {
      const table = await this.env.DB.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'xmtp_identities'
      `).first<{ sql: string }>();
      const hasAppScopedUnique = /UNIQUE\s*\(\s*app_id\s*,\s*inbox_id\s*,\s*installation_id\s*\)/i
        .test(table?.sql ?? '');
      if (!hasAppScopedUnique) {
        const crossApp = await this.env.DB.prepare(`
          SELECT id FROM xmtp_identities
          WHERE inbox_id = ? AND installation_id = ? AND app_id <> ?
        `).bind(input.inboxId, input.installationId, app.id).first<{ id: string }>();
        if (crossApp) throw new XmtpAppIsolationPendingError();
      }
    }

    const dirtyVersion = await markXmtpListenerRouteDirty(
      this.env.DB,
      app.id,
      input.installationId
    );
    const id = existing?.id ?? crypto.randomUUID();
    await this.env.DB.prepare(`
      INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id, address, inbox_handle, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        address = excluded.address,
        inbox_handle = COALESCE(excluded.inbox_handle, xmtp_identities.inbox_handle),
        updated_at = excluded.updated_at
    `).bind(
      id,
      app.id,
      input.inboxId,
      input.installationId,
      input.address ?? null,
      input.inboxHandle ?? null,
      nowIso(),
      nowIso()
    ).run();

    return { identityId: id, dirtyVersion };
  }

  private async replaceTopics(identityId: string, topics: NormalizedXmtpRegistration['topics']): Promise<void> {
    await this.env.DB.prepare('DELETE FROM xmtp_topics WHERE identity_id = ?').bind(identityId).run();

    for (const topic of topics) {
      const topicId = crypto.randomUUID();
      await this.env.DB.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic, algorithm, conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        topicId,
        identityId,
        topic.topic,
        topic.algorithm,
        topic.conversationId ?? null,
        nowIso(),
        nowIso()
      ).run();

      for (const hmacKey of topic.hmacKeys) {
        await this.env.DB.prepare(`
          INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          topicId,
          hmacKey.epoch,
          hmacKey.key,
          nowIso(),
          nowIso()
        ).run();
      }
    }
  }
}

export async function insertDeliveryAttempt(
  db: D1Database,
  input: {
    appId: string;
    subscriptionId: string;
    xmtpTopicId?: string;
    eventType: string;
    payload: PushPayload;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO delivery_attempts (id, app_id, subscription_id, xmtp_topic_id, event_type, status, payload_json)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).bind(
    id,
    input.appId,
    input.subscriptionId,
    input.xmtpTopicId ?? null,
    input.eventType,
    JSON.stringify(input.payload)
  ).run();
  return id;
}

export async function getPushJobContext(
  db: D1Database,
  job: PushQueueJob
): Promise<{ app: AppRecord; subscription: SubscriptionRecord } | null> {
  const [app, subscriptionRow] = await Promise.all([
    getAppById(db, job.appId),
    db.prepare('SELECT * FROM subscriptions WHERE id = ? AND app_id = ? AND disabled_at IS NULL')
      .bind(job.subscriptionId, job.appId)
      .first<SubscriptionRow>(),
  ]);

  if (!app || !subscriptionRow) return null;
  return { app, subscription: mapSubscription(subscriptionRow) };
}

export async function updateDeliveryAttempt(
  db: D1Database,
  id: string,
  update: { status: 'queued' | 'sent' | 'failed' | 'expired'; error?: string; pushStatus?: number }
): Promise<void> {
  await db.prepare(`
    UPDATE delivery_attempts
    SET status = ?,
        attempts = attempts + 1,
        last_error = ?,
        push_status = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(update.status, update.error ?? null, update.pushStatus ?? null, nowIso(), id).run();
}
