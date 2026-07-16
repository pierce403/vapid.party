import type {
  AppPublicProfile,
  AppRecord,
  AppUsageStats,
  Env,
  LeaderboardEntry,
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
import { bytesToBase64Url, bytesToHex, sha256Hex, timingSafeEqualString } from './encoding';
import { generateApiKey, generateVapidKeys } from './vapid';
import { APP_DOMAIN_VERIFICATION_FRESHNESS_MS } from './domain';

type JsonValue = Record<string, unknown> | unknown[];

const PUBLIC_APP_RATE_LIMIT: RateLimitConfig = {
  maxNotificationsPerMinute: 60,
  maxNotificationsPerDay: 10_000,
  // App deletion and shared-endpoint cleanup currently emit one listener
  // tombstone per logical XMTP route. Keep the frictionless tier within D1's
  // paid per-invocation query budget until that maintenance becomes a Workflow.
  maxSubscriptions: 150,
};

const XMTP_APP_CAPACITY_ROWS = 5_000;
const XMTP_GLOBAL_CAPACITY_ROWS = 25_000;
const XMTP_GLOBAL_CAPACITY_LOCK = {
  appId: '__vapid_party_global__',
  scope: '__xmtp_capacity__',
  resourceId: '__all__',
};

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

export class XmtpInstallationIdentityConflictError extends Error {
  constructor() {
    super('This XMTP installation is already registered to another inbox for this app');
    this.name = 'XmtpInstallationIdentityConflictError';
  }
}

export function isAppSubscriptionLimitError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'string') {
      return current.includes('app_subscription_limit');
    }
    if (!(current instanceof Error)) return false;
    if (current.message.includes('app_subscription_limit')) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

