import { base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './encoding';
import type {
  XmtpListenerRegistration,
  XmtpListenerTopic,
} from './types';
import type { XmtpListenerStatusInput } from './schemas';

const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 10;
const HEARTBEAT_FRESH_MS = 3 * 60_000;
const ACTIVE_CONSUMER_MS = 10 * 60_000;
const CHANGE_RETENTION_MS = 24 * 60 * 60_000;

interface InstallationRow {
  app_id: string;
  installation_id: string;
  delivery_token: string;
}

interface TopicRow {
  app_id: string;
  installation_id: string;
  topic: string;
  epoch: string | null;
  hmac_key: string | null;
}

interface ChangeRow {
  sequence: number;
  app_id: string;
  installation_id: string;
  delivery_token: string;
}

interface ConsumerRow {
  ready: number;
  cursor: number;
  error_code: string | null;
  observed_at: string;
  updated_at: string;
  stream_connected_at: string | null;
  last_envelope_at: string | null;
  last_control_sync_at: string | null;
}

interface SnapshotPageToken {
  version: 1;
  cursor: string;
  lastAppId: string;
  lastInstallationId: string;
}

export interface XmtpListenerSnapshot {
  version: 1;
  cursor: string;
  registrations: XmtpListenerRegistration[];
  nextPageToken?: string;
}

export interface XmtpListenerDelta {
  sequence: string;
  appId: string;
  installationId: string;
  deliveryToken: string;
  registration: XmtpListenerRegistration | null;
}

export interface XmtpListenerDeltas {
  version: 1;
  cursor: string;
  hasMore: boolean;
  changes: XmtpListenerDelta[];
}

export interface XmtpListenerHealth {
  deliveryReady: boolean;
  capacity?: {
    topicAndHmacRows: number;
    maxTopicAndHmacRows: number;
    maxTopicAndHmacRowsPerApp: number;
  };
  listener: {
    configured: boolean;
    status: 'ready' | 'not_ready' | 'not_configured' | 'unknown';
    lastCheckedAt?: string;
    streamConnectedAt?: string;
    lastEnvelopeAt?: string;
  };
  bridge: {
    status: 'synced' | 'pending' | 'failed' | 'not_configured';
    pendingRegistrationCount: number;
    failedRegistrationCount: number;
    lastSuccessfulSyncAt?: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseCursor(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative integer`);
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error(`${field} exceeds the supported range`);
  return cursor;
}

export function parseListenerPageLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) throw new Error('limit must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return parsed;
}

function capListenerPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('limit must be a positive safe integer');
  }
  return Math.min(value, MAX_PAGE_LIMIT);
}

function encodePageToken(token: SnapshotPageToken): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(token)));
}

function decodePageToken(value: string): SnapshotPageToken {
  const bytes = base64UrlToBytes(value);
  if (!bytes) throw new Error('pageToken is invalid');
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SnapshotPageToken>;
    if (
      parsed.version !== 1 ||
      typeof parsed.cursor !== 'string' ||
      !/^\d+$/.test(parsed.cursor) ||
      typeof parsed.lastAppId !== 'string' ||
      parsed.lastAppId.length === 0 ||
      parsed.lastAppId.length > 255 ||
      typeof parsed.lastInstallationId !== 'string' ||
      parsed.lastInstallationId.length === 0 ||
      parsed.lastInstallationId.length > 255
    ) {
      throw new Error('invalid shape');
    }
    return parsed as SnapshotPageToken;
  } catch {
    throw new Error('pageToken is invalid');
  }
}

async function getLatestSequence(db: D1Database): Promise<number> {
  const row = await db.prepare(
    'SELECT latest_sequence FROM xmtp_listener_meta WHERE id = 1'
  ).first<{ latest_sequence: number }>();
  return row?.latest_sequence ?? 0;
}

function standardBase64(input: string): string | null {
  const bytes = base64UrlToBytes(input);
  // Never let one malformed legacy row poison the singleton listener's full
  // snapshot. Migration 0006 and request validation enforce the same bound for
  // new writes; this remains a defense-in-depth control-plane filter.
  if (!bytes || bytes.length < 1 || bytes.length > 256) return null;
  return bytesToBase64(bytes);
}

function hmacEpoch(input: string): number | null {
  if (!/^\d+$/.test(input)) return null;
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    return null;
  }
  return value;
}

async function loadRegistrations(
  db: D1Database,
  routes: Array<{ appId: string; installationId: string }>
): Promise<Map<string, XmtpListenerRegistration>> {
  if (routes.length === 0) return new Map();

  const uniqueRoutes = [...new Map(routes.map((route) => [
    `${route.appId}\u0000${route.installationId}`,
    route,
  ])).values()];
  const allowedRoutes = new Set(
    uniqueRoutes.map((route) => `${route.appId}\u0000${route.installationId}`)
  );
  const routeChunks: typeof uniqueRoutes[] = [];
  // Each pair uses two bindings; 50 pairs stays at D1's 100-parameter limit.
  for (let index = 0; index < uniqueRoutes.length; index += 50) {
    routeChunks.push(uniqueRoutes.slice(index, index + 50));
  }
  const loaded = await Promise.all(routeChunks.map(async (chunk) => {
    const installationClause = chunk
      .map(() => '(li.app_id = ? AND li.installation_id = ?)')
      .join(' OR ');
    const topicClause = chunk
      .map(() => '(xi.app_id = ? AND xi.installation_id = ?)')
      .join(' OR ');
    const values = chunk.flatMap((route) => [route.appId, route.installationId]);
    const [installations, topics] = await Promise.all([
      db.prepare(`
        SELECT li.app_id, li.installation_id, li.delivery_token
        FROM xmtp_listener_installations li
        WHERE (${installationClause})
          AND EXISTS (
            SELECT 1
            FROM xmtp_identities xi
            JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
            JOIN subscriptions s ON s.id = xs.subscription_id
              AND s.disabled_at IS NULL
              AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE xi.app_id = li.app_id AND xi.installation_id = li.installation_id
          )
      `).bind(...values).all<InstallationRow>(),
      db.prepare(`
        SELECT DISTINCT
          xi.installation_id,
          xi.app_id,
          xt.topic,
          hk.epoch,
          hk.hmac_key
        FROM xmtp_identities xi
        JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
        JOIN subscriptions s ON s.id = xs.subscription_id
          AND s.disabled_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        JOIN xmtp_topics xt ON xt.identity_id = xi.id
        LEFT JOIN xmtp_topic_hmac_keys hk ON hk.topic_id = xt.id
        WHERE (${topicClause})
        ORDER BY xi.app_id, xi.installation_id, xt.topic, hk.epoch
      `).bind(...values).all<TopicRow>(),
    ]);
    return { installations: installations.results, topics: topics.results };
  }));
  const installationRows = loaded.flatMap((chunk) => chunk.installations);
  const topicRows = loaded.flatMap((chunk) => chunk.topics);

  const registrations = new Map<string, XmtpListenerRegistration>();
  for (const row of installationRows) {
    const key = `${row.app_id}\u0000${row.installation_id}`;
    if (!allowedRoutes.has(key)) continue;
    registrations.set(key, {
      appId: row.app_id,
      installationId: row.installation_id,
      deliveryToken: row.delivery_token,
      topics: [],
    });
  }

  const topicMaps = new Map<string, Map<string, XmtpListenerTopic>>();
  for (const row of topicRows) {
    const routeKey = `${row.app_id}\u0000${row.installation_id}`;
    if (!allowedRoutes.has(routeKey)) continue;
    const registration = registrations.get(routeKey);
    if (!registration) continue;

    let byTopic = topicMaps.get(routeKey);
    if (!byTopic) {
      byTopic = new Map();
      topicMaps.set(routeKey, byTopic);
    }
    let topic = byTopic.get(row.topic);
    if (!topic) {
      topic = { topic: row.topic, isSilent: false, hmacKeys: [] };
      byTopic.set(row.topic, topic);
      registration.topics.push(topic);
    }

    if (row.epoch !== null && row.hmac_key !== null) {
      const epoch = hmacEpoch(row.epoch);
      if (epoch === null) continue;
      const encodedKey = standardBase64(row.hmac_key);
      if (!encodedKey) continue;
      const key = {
        thirtyDayPeriodsSinceEpoch: epoch,
        key: encodedKey,
      };
      if (!topic.hmacKeys.some(
        (candidate) => candidate.thirtyDayPeriodsSinceEpoch === key.thirtyDayPeriodsSinceEpoch &&
          candidate.key === key.key
      )) {
        topic.hmacKeys.push(key);
      }
    }
  }

  for (const [routeKey, registration] of registrations) {
    registration.topics = registration.topics.filter(
      (topic) => topic.topic.startsWith('/xmtp/mls/1/w-') || topic.hmacKeys.length > 0
    );
    if (registration.topics.length === 0) registrations.delete(routeKey);
  }

  return registrations;
}

export async function recordXmtpListenerChange(
  db: D1Database,
  appId: string,
  installationId: string,
  reason: 'registration-upserted' | 'registration-deleted',
  dirtyVersion?: string
): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO xmtp_listener_installations (app_id, installation_id, delivery_token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(app_id, installation_id) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(appId, installationId, crypto.randomUUID(), nowIso()),
    db.prepare(`
      INSERT INTO xmtp_listener_changes (app_id, installation_id, reason)
      VALUES (?, ?, ?)
    `).bind(appId, installationId, reason),
    db.prepare(`
      UPDATE xmtp_listener_meta
      SET latest_sequence = COALESCE((SELECT MAX(sequence) FROM xmtp_listener_changes), latest_sequence),
          updated_at = ?
      WHERE id = 1
    `).bind(nowIso()),
    dirtyVersion
      ? db.prepare(`
          DELETE FROM xmtp_listener_dirty_routes
          WHERE app_id = ? AND installation_id = ? AND version = ?
        `).bind(appId, installationId, dirtyVersion)
      : db.prepare(`
          DELETE FROM xmtp_listener_dirty_routes
          WHERE app_id = ? AND installation_id = ?
        `).bind(appId, installationId),
  ]);
}

export async function markXmtpListenerRouteDirty(
  db: D1Database,
  appId: string,
  installationId: string
): Promise<string> {
  const version = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO xmtp_listener_dirty_routes (
      app_id, installation_id, version, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(app_id, installation_id) DO UPDATE SET
      version = excluded.version,
      updated_at = excluded.updated_at
  `).bind(appId, installationId, version, nowIso()).run();
  return version;
}

export async function reconcileXmtpListenerDirtyRoutes(
  db: D1Database,
  limit = 100
): Promise<number> {
  const dirty = await db.prepare(`
    SELECT app_id, installation_id, version
    FROM xmtp_listener_dirty_routes
    ORDER BY updated_at
    LIMIT ?
  `).bind(Math.max(1, Math.min(limit, 100))).all<{
    app_id: string;
    installation_id: string;
    version: string;
  }>();

  for (const route of dirty.results) {
    const active = await db.prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM xmtp_identities xi
        JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
        JOIN subscriptions s ON s.id = xs.subscription_id
          AND s.disabled_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE xi.app_id = ? AND xi.installation_id = ?
      ) AS active
    `).bind(route.app_id, route.installation_id).first<{ active: number }>();
    await recordXmtpListenerChange(
      db,
      route.app_id,
      route.installation_id,
      active?.active ? 'registration-upserted' : 'registration-deleted',
      route.version
    );
  }
  return dirty.results.length;
}

export async function getXmtpListenerSnapshot(
  db: D1Database,
  input: { limit: number; pageToken?: string }
): Promise<XmtpListenerSnapshot> {
  // Internal callers do not pass through the HTTP parser. Keep the D1 result
  // and the listener's atomic decode unit bounded even if one supplies an old
  // or overly generous limit.
  const limit = capListenerPageLimit(input.limit);
  const page = input.pageToken ? decodePageToken(input.pageToken) : undefined;
  const cursor = page ? parseCursor(page.cursor, 'pageToken cursor') : await getLatestSequence(db);
  const lastAppId = page?.lastAppId ?? '';
  const lastInstallationId = page?.lastInstallationId ?? '';

  const rows = await db.prepare(`
    SELECT DISTINCT li.app_id, li.installation_id, li.delivery_token
    FROM xmtp_listener_installations li
    JOIN xmtp_identities xi ON xi.app_id = li.app_id AND xi.installation_id = li.installation_id
    JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
    JOIN subscriptions s ON s.id = xs.subscription_id
      AND s.disabled_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE li.app_id > ? OR (li.app_id = ? AND li.installation_id > ?)
    ORDER BY li.app_id, li.installation_id
    LIMIT ?
  `).bind(lastAppId, lastAppId, lastInstallationId, limit + 1).all<InstallationRow>();

  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const registrations = await loadRegistrations(
    db,
    selected.map((row) => ({ appId: row.app_id, installationId: row.installation_id }))
  );
  const values = selected
    .map((row) => registrations.get(`${row.app_id}\u0000${row.installation_id}`))
    .filter((registration): registration is XmtpListenerRegistration => Boolean(registration));

  const last = selected.at(-1);
  return {
    version: 1,
    cursor: String(cursor),
    registrations: values,
    nextPageToken: hasMore && last
      ? encodePageToken({
          version: 1,
          cursor: String(cursor),
          lastAppId: last.app_id,
          lastInstallationId: last.installation_id,
        })
      : undefined,
  };
}

export async function getXmtpListenerDeltas(
  db: D1Database,
  input: { after: string; limit: number }
): Promise<XmtpListenerDeltas> {
  const limit = capListenerPageLimit(input.limit);
  const after = parseCursor(input.after, 'after');
  const result = await db.prepare(`
    SELECT c.sequence, c.app_id, c.installation_id, li.delivery_token
    FROM xmtp_listener_changes c
    JOIN xmtp_listener_installations li
      ON li.app_id = c.app_id AND li.installation_id = c.installation_id
    WHERE c.sequence > ?
    ORDER BY c.sequence
    LIMIT ?
  `).bind(after, limit + 1).all<ChangeRow>();

  const hasMore = result.results.length > limit;
  const selected = result.results.slice(0, limit);
  const latestByRoute = new Map<string, ChangeRow>();
  for (const row of selected) {
    latestByRoute.set(`${row.app_id}\u0000${row.installation_id}`, row);
  }

  const routes = [...latestByRoute.values()].map((row) => ({
    appId: row.app_id,
    installationId: row.installation_id,
  }));
  const registrations = await loadRegistrations(db, routes);
  const changes = [...latestByRoute.entries()]
    .map(([routeKey, row]) => ({
      sequence: String(row.sequence),
      appId: row.app_id,
      installationId: row.installation_id,
      deliveryToken: row.delivery_token,
      registration: registrations.get(routeKey) ?? null,
    }))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));

  return {
    version: 1,
    cursor: String(selected.at(-1)?.sequence ?? after),
    hasMore,
    changes,
  };
}

export async function saveXmtpListenerStatus(
  db: D1Database,
  input: XmtpListenerStatusInput
): Promise<{ cursor: string }> {
  const latest = await getLatestSequence(db);
  const cursor = Math.min(parseCursor(input.cursor, 'cursor'), latest);
  const ready = input.ready && input.deliveryReady === true;
  const errorCode = ready
    ? null
    : input.errorCode ?? (input.deliveryReady === true ? null : 'delivery_unavailable');
  await db.prepare(`
    INSERT INTO xmtp_listener_consumers (
      instance_id, ready, cursor, error_code, stream_connected_at,
      last_envelope_at, last_control_sync_at, registration_count,
      topic_count, observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      ready = excluded.ready,
      cursor = excluded.cursor,
      error_code = excluded.error_code,
      stream_connected_at = excluded.stream_connected_at,
      last_envelope_at = excluded.last_envelope_at,
      last_control_sync_at = excluded.last_control_sync_at,
      registration_count = excluded.registration_count,
      topic_count = excluded.topic_count,
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at
  `).bind(
    input.instanceId,
    ready ? 1 : 0,
    cursor,
    errorCode,
    input.streamConnectedAt ?? null,
    input.lastEnvelopeAt ?? null,
    input.lastControlSyncAt ?? null,
    input.registrationCount ?? null,
    input.topicCount ?? null,
    input.observedAt,
    nowIso()
  ).run();
  return { cursor: String(cursor) };
}

export async function getXmtpListenerHealth(
  db: D1Database,
  configured: boolean
): Promise<XmtpListenerHealth> {
  if (!configured) {
    return {
      deliveryReady: false,
      listener: { configured: false, status: 'not_configured' },
      bridge: {
        status: 'not_configured',
        pendingRegistrationCount: 0,
        failedRegistrationCount: 0,
      },
    };
  }

  const [latest, consumer, invalidRoutes, dirtyRoutes, capacity] = await Promise.all([
    getLatestSequence(db),
    db.prepare(`
      SELECT
        ready, cursor, error_code, observed_at, updated_at,
        stream_connected_at, last_envelope_at, last_control_sync_at
      FROM xmtp_listener_consumers
      ORDER BY updated_at DESC
      LIMIT 1
    `).first<ConsumerRow>(),
    db.prepare(`
      SELECT COUNT(DISTINCT xi.app_id || char(0) || xi.installation_id) AS count
      FROM xmtp_identities xi
      JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
      JOIN subscriptions s ON s.id = xs.subscription_id
        AND s.disabled_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      JOIN xmtp_topics xt ON xt.identity_id = xi.id
      JOIN xmtp_topic_hmac_keys hk ON hk.topic_id = xt.id
      WHERE hk.epoch = '' OR hk.epoch GLOB '*[^0-9]*'
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM xmtp_listener_dirty_routes
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT row_count FROM xmtp_global_capacity WHERE id = 1
    `).first<{ row_count: number }>(),
  ]);

  const fresh = consumer
    ? Date.now() - new Date(consumer.updated_at).getTime() <= HEARTBEAT_FRESH_MS
    : false;
  const appliedCursor = fresh ? consumer?.cursor ?? 0 : 0;
  const pending = await db.prepare(`
    SELECT COUNT(DISTINCT app_id || char(0) || installation_id) AS count
    FROM xmtp_listener_changes
    WHERE sequence > ?
  `).bind(appliedCursor).first<{ count: number }>();
  const pendingCount = Math.max(
    pending?.count ?? 0,
    appliedCursor < latest ? 1 : 0,
    dirtyRoutes?.count ?? 0
  );
  const failedCount = invalidRoutes?.count ?? 0;

  const listenerStatus = !fresh
    ? 'unknown' as const
    : consumer?.ready
      ? 'ready' as const
      : 'not_ready' as const;
  const bridgeStatus = !fresh
    ? 'pending' as const
    : consumer?.error_code || failedCount > 0
      ? 'failed' as const
      : pendingCount > 0 || (consumer?.cursor ?? 0) < latest
        ? 'pending' as const
        : 'synced' as const;
  const deliveryReady = listenerStatus === 'ready' && bridgeStatus === 'synced';

  return {
    deliveryReady,
    capacity: {
      topicAndHmacRows: capacity?.row_count ?? 0,
      maxTopicAndHmacRows: 25_000,
      maxTopicAndHmacRowsPerApp: 5_000,
    },
    listener: {
      configured: true,
      status: listenerStatus,
      lastCheckedAt: consumer?.updated_at,
      streamConnectedAt: consumer?.stream_connected_at ?? undefined,
      lastEnvelopeAt: consumer?.last_envelope_at ?? undefined,
    },
    bridge: {
      status: bridgeStatus,
      pendingRegistrationCount: pendingCount,
      failedRegistrationCount: failedCount,
      lastSuccessfulSyncAt: deliveryReady
        ? consumer?.last_control_sync_at ?? consumer?.updated_at
        : undefined,
    },
  };
}

export async function compactXmtpListenerChanges(db: D1Database): Promise<number> {
  await db.prepare(`
    DELETE FROM xmtp_listener_consumers
    WHERE updated_at < ?
  `).bind(new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()).run();

  const activeAfter = new Date(Date.now() - ACTIVE_CONSUMER_MS).toISOString();
  const consumer = await db.prepare(`
    SELECT MIN(cursor) AS cursor
    FROM xmtp_listener_consumers
    WHERE updated_at >= ?
  `).bind(activeAfter).first<{ cursor: number | null }>();
  if (consumer?.cursor === null || consumer?.cursor === undefined) return 0;

  const retentionBefore = new Date(Date.now() - CHANGE_RETENTION_MS).toISOString();

  // A route token is also carried on its deletion delta. Keep it until every
  // live listener has consumed that tombstone and the retention window passes.
  await db.prepare(`
    DELETE FROM xmtp_listener_installations
    WHERE (app_id, installation_id) IN (
      SELECT li.app_id, li.installation_id
      FROM xmtp_listener_installations li
      JOIN xmtp_listener_changes latest
        ON latest.app_id = li.app_id
       AND latest.installation_id = li.installation_id
       AND latest.sequence = (
         SELECT MAX(candidate.sequence)
         FROM xmtp_listener_changes candidate
         WHERE candidate.app_id = li.app_id
           AND candidate.installation_id = li.installation_id
       )
      WHERE latest.sequence <= ?
        AND latest.created_at < ?
        AND NOT EXISTS (
          SELECT 1
          FROM xmtp_identities xi
          JOIN xmtp_subscriptions xs ON xs.identity_id = xi.id AND xs.active = 1
          JOIN subscriptions s ON s.id = xs.subscription_id
            AND s.disabled_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          WHERE xi.app_id = li.app_id
            AND xi.installation_id = li.installation_id
        )
      ORDER BY latest.sequence
      LIMIT 250
    )
  `).bind(consumer.cursor, retentionBefore).run();

  const result = await db.prepare(`
    DELETE FROM xmtp_listener_changes
    WHERE sequence IN (
      SELECT sequence
      FROM xmtp_listener_changes
      WHERE sequence <= ? AND created_at < ?
      ORDER BY sequence
      LIMIT 1000
    )
  `).bind(consumer.cursor, retentionBefore).run();
  return result.meta.changes;
}
