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
  getXmtpListenerHealth,
  markXmtpListenerRouteDirty,
  recordXmtpListenerChange,
} from './listener-registry';
import { bytesToBase64Url, bytesToHex, timingSafeEqualString } from './encoding';
import { generateApiKey, generateVapidKeys } from './vapid';

type JsonValue = Record<string, unknown> | unknown[];

export class XmtpAppIsolationPendingError extends Error {
  constructor() {
    super('XMTP app-scoped identity migration is pending; retry after the contract migration');
    this.name = 'XmtpAppIsolationPendingError';
  }
}

export class XmtpEndpointKeyConflictError extends Error {
  constructor() {
    super('An active Web Push endpoint cannot be reused with different subscription keys');
    this.name = 'XmtpEndpointKeyConflictError';
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
  xmtp_subscription_id: string;
  subscription_id: string;
  app_id: string;
  installation_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  conversation_id: string | null;
  inbox_handle: string | null;
}

interface XmtpDiagnosticRegistrationRow {
  xmtp_subscription_id: string;
  subscription_id: string;
  app_id: string;
  installation_id: string;
  registered_at: string;
  updated_at: string;
  route_updated_at: string | null;
  group_topic_count: number;
  welcome_topic_count: number;
  hmac_epoch_count: number;
}

interface DiagnosticAttemptRow {
  status: 'queued' | 'sent' | 'failed' | 'expired';
  attempts: number;
  push_status: number | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
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

function generateDiagnosticReceipt(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashDiagnosticReceipt(receipt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receipt));
  return bytesToHex(new Uint8Array(digest));
}

function diagnosticPaths(receipt: string): XmtpRegistrationResult['diagnostics'] {
  return {
    receipt,
    statusPath: '/api/xmtp/status',
    testPath: '/api/xmtp/status/test',
  };
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
  },
  options: { immutableKeys?: boolean } = {}
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
    ${options.immutableKeys
      ? 'WHERE subscriptions.p256dh = excluded.p256dh AND subscriptions.auth = excluded.auth'
      : ''}
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
  if (options.immutableKeys && (row.p256dh !== input.p256dh || row.auth !== input.auth)) {
    throw new XmtpEndpointKeyConflictError();
  }
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
  const routes = await db.prepare(`
    SELECT DISTINCT
      xs.identity_id,
      xi.app_id,
      xi.installation_id
    FROM xmtp_subscriptions xs
    JOIN xmtp_identities xi ON xi.id = xs.identity_id
    WHERE xs.subscription_id = ? AND xs.active = 1
  `).bind(id).all<{
    identity_id: string;
    app_id: string;
    installation_id: string;
  }>();
  const dirtyVersions = new Map<string, string>();
  for (const route of routes.results) {
    const key = `${route.app_id}\u0000${route.installation_id}`;
    if (!dirtyVersions.has(key)) {
      dirtyVersions.set(
        key,
        await markXmtpListenerRouteDirty(db, route.app_id, route.installation_id)
      );
    }
  }

  const timestamp = nowIso();
  await db.prepare(`
    UPDATE xmtp_subscriptions
    SET active = 0, diagnostic_token_hash = NULL, updated_at = ?
    WHERE subscription_id = ? AND active = 1
  `).bind(timestamp, id).run();

  for (const route of routes.results) {
    await db.prepare(`
      DELETE FROM xmtp_identities
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM xmtp_subscriptions xs
          WHERE xs.identity_id = xmtp_identities.id AND xs.active = 1
        )
    `).bind(route.identity_id).run();
  }
  for (const [key, dirtyVersion] of dirtyVersions) {
    const [appId, installationId] = key.split('\u0000');
    await recordXmtpListenerChange(
      db,
      appId,
      installationId,
      'registration-deleted',
      dirtyVersion
    );
  }

  // A 404/410 means the provider capability is permanently invalid. Delete
  // the physical row after recording listener removals so p256dh/auth secrets
  // and every logical route backed by that endpoint are removed immediately.
  await db.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
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

  const row = await db.prepare(`
    INSERT INTO rate_limit_logs (id, app_id, action, count, window_start)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(app_id, action, window_start) DO UPDATE SET count = count + 1
    WHERE rate_limit_logs.count <= ?
    RETURNING count
  `).bind(crypto.randomUUID(), appId, action, windowIso, limit).first<{ count: number }>();