function errorChainIncludes(error: unknown, marker: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'string') return current.includes(marker);
    if (!(current instanceof Error)) return false;
    if (current.message.includes(marker)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export function isXmtpAppCapacityLimitError(error: unknown): boolean {
  return errorChainIncludes(error, 'xmtp_app_capacity_limit');
}

export function isXmtpGlobalCapacityLimitError(error: unknown): boolean {
  return errorChainIncludes(error, 'xmtp_global_capacity_limit');
}

export function isXmtpHmacKeySizeError(error: unknown): boolean {
  return errorChainIncludes(error, 'xmtp_hmac_key_size');
}

export function isPublicAppCapacityLimitError(error: unknown): boolean {
  return errorChainIncludes(error, 'public_app_capacity_limit');
}

export function isPublicSubscriptionCapacityLimitError(error: unknown): boolean {
  return errorChainIncludes(error, 'public_subscription_capacity_limit');
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
  management_token_hash?: string | null;
}

interface AppPublicProfileRow {
  app_id: string;
  description: string;
  domain: string | null;
  domain_verified_at: string | null;
  domain_last_checked_at: string | null;
  domain_verification_status: 'unverified' | 'verified' | 'mismatch';
  domain_verified_vapid_key: string | null;
  leaderboard_opt_in: number;
  updated_at: string;
}

interface UsageCountRow {
  queued: number | null;
  sent: number | null;
  failed: number | null;
  expired: number | null;
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
  status: 'queued' | 'processing' | 'sent' | 'failed' | 'expired';
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
  return sha256Hex(receipt);
}

function generateManagementToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function diagnosticPaths(
  receipt: string,
  basePath = '/api/xmtp'
): XmtpRegistrationResult['diagnostics'] {
  return {
    receipt,
    statusPath: `${basePath}/status`,
    testPath: `${basePath}/status/test`,
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

function mapPublicProfile(row: AppPublicProfileRow | null): AppPublicProfile {
  return {
    description: row?.description ?? '',
    domain: row?.domain ?? undefined,
    domainVerifiedAt: row?.domain_verified_at ?? undefined,
    domainLastCheckedAt: row?.domain_last_checked_at ?? undefined,
    domainVerificationStatus: row?.domain_verification_status ?? 'unverified',
    leaderboardOptIn: row?.leaderboard_opt_in === 1,
    updatedAt: row?.updated_at ?? nowIso(),
  };
}

export async function getAppById(db: D1Database, id: string): Promise<AppRecord | null> {
  const row = await db.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>();
  return row ? mapApp(row) : null;
}

export async function getAppByApiKey(db: D1Database, apiKey: string): Promise<AppRecord | null> {
  const row = await db.prepare(`
    SELECT apps.*
    FROM apps
    WHERE apps.api_key = ?
      AND NOT EXISTS (
        SELECT 1 FROM app_credentials
        WHERE app_credentials.app_id = apps.id
          AND app_credentials.revoked_at IS NULL
      )
  `).bind(apiKey).first<AppRow>();
  return row ? mapApp(row) : null;
}

export async function getAppByCredentialHash(
  db: D1Database,
  secretHash: string
): Promise<AppRecord | null> {
  const row = await db.prepare(`
    SELECT apps.*
    FROM app_credentials
    JOIN apps ON apps.id = app_credentials.app_id
    WHERE app_credentials.secret_hash = ?
      AND app_credentials.revoked_at IS NULL
  `).bind(secretHash).first<AppRow>();
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

export async function createPublicApp(
  db: D1Database,
  input: {
    name: string;
    description?: string;
    domain?: string;
    leaderboardOptIn?: boolean;
  }
): Promise<{ app: AppRecord; appSecret: string }> {
  const id = crypto.randomUUID();
  const appSecret = generateApiKey();
  const secretHash = await sha256Hex(appSecret);
  const vapidKeys = await generateVapidKeys();
  const timestamp = nowIso();

  await db.batch([
    db.prepare(`
      INSERT INTO apps (
        id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key,
        metadata, rate_limit, created_at, updated_at
      ) VALUES (?, ?, 'public', ?, ?, ?, '{}', ?, ?, ?)
    `).bind(
      id,
      input.name,
      `disabled:${crypto.randomUUID()}`,
      vapidKeys.publicKey,
      vapidKeys.privateKey,
      JSON.stringify(PUBLIC_APP_RATE_LIMIT),
      timestamp,
      timestamp
    ),
    db.prepare(`
      INSERT INTO app_credentials (id, app_id, secret_hash, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), id, secretHash, timestamp),
    db.prepare(`
      INSERT INTO app_public_profiles (
        app_id, description, domain, leaderboard_opt_in, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.description ?? '',
      input.domain ?? null,
      input.leaderboardOptIn ? 1 : 0,
      timestamp,
      timestamp
    ),
  ]);

  const app = await getAppById(db, id);
  if (!app) throw new Error('Created public app could not be loaded');
  return { app, appSecret };
}

export async function rotatePublicAppSecret(
  db: D1Database,
  appId: string,
  currentAppSecret: string
): Promise<string | null> {
  const appSecret = generateApiKey();
  const timestamp = nowIso();
  const result = await db.prepare(`
    UPDATE app_credentials
    SET id = ?, secret_hash = ?, created_at = ?, revoked_at = NULL
    WHERE app_id = ? AND secret_hash = ? AND revoked_at IS NULL
  `).bind(
    crypto.randomUUID(),
    await sha256Hex(appSecret),
    timestamp,
    appId,
    await sha256Hex(currentAppSecret)
  ).run();
  // The compare-and-swap makes concurrent already-authenticated rotations
  // deterministic: exactly one caller receives the new live capability.
  return result.meta.changes === 1 ? appSecret : null;
}

export async function getAppPublicProfile(
  db: D1Database,
  appId: string
): Promise<AppPublicProfile> {
  const row = await db.prepare(`
    SELECT * FROM app_public_profiles WHERE app_id = ?
  `).bind(appId).first<AppPublicProfileRow>();
  return mapPublicProfile(row);
}

export async function isPublicApp(db: D1Database, appId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present FROM app_public_profiles WHERE app_id = ?
  `).bind(appId).first<{ present: number }>();
  return Boolean(row);
}

export async function updatePublicApp(
  db: D1Database,
  appId: string,
  updates: {
    name?: string;
    description?: string;
    domain?: string | null;
    leaderboardOptIn?: boolean;
  }
): Promise<{ app: AppRecord; profile: AppPublicProfile } | null> {
  const app = await getAppById(db, appId);
  if (!app) return null;
  const current = await getAppPublicProfile(db, appId);
  const nextDomain = updates.domain === undefined ? current.domain : updates.domain ?? undefined;
  const domainChanged = nextDomain !== current.domain;
  const timestamp = nowIso();

  await db.batch([
    db.prepare('UPDATE apps SET name = ?, updated_at = ? WHERE id = ?')
      .bind(updates.name ?? app.name, timestamp, appId),
    db.prepare(`
      INSERT INTO app_public_profiles (
        app_id, description, domain, domain_verified_at,
        leaderboard_opt_in, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET
        description = excluded.description,
        domain = excluded.domain,
        domain_verified_at = CASE
          WHEN app_public_profiles.domain = excluded.domain
          THEN app_public_profiles.domain_verified_at
          ELSE NULL
        END,
        domain_last_checked_at = CASE
          WHEN app_public_profiles.domain = excluded.domain
          THEN app_public_profiles.domain_last_checked_at
          ELSE NULL
        END,
        domain_verification_status = CASE
          WHEN app_public_profiles.domain = excluded.domain
          THEN app_public_profiles.domain_verification_status
          ELSE 'unverified'
        END,
        domain_verified_vapid_key = CASE
          WHEN app_public_profiles.domain = excluded.domain
          THEN app_public_profiles.domain_verified_vapid_key
          ELSE NULL
        END,
        leaderboard_opt_in = excluded.leaderboard_opt_in,
        updated_at = excluded.updated_at
    `).bind(
      appId,
      updates.description ?? current.description,
      nextDomain ?? null,
      updates.leaderboardOptIn === undefined
        ? (current.leaderboardOptIn ? 1 : 0)
        : (updates.leaderboardOptIn ? 1 : 0),
      timestamp,
      timestamp
    ),
  ]);

  const updatedApp = await getAppById(db, appId);
  if (!updatedApp) return null;
  const profile = await getAppPublicProfile(db, appId);
  if (domainChanged && profile.domainVerifiedAt) {
    throw new Error('Domain verification was not cleared after a domain change');
  }
  return { app: updatedApp, profile };
}

export async function recordAppDomainVerification(
  db: D1Database,
  appId: string,
  domain: string,
  status: 'verified' | 'mismatch',
  vapidPublicKey?: string
): Promise<AppPublicProfile | null> {
  const timestamp = nowIso();
  const results = await db.batch([
    db.prepare(`
      UPDATE app_public_profiles
      SET domain_verified_at = NULL,
          domain_last_checked_at = ?,
          domain_verification_status = 'mismatch',
          domain_verified_vapid_key = NULL,
          updated_at = ?
      WHERE ? = 'verified' AND domain = ? AND app_id <> ?
    `).bind(timestamp, timestamp, status, domain, appId),
    db.prepare(`
      UPDATE app_public_profiles
      SET domain_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE NULL END,
          domain_last_checked_at = ?,
          domain_verification_status = ?,
          domain_verified_vapid_key = CASE WHEN ? = 'verified' THEN ? ELSE NULL END,
          updated_at = ?
      WHERE app_id = ? AND domain = ?
    `).bind(
      status,
      timestamp,
      timestamp,
      status,
      status,
      vapidPublicKey ?? null,
      timestamp,
      appId,
      domain
    ),
  ]);
  return results[1]?.meta.changes === 1 ? getAppPublicProfile(db, appId) : null;
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
    .prepare(`
      SELECT COUNT(*) AS count FROM subscriptions
      WHERE app_id = ? AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `)
    .bind(appId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface SubscriptionManagementState {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  managementTokenHash?: string;
}

export async function getSubscriptionManagementState(
  db: D1Database,
  appId: string,
  endpoint: string
): Promise<SubscriptionManagementState | null> {
  const row = await db.prepare(`
    SELECT id, endpoint, p256dh, auth, management_token_hash
    FROM subscriptions
    WHERE app_id = ? AND endpoint = ? AND disabled_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).bind(appId, endpoint).first<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    management_token_hash: string | null;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    managementTokenHash: row.management_token_hash ?? undefined,
  };
}

export async function issueSubscriptionManagementToken(
  db: D1Database,
  appId: string,
  subscriptionId: string
): Promise<string> {
  const token = generateManagementToken();
  const result = await db.prepare(`
    UPDATE subscriptions
    SET management_token_hash = ?, updated_at = ?
    WHERE id = ? AND app_id = ? AND disabled_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).bind(await sha256Hex(token), nowIso(), subscriptionId, appId).run();
  if (result.meta.changes !== 1) throw new Error('Subscription capability could not be issued');
  return token;
}

export async function subscriptionManagementTokenMatches(
  token: string,
  expectedHash: string
): Promise<boolean> {
  return timingSafeEqualString(await sha256Hex(token), expectedHash);
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
  const expiresAt = input.expirationTime === null || input.expirationTime === undefined
    ? null
    : new Date(input.expirationTime).toISOString();

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

export async function upsertPublicSubscription(
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
): Promise<{ subscription: SubscriptionRecord; managementToken: string }> {
  const id = crypto.randomUUID();
  const managementToken = generateManagementToken();
  const timestamp = nowIso();
  const expiresAt = input.expirationTime === null || input.expirationTime === undefined
    ? null
    : new Date(input.expirationTime).toISOString();
  await db.prepare(`
    INSERT INTO subscriptions (
      id, app_id, endpoint, p256dh, auth, user_id, channel_id, metadata,
      expires_at, created_at, updated_at, disabled_at, management_token_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(app_id, endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      channel_id = excluded.channel_id,
      metadata = excluded.metadata,
      expires_at = excluded.expires_at,
      management_token_hash = excluded.management_token_hash,
      updated_at = excluded.updated_at,
      disabled_at = NULL
    WHERE subscriptions.p256dh = excluded.p256dh
      AND subscriptions.auth = excluded.auth
      AND subscriptions.management_token_hash IS NOT NULL
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
    timestamp,
    await sha256Hex(managementToken)
  ).run();

  const row = await db.prepare(`
    SELECT * FROM subscriptions WHERE app_id = ? AND endpoint = ?
  `).bind(appId, input.endpoint).first<SubscriptionRow>();
  if (!row) throw new Error('Public subscription upsert could not be loaded');
  if (
    row.p256dh !== input.p256dh
    || row.auth !== input.auth
    || !row.management_token_hash
    || !await subscriptionManagementTokenMatches(managementToken, row.management_token_hash)
  ) throw new XmtpEndpointKeyConflictError();
  return { subscription: mapSubscription(row), managementToken };
}

export async function getSubscriptionsByApp(
  db: D1Database,
  appId: string,
  filters: { userId?: string; channelId?: string; limit?: number } = {}
): Promise<SubscriptionRecord[]> {
  const clauses = [
    'app_id = ?',
    'disabled_at IS NULL',
    "(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  ];
  const values: unknown[] = [appId];

  if (filters.userId) {
    clauses.push('user_id = ?');
    values.push(filters.userId);
  }

  if (filters.channelId) {
    clauses.push('channel_id = ?');
    values.push(filters.channelId);
  }

  const limitClause = filters.limit ? ' LIMIT ?' : '';
  if (filters.limit) values.push(Math.max(1, Math.floor(filters.limit)));
  const result = await db
    .prepare(`SELECT * FROM subscriptions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC${limitClause}`)
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
  // D1 permits at most 100 bound parameters per statement. Reserve one for
  // appId and chunk the remaining identifiers without allowing duplicates to
  // enqueue the same physical endpoint more than once.
  const uniqueIds = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 99) {
    chunks.push(uniqueIds.slice(index, index + 99));
  }
  const results = await Promise.all(chunks.map(async (chunk) => {
    const placeholders = chunk.map(() => '?').join(', ');
    return db
      .prepare(`
        SELECT * FROM subscriptions
        WHERE app_id = ? AND id IN (${placeholders}) AND disabled_at IS NULL
          AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `)
      .bind(appId, ...chunk)
      .all<SubscriptionRow>();
  }));

  return results.flatMap((result) => result.results.map(mapSubscription));
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
  limit: number,
  options: { amount?: number; window?: 'minute' | 'day' } = {}
): Promise<{ allowed: boolean; current: number; limit: number; resetAt: string }> {
  const amount = Math.max(1, Math.floor(options.amount ?? 1));
  const windowStart = new Date();
  if (options.window === 'day') windowStart.setUTCHours(0, 0, 0, 0);
  else windowStart.setSeconds(0, 0);
  const windowIso = windowStart.toISOString();

  const row = await db.prepare(`
    INSERT INTO rate_limit_logs (id, app_id, action, count, window_start)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(app_id, action, window_start) DO UPDATE SET count = count + excluded.count
    WHERE rate_limit_logs.count <= ?
    RETURNING count
  `).bind(
    crypto.randomUUID(),
    appId,
    action,
    amount,
    windowIso,
    limit
  ).first<{ count: number }>();

  const current = row?.count ?? limit + amount;
  const reset = new Date(
    windowStart.getTime() + (options.window === 'day' ? 24 * 60 * 60_000 : 60_000)
  ).toISOString();
  return { allowed: current <= limit, current, limit, resetAt: reset };
}

export async function publicRequestScopeHash(
  request: Request,
  env: Pick<Env, 'INTERNAL_INGEST_TOKEN'>
): Promise<string> {
  const connectingIp = request.headers.get('cf-connecting-ip');
  if (!connectingIp || connectingIp.length > 128 || !env.INTERNAL_INGEST_TOKEN) {
    return 'unscoped';
  }
  return (await sha256Hex(`${env.INTERNAL_INGEST_TOKEN}\u0000${connectingIp}`)).slice(0, 32);
}

export async function checkAndIncrementPublicRateLimit(
  db: D1Database,
  scopeHash: string,
  action: string,
  limit: number,
  options: { amount?: number; window?: 'minute' | 'day' } = {}
): Promise<{ allowed: boolean; current: number; limit: number; resetAt: string }> {
  const amount = Math.max(1, Math.floor(options.amount ?? 1));
  const windowStart = new Date();
  if (options.window === 'day') windowStart.setUTCHours(0, 0, 0, 0);
  else windowStart.setSeconds(0, 0);
  const windowIso = windowStart.toISOString();
  const row = await db.prepare(`
    INSERT INTO public_rate_limits (scope_hash, action, window_start, count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_hash, action, window_start) DO UPDATE SET count = count + excluded.count
    WHERE public_rate_limits.count <= ?
    RETURNING count
  `).bind(scopeHash, action, windowIso, amount, limit).first<{ count: number }>();
  const current = row?.count ?? limit + amount;
  return {
    allowed: current <= limit,
    current,
    limit,
    resetAt: new Date(
      windowStart.getTime() + (options.window === 'day' ? 24 * 60 * 60_000 : 60_000)
    ).toISOString(),
  };
}

function usageCounts(row: UsageCountRow | null): {
  queued: number;
  providerAccepted: number;
  failed: number;
  expired: number;
} {
  return {
    queued: Number(row?.queued ?? 0),
    providerAccepted: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    expired: Number(row?.expired ?? 0),
  };
}

function utcDayOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function getAppUsageStats(
  db: D1Database,
  app: AppRecord
): Promise<AppUsageStats> {
  const today = utcDayOffset(0);
  const firstDay = utcDayOffset(-6);
  const [profile, subscriptionCount, xmtp, todayUsage, sevenDayUsage] = await Promise.all([
    getAppPublicProfile(db, app.id),
    countSubscriptions(db, app.id),
    db.prepare(`
      WITH active_identities AS (
        SELECT DISTINCT xi.id
        FROM xmtp_identities xi
        JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
        JOIN subscriptions s ON s.id = xs.subscription_id AND s.disabled_at IS NULL
        WHERE xi.app_id = ?
          AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
      SELECT
        (SELECT COUNT(*) FROM xmtp_subscriptions xs
          JOIN xmtp_identities xi ON xi.id = xs.identity_id
          JOIN subscriptions s ON s.id = xs.subscription_id
          WHERE xi.app_id = ? AND xs.active = 1 AND s.disabled_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) AS registrations,
        COUNT(DISTINCT CASE
          WHEN xt.topic LIKE '/xmtp/mls/1/g-%/proto' THEN xt.id
        END) AS group_topics,
        COUNT(DISTINCT CASE
          WHEN xt.topic LIKE '/xmtp/mls/1/w-%/proto' THEN xt.id
        END) AS welcome_topics,
        COUNT(DISTINCT hk.id) AS hmac_epochs
      FROM active_identities ai
      LEFT JOIN xmtp_topics xt ON xt.identity_id = ai.id
      LEFT JOIN xmtp_topic_hmac_keys hk ON hk.topic_id = xt.id
    `).bind(app.id, app.id).first<{
      registrations: number | null;
      group_topics: number | null;
      welcome_topics: number | null;
      hmac_epochs: number | null;
    }>(),
    db.prepare(`
      SELECT
        SUM(queued_count) AS queued,
        SUM(sent_count) AS sent,
        SUM(failed_count) AS failed,
        SUM(expired_count) AS expired
      FROM app_usage_daily
      WHERE app_id = ? AND day = ?
        AND event_type IN ('generic.push', 'xmtp.new_message')
    `).bind(app.id, today).first<UsageCountRow>(),
    db.prepare(`
      SELECT
        SUM(queued_count) AS queued,
        SUM(sent_count) AS sent,
        SUM(failed_count) AS failed,
        SUM(expired_count) AS expired
      FROM app_usage_daily
      WHERE app_id = ? AND day >= ? AND day <= ?
        AND event_type IN ('generic.push', 'xmtp.new_message')
    `).bind(app.id, firstDay, today).first<UsageCountRow>(),
  ]);

  return {
    app: {
      id: app.id,
      name: app.name,
      publicVapidKey: app.vapidPublicKey,
      createdAt: app.createdAt,
    },
    profile,
    subscriptions: {
      active: subscriptionCount,
      xmtpRegistrations: Number(xmtp?.registrations ?? 0),
    },
    xmtp: {
      groupTopics: Number(xmtp?.group_topics ?? 0),
      welcomeTopics: Number(xmtp?.welcome_topics ?? 0),
      hmacEpochs: Number(xmtp?.hmac_epochs ?? 0),
    },
    usage: {
      todayUtc: usageCounts(todayUsage),
      last7DaysUtc: usageCounts(sevenDayUsage),
    },
    retentionDays: 8,
  };
}

export async function getPublicLeaderboard(
  db: D1Database,
  limit = 50
): Promise<LeaderboardEntry[]> {
  const today = utcDayOffset(0);
  const firstDay = utcDayOffset(-6);
  const verificationFreshAfter = new Date(
    Date.now() - APP_DOMAIN_VERIFICATION_FRESHNESS_MS
  ).toISOString();
  const result = await db.prepare(`
    WITH accepted AS (
      SELECT app_id, SUM(sent_count) AS sent
      FROM app_usage_daily
      WHERE day >= ? AND day <= ?
        AND event_type IN ('generic.push', 'xmtp.new_message')
      GROUP BY app_id
    )
    SELECT
      apps.id AS app_id,
      apps.name,
      profiles.description,
      profiles.domain,
      profiles.domain_verified_at,
      COALESCE(accepted.sent, 0) AS sent
    FROM app_public_profiles profiles
    JOIN apps ON apps.id = profiles.app_id
    LEFT JOIN accepted ON accepted.app_id = apps.id
    WHERE profiles.leaderboard_opt_in = 1
      AND profiles.domain_verification_status = 'verified'
      AND profiles.domain IS NOT NULL
      AND profiles.domain_verified_at IS NOT NULL
      AND profiles.domain_last_checked_at >= ?
      AND profiles.domain_verified_vapid_key = apps.vapid_public_key
    ORDER BY sent DESC, profiles.domain ASC, apps.id ASC
    LIMIT ?
  `).bind(firstDay, today, verificationFreshAfter, limit).all<{
    app_id: string;
    name: string;
    description: string;
    domain: string;
    domain_verified_at: string;
    sent: number;
  }>();

  return result.results.map((row, index) => ({
    rank: index + 1,
    appId: row.app_id,
    name: row.name,
    description: row.description,
    verifiedDomain: row.domain,
    domainVerifiedAt: row.domain_verified_at,
    providerAcceptedLast7Days: Number(row.sent),
  }));
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
      diagnosticBasePath?: string;
    } = {
      issueDiagnosticReceipt: true,
    }
  ): Promise<XmtpRegistrationResult> {
    const app = await this.resolveApp();
    if (!app) {
      throw new Error('XMTP VAPID app is not configured');
    }

    // Topic replacement is a transaction, but identity, endpoint, and logical
    // route writes intentionally span several D1 operations. Serialize the
    // global capacity decision before any of those mutations so a hard trigger
    // rejection cannot leave a partial registration behind. The per-app API
    // lock still protects subscription quotas; this lock closes cross-app
    // races against the singleton listener's total memory budget.
    const capacityLockToken = await acquireXmtpMutationLock(
      this.env.DB,
      XMTP_GLOBAL_CAPACITY_LOCK.appId,
      XMTP_GLOBAL_CAPACITY_LOCK.scope,
      XMTP_GLOBAL_CAPACITY_LOCK.resourceId
    );
    if (!capacityLockToken) {
      throw new Error('xmtp_global_capacity_limit: capacity mutation is busy');
    }

    try {
      await this.assertXmtpCapacity(app.id, input.installationId, input.topics);

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
        ...(diagnosticReceipt
          ? { diagnostics: diagnosticPaths(diagnosticReceipt, options.diagnosticBasePath) }
          : {}),
      };
    } finally {
      try {
        await releaseXmtpMutationLock(
          this.env.DB,
          XMTP_GLOBAL_CAPACITY_LOCK.appId,
          XMTP_GLOBAL_CAPACITY_LOCK.scope,
          XMTP_GLOBAL_CAPACITY_LOCK.resourceId,
          capacityLockToken
        );
      } catch (error) {
        console.error('xmtp_capacity_lock_release_failed', error);
      }
    }
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
        AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
    let deliveryAttemptId: string | undefined;
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
      deliveryAttemptId = await insertDeliveryAttempt(this.env.DB, {
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
      }, { contentType: 'json' });
      return true;
    } catch (error) {
      if (deliveryAttemptId) {
        // Release the idempotency claim only after the unpublished attempt and
        // its queued usage increment are atomically removed. If cleanup fails,
        // retaining the claim is safer than admitting a retry alongside stale
        // state for a job that never reached the Queue.
        await discardQueuedDeliveryAttempts(this.env.DB, [deliveryAttemptId]);
      }
      await this.env.DB.prepare('DELETE FROM xmtp_delivery_events WHERE id = ?').bind(eventId).run();
      throw error;
    }
  }

  private async assertXmtpCapacity(
    appId: string,
    installationId: string,
    topics: NormalizedXmtpRegistration['topics']
  ): Promise<void> {
    const requestedRows = topics.reduce(
      (count, topic) => count + 1 + topic.hmacKeys.length,
      0
    );
    const current = await this.env.DB.prepare(`
      SELECT
        COALESCE((
          SELECT row_count FROM xmtp_app_capacity WHERE app_id = ?
        ), 0) AS app_count,
        COALESCE((
          SELECT row_count FROM xmtp_global_capacity WHERE id = 1
        ), 0) AS global_count,
        (
          SELECT COUNT(*)
          FROM xmtp_topics topic
          JOIN xmtp_identities identity ON identity.id = topic.identity_id
          WHERE identity.app_id = ? AND identity.installation_id = ?
        ) + (
          SELECT COUNT(*)
          FROM xmtp_topic_hmac_keys hmac
          JOIN xmtp_topics topic ON topic.id = hmac.topic_id
          JOIN xmtp_identities identity ON identity.id = topic.identity_id
          WHERE identity.app_id = ? AND identity.installation_id = ?
        ) AS replaced_count
    `).bind(
      appId,
      appId,
      installationId,
      appId,
      installationId
    ).first<{ app_count: number; global_count: number; replaced_count: number }>();
    const replacedRows = Number(current?.replaced_count ?? 0);
    const projectedAppRows = Number(current?.app_count ?? 0) - replacedRows + requestedRows;
    const projectedGlobalRows = Number(current?.global_count ?? 0) - replacedRows + requestedRows;
    if (projectedAppRows > XMTP_APP_CAPACITY_ROWS) {
      throw new Error('xmtp_app_capacity_limit');
    }
    if (projectedGlobalRows > XMTP_GLOBAL_CAPACITY_ROWS) {
      throw new Error('xmtp_global_capacity_limit');
    }
  }

  private async upsertIdentity(input: NormalizedXmtpRegistration): Promise<{
    identityId: string;
    dirtyVersion: string;
  }> {
    const app = await this.resolveApp();
    if (!app) throw new Error('XMTP VAPID app is not configured');
    const existing = await this.env.DB.prepare(`
      SELECT id, inbox_id
      FROM xmtp_identities
      WHERE app_id = ? AND installation_id = ?
    `).bind(app.id, input.installationId).first<{ id: string; inbox_id: string }>();

    // An installation is a single listener route inside an app. Reject an
    // inbox mismatch before marking the route dirty or touching endpoint,
    // topic, or outbox state. The app-scoped lookup deliberately continues to
    // allow another app to register the same installation.
    if (existing && existing.inbox_id !== input.inboxId) {
      throw new XmtpInstallationIdentityConflictError();
    }

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
    try {
      await this.env.DB.prepare(`
        INSERT INTO xmtp_identities (id, app_id, inbox_id, installation_id, address, inbox_handle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, inbox_id, installation_id) DO UPDATE SET
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
    } catch (error) {
      // A concurrent first claim can race the read above. Migration 0006's
      // app/installation unique index rejects the loser; translate only that
      // now-observable inbox mismatch into the same stable 409 contract.
      const raced = await this.env.DB.prepare(`
        SELECT inbox_id FROM xmtp_identities
        WHERE app_id = ? AND installation_id = ?
      `).bind(app.id, input.installationId).first<{ inbox_id: string }>();
      if (raced && raced.inbox_id !== input.inboxId) {
        throw new XmtpInstallationIdentityConflictError();
      }
      throw error;
    }

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
  const timestamp = nowIso();
  const persistedPayload = input.eventType === 'vapid.diagnostic'
    && typeof input.payload.testId === 'string'
    ? { testId: input.payload.testId }
    : {};
  await db.batch([
    db.prepare(`
      INSERT INTO delivery_attempts (
        id, app_id, subscription_id, xmtp_subscription_id,
        xmtp_topic_id, event_type, status, payload_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).bind(
      id,
      input.appId,
      input.subscriptionId,
      input.xmtpSubscriptionId ?? null,
      input.xmtpTopicId ?? null,
      input.eventType,
      JSON.stringify(persistedPayload),
      timestamp,
      timestamp
    ),
    db.prepare(`
      INSERT INTO app_usage_daily (app_id, day, event_type, queued_count, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET
        queued_count = queued_count + 1,
        updated_at = excluded.updated_at
    `).bind(input.appId, timestamp.slice(0, 10), input.eventType, timestamp),
  ]);
  return id;
}

export async function discardQueuedDeliveryAttempts(
  db: D1Database,
  ids: string[]
): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;

  const chunks: string[][] = [];
  const groupedCounts = new Map<string, {
    appId: string;
    day: string;
    eventType: string;
    count: number;
  }>();
  for (let index = 0; index < uniqueIds.length; index += 99) {
    const chunk = uniqueIds.slice(index, index + 99);
    chunks.push(chunk);
    const placeholders = chunk.map(() => '?').join(', ');
    const groups = await db.prepare(`
      SELECT
        app_id,
        substr(created_at, 1, 10) AS day,
        event_type,
        COUNT(*) AS count
      FROM delivery_attempts
      WHERE status = 'queued' AND id IN (${placeholders})
      GROUP BY app_id, substr(created_at, 1, 10), event_type
    `).bind(...chunk).all<{
      app_id: string;
      day: string;
      event_type: string;
      count: number;
    }>();
    for (const group of groups.results) {
      const key = `${group.app_id}\u0000${group.day}\u0000${group.event_type}`;
      const current = groupedCounts.get(key);
      groupedCounts.set(key, {
        appId: group.app_id,
        day: group.day,
        eventType: group.event_type,
        count: (current?.count ?? 0) + Number(group.count),
      });
    }
  }

  const timestamp = nowIso();
  await db.batch([
    ...[...groupedCounts.values()].map((group) => db.prepare(`
        UPDATE app_usage_daily
        SET queued_count = MAX(0, queued_count - ?), updated_at = ?
        WHERE app_id = ? AND day = ? AND event_type = ?
      `).bind(group.count, timestamp, group.appId, group.day, group.eventType)),
    ...chunks.map((chunk) => {
      const placeholders = chunk.map(() => '?').join(', ');
      return db.prepare(`
        DELETE FROM delivery_attempts
        WHERE status = 'queued' AND id IN (${placeholders})
      `).bind(...chunk);
    }),
  ]);
}

export async function getPushJobContext(
  db: D1Database,
  job: PushQueueJob
): Promise<{ app: AppRecord; subscription: SubscriptionRecord } | null> {
  const [app, subscriptionRow] = await Promise.all([
    getAppById(db, job.appId),
    db.prepare(`
      SELECT * FROM subscriptions
      WHERE id = ? AND app_id = ? AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `)
      .bind(job.subscriptionId, job.appId)
      .first<SubscriptionRow>(),
  ]);

  if (!app || !subscriptionRow) return null;
  return { app, subscription: mapSubscription(subscriptionRow) };
}

const PUSH_DELIVERY_LEASE_MS = 4 * 60_000;
const MIN_PUSH_LEASE_RETRY_SECONDS = 30;
const MAX_PUSH_LEASE_RETRY_SECONDS = 300;

export type PushDeliveryAttemptClaim =
  | { outcome: 'claimed'; generation: number }
  | { outcome: 'busy'; retryAfterSeconds: number }
  | { outcome: 'ignored'; terminalStatus?: 'sent' | 'failed' | 'expired' };

/**
 * Atomically validates and leases one queued delivery attempt. `attempts` is
 * the lease generation, while `updated_at` is its expiry clock. A stale worker
 * can therefore neither release nor complete a generation reclaimed after its
 * lease expires.
 */
export async function claimPushDeliveryAttempt(
  db: D1Database,
  job: PushQueueJob
): Promise<PushDeliveryAttemptClaim> {
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - PUSH_DELIVERY_LEASE_MS).toISOString();
  const claimed = await db.prepare(`
    UPDATE delivery_attempts
    SET status = 'processing',
        attempts = attempts + 1,
        updated_at = ?
    WHERE id = ? AND app_id = ? AND subscription_id = ?
      AND (
        status = 'queued'
        OR (status = 'processing' AND updated_at <= ?)
      )
    RETURNING attempts
  `).bind(
    claimedAt,
    job.deliveryAttemptId,
    job.appId,
    job.subscriptionId,
    staleBefore
  ).first<{ attempts: number }>();

  if (claimed) {
    return { outcome: 'claimed', generation: Number(claimed.attempts) };
  }

  const row = await db.prepare(`
    SELECT app_id, subscription_id, status, updated_at
    FROM delivery_attempts
    WHERE id = ?
  `).bind(job.deliveryAttemptId).first<{
    app_id: string;
    subscription_id: string;
    status: string;
    updated_at: string;
  }>();

  if (!row || row.app_id !== job.appId || row.subscription_id !== job.subscriptionId) {
    return { outcome: 'ignored' };
  }
  if (row.status === 'processing') {
    const leaseExpiresAt = Date.parse(row.updated_at) + PUSH_DELIVERY_LEASE_MS;
    const remainingSeconds = Number.isFinite(leaseExpiresAt)
      ? Math.ceil((leaseExpiresAt - Date.now()) / 1000)
      : MIN_PUSH_LEASE_RETRY_SECONDS;
    return {
      outcome: 'busy',
      retryAfterSeconds: Math.max(
        MIN_PUSH_LEASE_RETRY_SECONDS,
        Math.min(MAX_PUSH_LEASE_RETRY_SECONDS, remainingSeconds)
      ),
    };
  }
  if (row.status === 'queued') {
    // The row changed between the failed compare-and-swap and this read. Retry
    // the Queue message instead of losing an otherwise eligible attempt.
    return { outcome: 'busy', retryAfterSeconds: MIN_PUSH_LEASE_RETRY_SECONDS };
  }
  if (row.status === 'sent' || row.status === 'failed' || row.status === 'expired') {
    return { outcome: 'ignored', terminalStatus: row.status };
  }
  return { outcome: 'ignored' };
}

function deliveryAttemptErrorCategory(
  status: 'queued' | 'sent' | 'failed' | 'expired',
  pushStatus?: number
): string | null {
  if (status === 'expired') return 'subscription_expired';
  if (status !== 'failed') return null;
  if (pushStatus === 429) return 'provider_rate_limited';
  if (pushStatus !== undefined && pushStatus >= 500) return 'provider_unavailable';
  if (pushStatus !== undefined && pushStatus >= 400) return 'provider_rejected';
  return 'relay_failure';
}

/** Release only the generation that observed the retryable provider failure. */
export async function releasePushDeliveryAttempt(
  db: D1Database,
  job: PushQueueJob,
  generation: number,
  pushStatus?: number
): Promise<boolean> {
  const timestamp = nowIso();
  const predicate = `
    id = ? AND app_id = ? AND subscription_id = ?
    AND status = 'processing' AND attempts = ?
  `;
  const results = await db.batch([
    db.prepare(`
      INSERT INTO app_usage_daily (app_id, day, event_type, failed_count, updated_at)
      SELECT app_id, ?, event_type, 1, ?
      FROM delivery_attempts
      WHERE ${predicate}
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET
        failed_count = failed_count + 1,
        updated_at = excluded.updated_at
    `).bind(
      timestamp.slice(0, 10),
      timestamp,
      job.deliveryAttemptId,
      job.appId,
      job.subscriptionId,
      generation
    ),
    db.prepare(`
      UPDATE delivery_attempts
      SET status = 'queued',
          last_error = ?,
          push_status = ?,
          updated_at = ?
      WHERE ${predicate}
    `).bind(
      deliveryAttemptErrorCategory('failed', pushStatus),
      pushStatus ?? null,
      timestamp,
      job.deliveryAttemptId,
      job.appId,
      job.subscriptionId,
      generation
    ),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

/**
 * Records a terminal outcome exactly once for the owning lease generation.
 * Generic attempts may be deleted in the same transaction after their daily
 * aggregate is updated; a stale Queue replay then observes a missing attempt.
 */
export async function completePushDeliveryAttempt(
  db: D1Database,
  job: PushQueueJob,
  generation: number,
  update: {
    status: 'sent' | 'failed' | 'expired';
    pushStatus?: number;
    deleteAttempt?: boolean;
  }
): Promise<boolean> {
  const timestamp = nowIso();
  const usageColumn = update.status === 'sent'
    ? 'sent_count'
    : update.status === 'failed'
      ? 'failed_count'
      : 'expired_count';
  const predicate = `
    id = ? AND app_id = ? AND subscription_id = ?
    AND status = 'processing' AND attempts = ?
  `;
  const mutation = update.deleteAttempt
    ? db.prepare(`DELETE FROM delivery_attempts WHERE ${predicate}`).bind(
        job.deliveryAttemptId,
        job.appId,
        job.subscriptionId,
        generation
      )
    : db.prepare(`
        UPDATE delivery_attempts
        SET status = ?,
            last_error = ?,
            push_status = ?,
            updated_at = ?
        WHERE ${predicate}
      `).bind(
        update.status,
        deliveryAttemptErrorCategory(update.status, update.pushStatus),
        update.pushStatus ?? null,
        timestamp,
        job.deliveryAttemptId,
        job.appId,
        job.subscriptionId,
        generation
      );
  const results = await db.batch([
    db.prepare(`
      INSERT INTO app_usage_daily (app_id, day, event_type, ${usageColumn}, updated_at)
      SELECT app_id, ?, event_type, 1, ?
      FROM delivery_attempts
      WHERE ${predicate}
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET
        ${usageColumn} = ${usageColumn} + 1,
        updated_at = excluded.updated_at
    `).bind(
      timestamp.slice(0, 10),
      timestamp,
      job.deliveryAttemptId,
      job.appId,
      job.subscriptionId,
      generation
    ),
    mutation,
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

const STALE_PUSH_ATTEMPT_AGE_MS = 2 * 60 * 60_000;
const STALE_PUSH_ATTEMPT_LIMIT = 5_000;

/**
 * Reconcile source messages that aged out without another consumer invocation.
 * The two-hour boundary exceeds the one-hour source Queue retention by a grace
 * period. Selection, aggregate increments, and terminal transitions share one
 * D1 batch transaction, so repeated cron runs count each row at most once.
 */
export async function reconcileStalePushDeliveryAttempts(
  db: D1Database,
  options: { before?: string; limit?: number } = {}
): Promise<{ reconciled: number }> {
  const timestamp = nowIso();
  const before = options.before
    ?? new Date(Date.now() - STALE_PUSH_ATTEMPT_AGE_MS).toISOString();
  const limit = Math.max(
    1,
    Math.min(STALE_PUSH_ATTEMPT_LIMIT, Math.floor(options.limit ?? STALE_PUSH_ATTEMPT_LIMIT))
  );
  const staleSelection = `
    SELECT id
    FROM delivery_attempts
    WHERE status IN ('queued', 'processing') AND updated_at <= ?
    ORDER BY updated_at, id
    LIMIT ?
  `;
  const results = await db.batch([
    db.prepare(`
      UPDATE delivery_attempts
      SET status = 'reconciling', updated_at = ?
      WHERE id IN (${staleSelection})
    `).bind(timestamp, before, limit),
    db.prepare(`
      INSERT INTO app_usage_daily (
        app_id, day, event_type, failed_count, updated_at
      )
      SELECT attempts.app_id, ?, attempts.event_type, COUNT(*), ?
      FROM delivery_attempts attempts
      WHERE attempts.status = 'reconciling' AND attempts.updated_at = ?
      GROUP BY attempts.app_id, attempts.event_type
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET
        failed_count = failed_count + excluded.failed_count,
        updated_at = excluded.updated_at
    `).bind(timestamp.slice(0, 10), timestamp, timestamp),
    db.prepare(`
      DELETE FROM delivery_attempts
      WHERE status = 'reconciling' AND updated_at = ?
        AND event_type = 'generic.push'
    `).bind(timestamp),
    db.prepare(`
      UPDATE delivery_attempts
      SET status = 'failed',
          last_error = 'relay_failure',
          push_status = NULL,
          updated_at = ?
      WHERE status = 'reconciling' AND updated_at = ?
    `).bind(timestamp, timestamp),
  ]);
  return { reconciled: Number(results[0]?.meta.changes ?? 0) };
}

export async function updateDeliveryAttempt(
  db: D1Database,
  id: string,
  update: { status: 'queued' | 'sent' | 'failed' | 'expired'; error?: string; pushStatus?: number }
): Promise<void> {
  const timestamp = nowIso();
  const errorCategory = deliveryAttemptErrorCategory(update.status, update.pushStatus);
  const usageColumn = update.status === 'sent'
    ? 'sent_count'
    : update.status === 'failed'
      ? 'failed_count'
      : update.status === 'expired'
        ? 'expired_count'
        : null;
  const transitionPredicate = "status NOT IN ('sent', 'expired')";
  const statements: D1PreparedStatement[] = [];
  if (usageColumn) {
    statements.push(db.prepare(`
      INSERT INTO app_usage_daily (app_id, day, event_type, ${usageColumn}, updated_at)
      SELECT app_id, ?, event_type, 1, ?
      FROM delivery_attempts
      WHERE id = ? AND ${transitionPredicate}
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET
        ${usageColumn} = ${usageColumn} + 1,
        updated_at = excluded.updated_at
    `).bind(timestamp.slice(0, 10), timestamp, id));
  }
  statements.push(db.prepare(`
      UPDATE delivery_attempts
      SET status = ?,
          attempts = attempts + 1,
          last_error = ?,
          push_status = ?,
          updated_at = ?
      WHERE id = ? AND ${transitionPredicate}
    `).bind(update.status, errorCategory, update.pushStatus ?? null, timestamp, id));
  await db.batch(statements);
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
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  return acquireXmtpMutationLock(
    db,
    appId,
    '__xmtp_installation__',
    input.installationId
  );
}

async function acquireXmtpMutationLock(
  db: D1Database,
  appId: string,
  lockScope: string,
  resourceId: string
): Promise<string | null> {
  const lockToken = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`
    DELETE FROM xmtp_registration_mutation_locks
    WHERE app_id = ? AND inbox_id = ? AND installation_id = ? AND expires_at <= ?
  `).bind(appId, lockScope, resourceId, now).run();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO xmtp_registration_mutation_locks (
      app_id, inbox_id, installation_id, lock_token, expires_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    appId,
    lockScope,
    resourceId,
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
  return releaseXmtpMutationLock(
    db,
    appId,
    '__xmtp_installation__',
    input.installationId,
    lockToken
  );
}

async function releaseXmtpMutationLock(
  db: D1Database,
  appId: string,
  lockScope: string,
  resourceId: string,
  lockToken: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM xmtp_registration_mutation_locks
    WHERE app_id = ? AND inbox_id = ? AND installation_id = ? AND lock_token = ?
  `).bind(appId, lockScope, resourceId, lockToken).run();
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
  const input = await endpointMutationLockInput(endpoint);
  return acquireXmtpMutationLock(
    db,
    appId,
    input.inboxId,
    input.installationId
  );
}

export async function releaseXmtpEndpointMutationLock(
  db: D1Database,
  appId: string,
  endpoint: string,
  lockToken: string
): Promise<void> {
  const input = await endpointMutationLockInput(endpoint);
  return releaseXmtpMutationLock(
    db,
    appId,
    input.inboxId,
    input.installationId,
    lockToken
  );
}

const APP_SUBSCRIPTION_MUTATION_LOCK = {
  inboxId: '__app_subscription_quota__',
  installationId: '__all__',
};

export async function acquireAppSubscriptionMutationLock(
  db: D1Database,
  appId: string
): Promise<string | null> {
  return acquireXmtpRegistrationMutationLock(
    db,
    appId,
    APP_SUBSCRIPTION_MUTATION_LOCK
  );
}

export async function releaseAppSubscriptionMutationLock(
  db: D1Database,
  appId: string,
  lockToken: string
): Promise<void> {
  return releaseXmtpRegistrationMutationLock(
    db,
    appId,
    APP_SUBSCRIPTION_MUTATION_LOCK,
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

// The public relay admits at most 2,000 provider attempts per minute and
// 100,000 per UTC day. A 5,000-row maintenance batch drains the maximum
// sustained eligible arrival rate while remaining explicitly bounded.
const OPERATIONAL_COMPACTION_BATCH_SIZE = 5_000;

export interface ExpiredSubscriptionCompactionResult {
  deletedGenericSubscriptions: number;
  deletedXmtpSubscription: boolean;
  backlogLikely: boolean;
  oldestExpiredAt?: string;
}

export async function compactExpiredSubscriptions(
  db: D1Database
): Promise<ExpiredSubscriptionCompactionResult> {
  const timestamp = nowIso();
  const generic = await db.prepare(`
    DELETE FROM subscriptions WHERE id IN (
      SELECT subscription.id
      FROM subscriptions subscription
      WHERE subscription.disabled_at IS NULL
        AND subscription.expires_at IS NOT NULL
        AND subscription.expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM xmtp_subscriptions registration
          WHERE registration.subscription_id = subscription.id
            AND registration.active = 1
        )
      ORDER BY subscription.expires_at
      LIMIT ?
    )
  `).bind(timestamp, OPERATIONAL_COMPACTION_BATCH_SIZE).run();

  const candidate = await db.prepare(`
    SELECT subscription.id, subscription.app_id
    FROM subscriptions subscription
    WHERE subscription.disabled_at IS NULL
      AND subscription.expires_at IS NOT NULL
      AND subscription.expires_at <= ?
      AND EXISTS (
        SELECT 1 FROM xmtp_subscriptions registration
        WHERE registration.subscription_id = subscription.id AND registration.active = 1
      )
    ORDER BY subscription.expires_at
    LIMIT 1
  `).bind(timestamp).first<{ id: string; app_id: string }>();

  let deletedXmtpSubscription = false;
  if (candidate) {
    const lockToken = await acquireAppSubscriptionMutationLock(db, candidate.app_id);
    if (lockToken) {
      try {
        const stillExpired = await db.prepare(`
          SELECT 1 AS present FROM subscriptions
          WHERE id = ? AND app_id = ? AND disabled_at IS NULL
            AND expires_at IS NOT NULL AND expires_at <= ?
        `).bind(candidate.id, candidate.app_id, nowIso()).first<{ present: number }>();
        if (stillExpired) {
          await disableSubscription(db, candidate.id);
          deletedXmtpSubscription = true;
        }
      } finally {
        await releaseAppSubscriptionMutationLock(db, candidate.app_id, lockToken);
      }
    }
  }

  const remaining = await db.prepare(`
    SELECT MIN(expires_at) AS oldest
    FROM subscriptions
    WHERE disabled_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
  `).bind(nowIso()).first<{ oldest: string | null }>();
  const backlogLikely = Number(generic.meta.changes ?? 0) >= OPERATIONAL_COMPACTION_BATCH_SIZE
    || Boolean(remaining?.oldest);

  return {
    deletedGenericSubscriptions: Number(generic.meta.changes ?? 0),
    deletedXmtpSubscription,
    backlogLikely,
    ...(remaining?.oldest ? { oldestExpiredAt: remaining.oldest } : {}),
  };
}

export interface OperationalCompactionResult {
  batchLimit: number;
  deletedRows: number;
  backlogLikely: boolean;
  oldestEligibleAt?: string;
}

export async function compactOperationalHistory(
  db: D1Database
): Promise<OperationalCompactionResult> {
  const rateLimitBefore = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const diagnosticBefore = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const deliveryBefore = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const usageBeforeDay = utcDayOffset(-7);

  const results = await db.batch([
    db.prepare(`
      DELETE FROM rate_limit_logs WHERE rowid IN (
        SELECT rowid FROM rate_limit_logs
        WHERE window_start < ? ORDER BY window_start LIMIT ?
      )
    `).bind(rateLimitBefore, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM public_rate_limits WHERE rowid IN (
        SELECT rowid FROM public_rate_limits
        WHERE created_at < ? ORDER BY created_at LIMIT ?
      )
    `).bind(rateLimitBefore, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM delivery_attempts WHERE rowid IN (
        SELECT rowid FROM delivery_attempts
        WHERE event_type = 'vapid.diagnostic' AND created_at < ?
        ORDER BY created_at LIMIT ?
      )
    `).bind(diagnosticBefore, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM delivery_attempts WHERE rowid IN (
        SELECT rowid FROM delivery_attempts
        WHERE event_type <> 'vapid.diagnostic' AND created_at < ?
        ORDER BY created_at LIMIT ?
      )
    `).bind(deliveryBefore, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM xmtp_delivery_events WHERE rowid IN (
        SELECT rowid FROM xmtp_delivery_events
        WHERE created_at < ? ORDER BY created_at LIMIT ?
      )
    `).bind(deliveryBefore, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM app_usage_daily WHERE rowid IN (
        SELECT rowid FROM app_usage_daily
        WHERE day < ? ORDER BY day LIMIT ?
      )
    `).bind(usageBeforeDay, OPERATIONAL_COMPACTION_BATCH_SIZE),
    db.prepare(`
      DELETE FROM xmtp_registration_mutation_locks WHERE rowid IN (
        SELECT rowid FROM xmtp_registration_mutation_locks
        WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      )
    `).bind(nowIso(), OPERATIONAL_COMPACTION_BATCH_SIZE),
  ]);

  const changes = results.map((result) => Number(result.meta.changes ?? 0));
  const backlogLikely = changes.some((count) => count >= OPERATIONAL_COMPACTION_BATCH_SIZE);
  let oldestEligibleAt: string | undefined;
  if (backlogLikely) {
    // Keep these as separate bounded statements. Workerd's SQLite compiler can
    // reject a compound aggregate after a large trigger-heavy delete even when
    // the UNION itself is small.
    const oldestResults = await db.batch([
      db.prepare(`
        SELECT MIN(window_start) AS candidate FROM rate_limit_logs WHERE window_start < ?
      `).bind(rateLimitBefore),
      db.prepare(`
        SELECT MIN(created_at) AS candidate FROM public_rate_limits WHERE created_at < ?
      `).bind(rateLimitBefore),
      db.prepare(`
        SELECT MIN(created_at) AS candidate FROM delivery_attempts
        WHERE event_type = 'vapid.diagnostic' AND created_at < ?
      `).bind(diagnosticBefore),
      db.prepare(`
        SELECT MIN(created_at) AS candidate FROM delivery_attempts
        WHERE event_type <> 'vapid.diagnostic' AND created_at < ?
      `).bind(deliveryBefore),
      db.prepare(`
        SELECT MIN(created_at) AS candidate FROM xmtp_delivery_events WHERE created_at < ?
      `).bind(deliveryBefore),
      db.prepare(`
        SELECT MIN(day) AS candidate FROM app_usage_daily WHERE day < ?
      `).bind(usageBeforeDay),
      db.prepare(`
        SELECT MIN(expires_at) AS candidate FROM xmtp_registration_mutation_locks
        WHERE expires_at <= ?
      `).bind(nowIso()),
    ]);
    oldestEligibleAt = oldestResults
      .flatMap((result) => result.results as Array<{ candidate: string | null }>)
      .map((row) => row.candidate)
      .filter((candidate): candidate is string => Boolean(candidate))
      .sort()[0];
  }

  return {
    batchLimit: OPERATIONAL_COMPACTION_BATCH_SIZE,
    deletedRows: changes.reduce((total, count) => total + count, 0),
    backlogLikely,
    ...(oldestEligibleAt ? { oldestEligibleAt } : {}),
  };
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
      AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

  // `processing` is an internal Queue lease state, not part of the public
  // diagnostics contract. Expose it as queued while the provider call is in
  // flight or while a crashed consumer's lease waits to expire.
  const status = row.status === 'processing' ? 'queued' : row.status;

  return {
    status,
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
  receipt: string,
  expectedAppId?: string
): Promise<Record<string, unknown> | null> {
  const registration = await findXmtpDiagnosticRegistration(env.DB, receipt);
  if (!registration || (expectedAppId && registration.app_id !== expectedAppId)) return null;

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
  scopedRateLimitAction?: string,
  expectedAppId?: string
): Promise<{ queued: true; testId: string; checkedAt: string } | null> {
  const registration = await findXmtpDiagnosticRegistration(env.DB, receipt);
  if (!registration || (expectedAppId && registration.app_id !== expectedAppId)) return null;

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
