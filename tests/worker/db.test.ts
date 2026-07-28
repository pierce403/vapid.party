import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  compactExpiredSubscriptions,
  countActiveXmtpRegistrations,
  countSubscriptions,
  deleteApp,
  D1XmtpStore,
  getSubscriptionsByIds,
} from '../../src/worker/db';
import type { NormalizedXmtpRegistration } from '../../src/worker/core';
import type { Env, PushQueueJob } from '../../src/worker/types';
import { migrationStatements } from './migration-helpers';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  const statements = migrationStatements(sql);
  for (const [index, statement] of statements.entries()) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      throw new Error(`Migration statement ${index + 1} failed: ${statement.slice(0, 120)}`, {
        cause: error,
      });
    }
  }
}

function registration(inboxId: string, installationId: string, inboxHandle: string): NormalizedXmtpRegistration {
  return {
    endpoint: 'https://push.example/shared-endpoint',
    p256dh,
    auth,
    deliveryKind: 'web_push',
    expirationTime: null,
    inboxId,
    installationId,
    inboxHandle,
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    topics: [{
      topic: `/xmtp/mls/1/g-${installationId.slice(0, 32).padEnd(32, '0')}/proto`,
      algorithm: 'hmac-sha256',
      hmacKeys: [{ epoch: '7', key: 'AQID' }],
    }],
  };
}