  const current = row?.count ?? limit + 1;
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

  async upsertRegistration(
    input: NormalizedXmtpRegistration,
    options: {
      diagnosticReceipt?: string;
      issueDiagnosticReceipt?: boolean;
      immutableEndpointKeys?: boolean;
    } = {
      issueDiagnosticReceipt: true,
    }
  ): Promise<XmtpRegistrationResult> {
    const app = await this.resolveApp();
    if (!app) {
      throw new Error('XMTP VAPID app is not configured');
    }

    const { identityId, dirtyVersion } = await this.upsertIdentity(input);
    const subscription = await upsertSubscription(this.env.DB, app.id, {
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      metadata: { source: 'xmtp' },
      expirationTime: input.expirationTime,
    }, { immutableKeys: options.immutableEndpointKeys });

    const existing = await this.env.DB.prepare(`
      SELECT id, subscription_id
      FROM xmtp_subscriptions
      WHERE identity_id = ? AND active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(identityId).first<{ id: string; subscription_id: string }>();

    const xmtpSubscriptionId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await this.env.DB.prepare(`
        DELETE FROM xmtp_subscriptions
        WHERE identity_id = ? AND subscription_id = ? AND active = 0
      `).bind(identityId, subscription.id).run();
      await this.env.DB.prepare(`
        INSERT INTO xmtp_subscriptions (
          id, identity_id, subscription_id, preferences, active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).bind(
        xmtpSubscriptionId,
        identityId,
        subscription.id,
        JSON.stringify(input.preferences),
        nowIso(),
        nowIso()
      ).run();
    }

    await this.replaceTopics(identityId, input.topics);
    await recordXmtpListenerChange(
      this.env.DB,
      app.id,
      input.installationId,
      'registration-upserted',
      dirtyVersion
    );

    // Preserve an established management capability across ordinary refreshes.
    // A failed refresh must leave the client's previous receipt usable.
    const shouldIssueDiagnosticReceipt = options.issueDiagnosticReceipt !== false
      || Boolean(options.diagnosticReceipt);
    const diagnosticReceipt = shouldIssueDiagnosticReceipt
      ? options.diagnosticReceipt ?? generateDiagnosticReceipt()
      : undefined;
    const diagnosticTokenHash = diagnosticReceipt
      ? await hashDiagnosticReceipt(diagnosticReceipt)
      : null;
    await this.env.DB.prepare(`
      DELETE FROM xmtp_subscriptions
      WHERE identity_id = ? AND subscription_id = ? AND id <> ? AND active = 0
    `).bind(identityId, subscription.id, xmtpSubscriptionId).run();
    await this.env.DB.prepare(`
      UPDATE xmtp_subscriptions
      SET subscription_id = ?,
          preferences = ?,
          active = 1,
          diagnostic_token_hash = COALESCE(?, diagnostic_token_hash),
          diagnostic_group_topic_count = ?,
          diagnostic_welcome_topic_count = ?,
          diagnostic_hmac_epoch_count = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(
      subscription.id,
      JSON.stringify(input.preferences),
      diagnosticTokenHash,
      input.topics.filter((topic) => topic.topic.startsWith('/xmtp/mls/1/g-')).length,
      input.topics.filter((topic) => topic.topic.startsWith('/xmtp/mls/1/w-')).length,
      input.topics.reduce((count, topic) => count + topic.hmacKeys.length, 0),
      nowIso(),
      xmtpSubscriptionId
    ).run();

    if (existing && existing.subscription_id !== subscription.id) {
      const active = await this.env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM xmtp_subscriptions
        WHERE subscription_id = ? AND active = 1
      `).bind(existing.subscription_id).first<{ count: number }>();
      if ((active?.count ?? 0) === 0) {
        await this.env.DB.prepare('DELETE FROM subscriptions WHERE id = ?')
          .bind(existing.subscription_id)
          .run();
      }
    }

    return {
      subscriptionId: subscription.id,
      identityId,
      topicsRegistered: input.topics.length,
      hmacKeysRegistered: input.topics.reduce((count, topic) => count + topic.hmacKeys.length, 0),
      created: !existing,
      ...(diagnosticReceipt ? { diagnostics: diagnosticPaths(diagnosticReceipt) } : {}),
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
        xs.id AS xmtp_subscription_id,
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
      xmtpSubscriptionId: row.xmtp_subscription_id,
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
        xmtpSubscriptionId: match.xmtpSubscriptionId,
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
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare('DELETE FROM xmtp_topics WHERE identity_id = ?').bind(identityId),
    ];
    const timestamp = nowIso();

