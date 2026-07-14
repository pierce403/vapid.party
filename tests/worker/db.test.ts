import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { deleteApp, D1XmtpStore } from '../../src/worker/db';
import type { NormalizedXmtpRegistration } from '../../src/worker/core';
import type { Env, PushQueueJob } from '../../src/worker/types';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);

function migrationStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

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

  it('deletes XMTP identity material safely during the 0003 expansion phase', async () => {
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
});