describe('D1 XMTP unsubscribe cleanup', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let store: D1XmtpStore;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-09',
      d1Databases: { DB: 'test-db' },
    });
    db = await miniflare.getD1Database('DB');

    const migrations = await Promise.all([
      readFile(new URL('../../migrations/d1/0001_cloudflare_relay.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0002_converge_push_contract.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0003_xmtp_listener_registry_expand.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0005_xmtp_diagnostics.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0006_public_apps_and_usage.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0007_public_xmtp_and_callbacks.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0008_service_health.sql', import.meta.url), 'utf8'),
    ]);
    for (const migration of migrations) {
      await applyMigration(db, migration);
    }

    await db.prepare(`
      INSERT INTO apps (
        id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
      ) VALUES ('converge', 'Converge', 'converge', 'secret', 'public', 'private')
    `).run();

    const emptyMetrics = { backlogCount: 0, backlogBytes: 0 };
    const queue: Queue<PushQueueJob> = {
      metrics: async () => emptyMetrics,
      send: async (_message: PushQueueJob) => ({ metadata: { metrics: emptyMetrics } }),
      sendBatch: async (_messages: Iterable<MessageSendRequest<PushQueueJob>>) => ({
        metadata: { metrics: emptyMetrics },
      }),
    };
    const relayCoordinator = {} as DurableObjectNamespace;
    const env: Env = { DB: db, PUSH_QUEUE: queue, RELAY_COORDINATOR: relayCoordinator };
    store = new D1XmtpStore(env);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('keeps a shared endpoint until its last logical registration, then removes all secrets', async () => {
    await store.upsertRegistration(registration('inbox-1', 'aabb', 'opaque_inbox_1'));
    await store.upsertRegistration(registration('inbox-2', 'ccdd', 'opaque_inbox_2'));

    const sharedBefore = await db.prepare(
      'SELECT COUNT(*) AS count FROM subscriptions WHERE endpoint = ?'
    ).bind('https://push.example/shared-endpoint').first<{ count: number }>();
    expect(sharedBefore?.count).toBe(1);

    await store.disableRegistration({
      endpoint: 'https://push.example/shared-endpoint',
      inboxId: 'inbox-1',
      installationId: 'aabb',
    });

    const afterFirst = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS physical_count,
        (SELECT COUNT(*) FROM xmtp_identities WHERE inbox_id = 'inbox-1') AS removed_identity_count,
        (SELECT COUNT(*) FROM xmtp_identities WHERE inbox_id = 'inbox-2') AS kept_identity_count,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS remaining_hmac_count
    `).first<{
      physical_count: number;
      removed_identity_count: number;
      kept_identity_count: number;
      remaining_hmac_count: number;
    }>();
    expect(afterFirst).toMatchObject({
      physical_count: 1,
      removed_identity_count: 0,
      kept_identity_count: 1,
      remaining_hmac_count: 1,
    });

    await store.disableRegistration({
      endpoint: 'https://push.example/shared-endpoint',
      inboxId: 'inbox-2',
      installationId: 'ccdd',
    });

    const afterLast = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS physical_count,
        (SELECT COUNT(*) FROM xmtp_identities) AS identity_count,
        (SELECT COUNT(*) FROM xmtp_topics) AS topic_count,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmac_count
    `).first<{
      physical_count: number;
      identity_count: number;
      topic_count: number;
      hmac_count: number;
    }>();
    expect(afterLast).toEqual({
      physical_count: 0,
      identity_count: 0,
      topic_count: 0,
      hmac_count: 0,
    });
  });

  it('deletes XMTP identity and diagnostic material safely', async () => {
    await store.upsertRegistration(registration('inbox-1', 'aabb', 'opaque_inbox_1'));

    expect(await deleteApp(db, 'converge')).toBe(true);
    expect(await deleteApp(db, 'converge')).toBe(false);

    const remaining = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM apps WHERE id = 'converge') AS app_count,
        (SELECT COUNT(*) FROM subscriptions) AS subscription_count,
        (SELECT COUNT(*) FROM xmtp_identities) AS identity_count,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS xmtp_subscription_count,
        (SELECT COUNT(*) FROM xmtp_topics) AS topic_count,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmac_count,
        (SELECT COUNT(*) FROM xmtp_listener_installations
          WHERE app_id = 'converge' AND installation_id = 'aabb') AS route_count,
        (SELECT COUNT(*) FROM xmtp_listener_changes
          WHERE app_id = 'converge' AND installation_id = 'aabb'
            AND reason = 'registration-deleted') AS tombstone_count
    `).first<Record<string, number>>();
    expect(remaining).toEqual({
      app_count: 0,
      subscription_count: 0,
      identity_count: 0,
      xmtp_subscription_count: 0,
      topic_count: 0,
      hmac_count: 0,
      route_count: 1,
      tombstone_count: 1,
    });
  });

  it('excludes expired routes immediately and removes their XMTP secrets with a tombstone', async () => {
    const expired = registration('inbox-expired', 'eeff', 'opaque_inbox_expired');
    expired.expirationTime = 0;
    await store.upsertRegistration(expired);

    const persisted = await db.prepare(`
      SELECT id, expires_at FROM subscriptions WHERE app_id = 'converge'
    `).first<{ id: string; expires_at: string | null }>();
    expect(persisted?.expires_at).toBe('1970-01-01T00:00:00.000Z');
    expect(await countSubscriptions(db, 'converge')).toBe(0);
    expect(await countActiveXmtpRegistrations(db, 'converge')).toBe(0);
    expect(await getSubscriptionsByIds(db, 'converge', [persisted?.id as string])).toEqual([]);

    const compacted = await compactExpiredSubscriptions(db);
    expect(compacted).toMatchObject({
      deletedGenericSubscriptions: 0,
      deletedXmtpSubscription: true,
      backlogLikely: false,
    });
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmacs,
        (SELECT COUNT(*) FROM xmtp_listener_changes
          WHERE app_id = 'converge' AND installation_id = 'eeff'
            AND reason = 'registration-deleted') AS tombstones
    `).first()).toEqual({
      subscriptions: 0,
      identities: 0,
      logical: 0,
      topics: 0,
      hmacs: 0,
      tombstones: 1,
    });
  });

  it('bounds generic expiration cleanup and converges on later runs', async () => {
    await db.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), sequence(value) AS (
        SELECT ones.value + tens.value * 10 + hundreds.value * 100 + thousands.value * 1000
        FROM digits ones
        CROSS JOIN digits tens
        CROSS JOIN digits hundreds
        CROSS JOIN digits thousands
        WHERE ones.value + tens.value * 10 + hundreds.value * 100 + thousands.value * 1000 <= 5000
      )
      INSERT INTO subscriptions (
        id, app_id, endpoint, p256dh, auth, expires_at
      )
      SELECT
        'expired-generic-' || value,
        'converge',
        'https://push.example/expired-generic-' || value,
        ?,
        ?,
        '1970-01-01T00:00:00.000Z'
      FROM sequence
    `).bind(p256dh, auth).run();
    expect(await countSubscriptions(db, 'converge')).toBe(0);

    const first = await compactExpiredSubscriptions(db);
    expect(first).toMatchObject({
      deletedGenericSubscriptions: 5000,
      deletedXmtpSubscription: false,
      backlogLikely: true,
      oldestExpiredAt: '1970-01-01T00:00:00.000Z',
    });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM subscriptions').first())
      .toEqual({ count: 1 });

    const second = await compactExpiredSubscriptions(db);
    expect(second).toMatchObject({
      deletedGenericSubscriptions: 1,
      deletedXmtpSubscription: false,
      backlogLikely: false,
    });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM subscriptions').first())
      .toEqual({ count: 0 });
  });
});

describe('D1 subscription lookup bounds', () => {
  it('chunks explicit ids below D1s 100-parameter statement limit', async () => {
    const calls: unknown[][] = [];
    const db = {
      prepare: (_query: string) => ({
        bind: (...values: unknown[]) => {
          calls.push(values);
          if (values.length > 100) throw new Error('too many bound parameters');
          return {
            all: async () => ({
              results: values.slice(1).map((id) => ({
                id,
                app_id: values[0],
                endpoint: `https://push.example/${String(id)}`,
                p256dh,
                auth,
                user_id: null,
                channel_id: null,
                metadata: '{}',
                created_at: '2026-07-15T00:00:00.000Z',
                updated_at: '2026-07-15T00:00:00.000Z',
                expires_at: null,
                disabled_at: null,
              })),
            }),
          };
        },
      }),
    } as unknown as D1Database;
    const ids = Array.from({ length: 250 }, (_, index) => `subscription-${index}`);

    const subscriptions = await getSubscriptionsByIds(db, 'app-id', [...ids, ids[0]]);

    expect(calls.map((values) => values.length)).toEqual([100, 100, 53]);
    expect(subscriptions.map((subscription) => subscription.id)).toEqual(ids);
  });
});