    for (const topic of topics) {
      const topicId = crypto.randomUUID();
      statements.push(this.env.DB.prepare(`
        INSERT INTO xmtp_topics (id, identity_id, topic, algorithm, conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        topicId,
        identityId,
        topic.topic,
        topic.algorithm,
        topic.conversationId ?? null,
        timestamp,
        timestamp
      ));

      for (const hmacKey of topic.hmacKeys) {
        statements.push(this.env.DB.prepare(`
          INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          topicId,
          hmacKey.epoch,
          hmacKey.key,
          timestamp,
          timestamp
        ));
      }
    }

    // D1 batch execution is transactional, so a failed replacement retains
    // the previous complete topic/HMAC snapshot instead of a partial one.
    await this.env.DB.batch(statements);
  }
}

export async function insertDeliveryAttempt(
  db: D1Database,
  input: {
    appId: string;
    subscriptionId: string;
    xmtpSubscriptionId?: string;
    xmtpTopicId?: string;
    eventType: string;
    payload: PushPayload;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO delivery_attempts (
      id, app_id, subscription_id, xmtp_subscription_id,
      xmtp_topic_id, event_type, status, payload_json
    )
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).bind(
    id,
    input.appId,
    input.subscriptionId,
    input.xmtpSubscriptionId ?? null,
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

export async function hasActiveSubscriptionEndpoint(
  db: D1Database,
  appId: string,
  endpoint: string
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM subscriptions
    WHERE app_id = ? AND endpoint = ? AND disabled_at IS NULL
  `).bind(appId, endpoint).first<{ present: number }>();
  return Boolean(row);
}

export async function getActiveSubscriptionEndpointKeys(
  db: D1Database,
  appId: string,
  endpoint: string
): Promise<{ p256dh: string; auth: string } | null> {
  return db.prepare(`
    SELECT p256dh, auth
    FROM subscriptions
    WHERE app_id = ? AND endpoint = ? AND disabled_at IS NULL
  `).bind(appId, endpoint).first<{ p256dh: string; auth: string }>();
}

export async function countActiveXmtpRegistrations(
  db: D1Database,
  appId: string
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM xmtp_subscriptions xs
    JOIN xmtp_identities xi ON xi.id = xs.identity_id
    JOIN subscriptions s ON s.id = xs.subscription_id
    WHERE xi.app_id = ? AND xs.active = 1 AND s.disabled_at IS NULL
  `).bind(appId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function hasActiveXmtpRegistration(
  db: D1Database,
  appId: string,
  input: { endpoint: string; inboxId: string; installationId: string }
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM xmtp_subscriptions xs
    JOIN xmtp_identities xi ON xi.id = xs.identity_id
    JOIN subscriptions s ON s.id = xs.subscription_id
    WHERE xi.app_id = ?
      AND s.endpoint = ?
      AND xi.inbox_id = ?
      AND xi.installation_id = ?
      AND xs.active = 1
      AND s.disabled_at IS NULL
  `).bind(
    appId,
    input.endpoint,
    input.inboxId,
    input.installationId
  ).first<{ present: number }>();
  return Boolean(row);
}

export interface ActiveXmtpRegistrationState {
  endpoint: string;
  p256dh: string;
  auth: string;
  diagnosticTokenHash?: string;
}

export async function getActiveXmtpRegistrationState(
  db: D1Database,
  appId: string,
  input: { inboxId: string; installationId: string }
): Promise<ActiveXmtpRegistrationState | null> {
  const row = await db.prepare(`
    SELECT
      s.endpoint,
      s.p256dh,
      s.auth,
      xs.diagnostic_token_hash
    FROM xmtp_subscriptions xs
    JOIN xmtp_identities xi ON xi.id = xs.identity_id
    JOIN subscriptions s ON s.id = xs.subscription_id
    WHERE xi.app_id = ?
      AND xi.inbox_id = ?
      AND xi.installation_id = ?
      AND xs.active = 1
      AND s.disabled_at IS NULL
    LIMIT 1
  `).bind(appId, input.inboxId, input.installationId).first<{
    endpoint: string;
    p256dh: string;
    auth: string;
    diagnostic_token_hash: string | null;
  }>();
  if (!row) return null;
  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    diagnosticTokenHash: row.diagnostic_token_hash ?? undefined,
  };
}

export async function diagnosticReceiptMatches(
  receipt: string,
  expectedHash: string
): Promise<boolean> {
  return timingSafeEqualString(await hashDiagnosticReceipt(receipt), expectedHash);
}

export async function acquireXmtpRegistrationMutationLock(
  db: D1Database,
  appId: string,
  input: { inboxId: string; installationId: string }
): Promise<string | null> {
  const lockToken = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`
    DELETE FROM xmtp_registration_mutation_locks
    WHERE app_id = ? AND inbox_id = ? AND installation_id = ? AND expires_at <= ?
  `).bind(appId, input.inboxId, input.installationId, now).run();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO xmtp_registration_mutation_locks (
      app_id, inbox_id, installation_id, lock_token, expires_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    appId,
    input.inboxId,
    input.installationId,
    lockToken,
    new Date(Date.now() + 30_000).toISOString()
  ).run();
  return result.meta.changes === 1 ? lockToken : null;
}

export async function releaseXmtpRegistrationMutationLock(
  db: D1Database,
  appId: string,
  input: { inboxId: string; installationId: string },
  lockToken: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM xmtp_registration_mutation_locks
    WHERE app_id = ? AND inbox_id = ? AND installation_id = ? AND lock_token = ?
  `).bind(appId, input.inboxId, input.installationId, lockToken).run();
}

async function endpointMutationLockInput(endpoint: string): Promise<{
  inboxId: string;
  installationId: string;
}> {
  return {
    inboxId: '__web_push_endpoint__',
    installationId: await hashDiagnosticReceipt(endpoint),
  };
}

export async function acquireXmtpEndpointMutationLock(
  db: D1Database,
  appId: string,
  endpoint: string
): Promise<string | null> {
  return acquireXmtpRegistrationMutationLock(
    db,
    appId,
    await endpointMutationLockInput(endpoint)
  );
}

export async function releaseXmtpEndpointMutationLock(
  db: D1Database,
  appId: string,
  endpoint: string,
  lockToken: string
): Promise<void> {
  return releaseXmtpRegistrationMutationLock(
    db,
    appId,
    await endpointMutationLockInput(endpoint),
    lockToken
  );
}

export async function scopedPublicRateLimitAction(
  request: Request,
  env: Pick<Env, 'INTERNAL_INGEST_TOKEN'>,
  action: string
): Promise<string> {
  const connectingIp = request.headers.get('cf-connecting-ip');
  if (!connectingIp || connectingIp.length > 128 || !env.INTERNAL_INGEST_TOKEN) {
    return `${action}:unscoped`;
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${env.INTERNAL_INGEST_TOKEN}\u0000${connectingIp}`)
  );
  return `${action}:${bytesToHex(new Uint8Array(digest)).slice(0, 24)}`;
}

export async function compactOperationalHistory(db: D1Database): Promise<void> {
  const rateLimitBefore = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const diagnosticBefore = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const deliveryBefore = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

  await db.batch([
    db.prepare('DELETE FROM rate_limit_logs WHERE window_start < ?').bind(rateLimitBefore),
    db.prepare(`
      DELETE FROM delivery_attempts
      WHERE event_type = 'vapid.diagnostic' AND created_at < ?
    `).bind(diagnosticBefore),
    db.prepare(`
      DELETE FROM delivery_attempts
      WHERE event_type <> 'vapid.diagnostic' AND created_at < ?
    `).bind(deliveryBefore),
    db.prepare('DELETE FROM xmtp_delivery_events WHERE created_at < ?').bind(deliveryBefore),
    db.prepare('DELETE FROM xmtp_registration_mutation_locks WHERE expires_at <= ?').bind(nowIso()),
  ]);
}

async function findXmtpDiagnosticRegistration(
  db: D1Database,
  receipt: string
): Promise<XmtpDiagnosticRegistrationRow | null> {
  const tokenHash = await hashDiagnosticReceipt(receipt);
  return db.prepare(`
    SELECT
      xs.id AS xmtp_subscription_id,
      s.id AS subscription_id,
      xi.app_id AS app_id,
      xi.installation_id AS installation_id,
      xs.created_at AS registered_at,
      xs.updated_at AS updated_at,
      li.updated_at AS route_updated_at,
      xs.diagnostic_group_topic_count AS group_topic_count,
      xs.diagnostic_welcome_topic_count AS welcome_topic_count,
      xs.diagnostic_hmac_epoch_count AS hmac_epoch_count
    FROM xmtp_subscriptions xs
    JOIN xmtp_identities xi ON xi.id = xs.identity_id
    JOIN subscriptions s ON s.id = xs.subscription_id
    LEFT JOIN xmtp_listener_installations li
      ON li.app_id = xi.app_id AND li.installation_id = xi.installation_id
    WHERE xs.diagnostic_token_hash = ?
      AND xs.active = 1
      AND s.disabled_at IS NULL
  `).bind(tokenHash).first<XmtpDiagnosticRegistrationRow>();
}

function diagnosticFailureCategory(row: DiagnosticAttemptRow): string | undefined {
  if (row.status === 'expired') return 'subscription_expired';
  if (row.status !== 'failed') return undefined;
  if (row.push_status === 429) return 'provider_rate_limited';
  if (row.push_status !== null && row.push_status >= 500) return 'provider_unavailable';
  if (row.push_status !== null && row.push_status >= 400) return 'provider_rejected';
  return 'relay_failure';
}

function parseDiagnosticTestId(payloadJson: string): string | undefined {
  try {
    const payload = JSON.parse(payloadJson) as { testId?: unknown };
    return typeof payload.testId === 'string' ? payload.testId : undefined;
  } catch {
    return undefined;
  }
}

function summarizeDeliveryAttempt(
  row: DiagnosticAttemptRow | null,
  kind: 'xmtp' | 'diagnostic'
): Record<string, unknown> {
  if (!row) return { status: 'none' };

  return {
    status: row.status,
    ...(kind === 'xmtp' ? { lastMatchedAt: row.created_at } : { queuedAt: row.created_at }),
    ...(row.attempts > 0 ? { lastAttemptAt: row.updated_at } : {}),
    ...(row.status === 'sent' ? { providerAcceptedAt: row.updated_at } : {}),
    ...(diagnosticFailureCategory(row)
      ? { failureCategory: diagnosticFailureCategory(row) }
      : {}),
    ...(kind === 'diagnostic' && parseDiagnosticTestId(row.payload_json)
      ? { testId: parseDiagnosticTestId(row.payload_json) }
      : {}),
  };
}

export async function getXmtpDiagnosticStatus(
  env: Env,
  receipt: string
): Promise<Record<string, unknown> | null> {
  const registration = await findXmtpDiagnosticRegistration(env.DB, receipt);
  if (!registration) return null;

  const listenerConfigured = Boolean(
    env.XMTP_LISTENER && env.XMTP_LISTENER_SYNC_TOKEN && env.INTERNAL_INGEST_TOKEN
  );
  const [health, latestChange, consumer, dirty, xmtpAttempt, diagnosticAttempt] = await Promise.all([
    getXmtpListenerHealth(env.DB, listenerConfigured),
    env.DB.prepare(`
      SELECT MAX(sequence) AS sequence
      FROM xmtp_listener_changes
      WHERE app_id = ? AND installation_id = ?
    `).bind(registration.app_id, registration.installation_id).first<{ sequence: number | null }>(),
    env.DB.prepare(`
      SELECT cursor
      FROM xmtp_listener_consumers
      ORDER BY updated_at DESC
      LIMIT 1
    `).first<{ cursor: number }>(),
    env.DB.prepare(`
      SELECT 1 AS present
      FROM xmtp_listener_dirty_routes
      WHERE app_id = ? AND installation_id = ?
    `).bind(registration.app_id, registration.installation_id).first<{ present: number }>(),
    env.DB.prepare(`
      SELECT status, attempts, push_status, payload_json, created_at, updated_at
      FROM delivery_attempts
      WHERE xmtp_subscription_id = ? AND event_type = 'xmtp.new_message'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(registration.xmtp_subscription_id).first<DiagnosticAttemptRow>(),
    env.DB.prepare(`
      SELECT status, attempts, push_status, payload_json, created_at, updated_at
      FROM delivery_attempts
      WHERE xmtp_subscription_id = ? AND event_type = 'vapid.diagnostic'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(registration.xmtp_subscription_id).first<DiagnosticAttemptRow>(),
  ]);

  const latestSequence = latestChange?.sequence ?? 0;
  const routeStatus = health.listener.status !== 'ready'
    ? 'unavailable'
    : dirty || !registration.route_updated_at || (consumer?.cursor ?? 0) < latestSequence
      ? 'pending'
      : 'synced';
  const groupTopicCount = registration.group_topic_count ?? 0;
  const welcomeTopicCount = registration.welcome_topic_count ?? 0;
  const coverage = groupTopicCount > 0 && welcomeTopicCount > 0
    ? 'complete'
    : groupTopicCount === 0 && welcomeTopicCount > 0
      ? 'welcome_only'
      : groupTopicCount > 0
        ? 'missing_welcome'
        : 'empty';

  return {
    version: 1,
    checkedAt: nowIso(),
    registration: {
      status: 'active',
      coverage,
      registeredAt: registration.registered_at,
      updatedAt: registration.updated_at,
      groupTopicCount,
      welcomeTopicCount,
      hmacEpochCount: registration.hmac_epoch_count ?? 0,
    },
    route: {
      status: routeStatus,
      changePending: routeStatus === 'pending',
      ...(registration.route_updated_at ? { updatedAt: registration.route_updated_at } : {}),
    },
    pipeline: {
      deliveryReady: health.deliveryReady,
      listenerStatus: health.listener.status,
      bridgeStatus: health.bridge.status,
    },
    deliveries: {
      xmtp: summarizeDeliveryAttempt(xmtpAttempt, 'xmtp'),
      diagnostic: summarizeDeliveryAttempt(diagnosticAttempt, 'diagnostic'),
    },
  };
}

export class XmtpDiagnosticRateLimitError extends Error {
  constructor(public readonly resetAt?: string) {
    super('Diagnostic test rate limit exceeded');
    this.name = 'XmtpDiagnosticRateLimitError';
  }
}

export async function enqueueXmtpDiagnosticTest(
  env: Env,
  receipt: string,
  scopedRateLimitAction?: string
): Promise<{ queued: true; testId: string; checkedAt: string } | null> {
  const registration = await findXmtpDiagnosticRegistration(env.DB, receipt);
  if (!registration) return null;

  const app = await getAppById(env.DB, registration.app_id);
  if (!app) return null;
  const appRateLimit = await checkAndIncrementRateLimit(
    env.DB,
    app.id,
    'xmtp-diagnostic-test',
    Math.min(app.rateLimit.maxNotificationsPerMinute, 30)
  );
  if (!appRateLimit.allowed) throw new XmtpDiagnosticRateLimitError(appRateLimit.resetAt);
  if (scopedRateLimitAction) {
    const scopedRateLimit = await checkAndIncrementRateLimit(
      env.DB,
      app.id,
      scopedRateLimitAction,
      6
    );
    if (!scopedRateLimit.allowed) {
      throw new XmtpDiagnosticRateLimitError(scopedRateLimit.resetAt);
    }
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM delivery_attempts
    WHERE xmtp_subscription_id = ?
      AND event_type = 'vapid.diagnostic'
      AND created_at >= ?
  `).bind(registration.xmtp_subscription_id, since).first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) throw new XmtpDiagnosticRateLimitError();

  const testId = crypto.randomUUID();
  const payload = { type: 'vapid.diagnostic', testId };
  const deliveryAttemptId = await insertDeliveryAttempt(env.DB, {
    appId: registration.app_id,
    subscriptionId: registration.subscription_id,
    xmtpSubscriptionId: registration.xmtp_subscription_id,
    eventType: 'vapid.diagnostic',
    payload,
  });

  try {
    await env.PUSH_QUEUE.send({
      deliveryAttemptId,
      appId: registration.app_id,
      subscriptionId: registration.subscription_id,
      payload,
      source: 'diagnostic',
    });
  } catch (error) {
    await updateDeliveryAttempt(env.DB, deliveryAttemptId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unable to queue diagnostic push',
    });
    throw error;
  }

  return { queued: true, testId, checkedAt: nowIso() };
}
