import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { relayXmtpDelivery, type NormalizedXmtpRegistration } from '../../src/worker/core';
import {
  acquireXmtpRegistrationMutationLock,
  D1XmtpStore,
  releaseXmtpRegistrationMutationLock,
  XmtpInstallationIdentityConflictError,
} from '../../src/worker/db';
import {
  compactXmtpListenerChanges,
  getXmtpListenerDeltas,
  getXmtpListenerHealth,
  getXmtpListenerSnapshot,
  markXmtpListenerRouteDirty,
  parseListenerPageLimit,
  reconcileXmtpListenerDirtyRoutes,
  saveXmtpListenerStatus,
} from '../../src/worker/listener-registry';
import type { Env, PushQueueJob } from '../../src/worker/types';
import { migrationStatements } from './migration-helpers';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);
const inboxId = '11'.repeat(32);
const installationId = '22'.repeat(32);
const topic = `/xmtp/mls/1/g-${'33'.repeat(16)}/proto`;

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

function registration(endpoint: string, hmacKey: string, inboxHandle: string): NormalizedXmtpRegistration {
  return {
    endpoint,
    p256dh,
    auth,
    expirationTime: null,
    inboxId,
    installationId,
    inboxHandle,
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    topics: [{
      topic,
      algorithm: 'hmac-sha256',
      hmacKeys: [{ epoch: '7', key: hmacKey }],
    }],
  };
}

describe('app-scoped XMTP listener registry', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let queued: PushQueueJob[];

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-14',
      d1Databases: { DB: 'listener-test-db' },
    });
    db = await miniflare.getD1Database('DB');

    const migrations = await Promise.all([
      readFile(new URL('../../migrations/d1/0001_cloudflare_relay.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0002_converge_push_contract.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0003_xmtp_listener_registry_expand.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0005_xmtp_diagnostics.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../migrations/d1/0006_public_apps_and_usage.sql', import.meta.url), 'utf8'),
    ]);
    for (const migration of migrations) {
      await applyMigration(db, migration);
    }

    for (const appId of ['app-a', 'app-b']) {
      await db.prepare(`
        INSERT INTO apps (
          id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(appId, appId, appId, `key-${appId}`, `public-${appId}`, `private-${appId}`).run();
    }

    queued = [];
    const emptyMetrics = { backlogCount: 0, backlogBytes: 0 };
    const queue: Queue<PushQueueJob> = {
      metrics: async () => emptyMetrics,
      send: async (message: PushQueueJob) => {
        queued.push(message);
        return { metadata: { metrics: emptyMetrics } };
      },
      sendBatch: async (_messages: Iterable<MessageSendRequest<PushQueueJob>>) => ({
        metadata: { metrics: emptyMetrics },
      }),
    };
    env = {
      DB: db,
      PUSH_QUEUE: queue,
      RELAY_COORDINATOR: {} as DurableObjectNamespace,
      XMTP_LISTENER_SYNC_TOKEN: 'listener-secret',
    };
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('isolates two apps sharing an installation and topic across snapshot, delivery, and delete', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    const appB = new D1XmtpStore(env, 'app-b');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a',
      'AQID',
      'opaque_app_a'
    ));
    await appB.upsertRegistration(registration(
      'https://push.example/app-b',
      'BAUG',
      'opaque_app_b'
    ));

    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });
    expect(snapshot.registrations).toHaveLength(2);
    const routeA = snapshot.registrations.find((route) => route.appId === 'app-a');
    const routeB = snapshot.registrations.find((route) => route.appId === 'app-b');
    expect(routeA?.deliveryToken).toBeTruthy();
    expect(routeB?.deliveryToken).toBeTruthy();
    expect(routeA?.deliveryToken).not.toBe(routeB?.deliveryToken);
    expect(routeA?.topics[0].hmacKeys[0].key).toBe('AQID');
    expect(routeB?.topics[0].hmacKeys[0].key).toBe('BAUG');

    const relay = new D1XmtpStore(env);
    const deliveryA = {
      version: 1,
      idempotencyKey: 'delivery-a',
      installationId,
      deliveryToken: routeA?.deliveryToken,
      topic,
      messageType: 'v3-conversation',
      isSilent: false,
    };
    expect(await relayXmtpDelivery(relay, deliveryA)).toMatchObject({ matched: 1, queued: 1 });
    expect(queued).toHaveLength(1);
    expect(queued[0].appId).toBe('app-a');

    const cursorBeforeDelete = snapshot.cursor;
    await appA.disableRegistration({
      endpoint: 'https://push.example/app-a',
      inboxId,
      installationId,
    });

    const afterDelete = await getXmtpListenerSnapshot(db, { limit: 100 });
    expect(afterDelete.registrations.map((route) => route.appId)).toEqual(['app-b']);
    const deltas = await getXmtpListenerDeltas(db, { after: cursorBeforeDelete, limit: 100 });
    expect(deltas.changes).toEqual([expect.objectContaining({
      appId: 'app-a',
      installationId,
      deliveryToken: routeA?.deliveryToken,
      registration: null,
    })]);

    expect(await relayXmtpDelivery(relay, {
      ...deliveryA,
      idempotencyKey: 'delivery-a-after-delete',
    })).toMatchObject({ matched: 0, queued: 0 });
    expect(await relayXmtpDelivery(relay, {
      ...deliveryA,
      idempotencyKey: 'delivery-b',
      deliveryToken: routeB?.deliveryToken,
    })).toMatchObject({ matched: 1, queued: 1 });
    expect(queued.at(-1)?.appId).toBe('app-b');

    const foreignKeys = await db.prepare('PRAGMA foreign_key_check').all();
    expect(foreignKeys.results).toEqual([]);
  });

  it('rolls back a failed XMTP queue publish so the same event can be retried', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a-retry',
      'AQID',
      'opaque_app_a_retry'
    ));

    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });
    const route = snapshot.registrations.find((candidate) => candidate.appId === 'app-a');
    expect(route?.deliveryToken).toBeTruthy();
    const delivery = {
      version: 1,
      idempotencyKey: 'delivery-queue-retry',
      installationId,
      deliveryToken: route?.deliveryToken,
      topic,
      messageType: 'v3-conversation',
      isSilent: false,
    };

    const workingQueue = env.PUSH_QUEUE;
    env.PUSH_QUEUE = {
      ...workingQueue,
      send: async () => {
        throw new Error('queue unavailable');
      },
    };

    const relay = new D1XmtpStore(env);
    await expect(relayXmtpDelivery(relay, delivery)).rejects.toThrow('queue unavailable');

    const failedState = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM delivery_attempts WHERE app_id = 'app-a') AS attempts,
        (SELECT COUNT(*) FROM xmtp_delivery_events) AS events,
        (SELECT COALESCE(SUM(queued_count), 0)
          FROM app_usage_daily
          WHERE app_id = 'app-a' AND event_type = 'xmtp.new_message') AS queued
    `).first<{ attempts: number; events: number; queued: number }>();
    expect(failedState).toEqual({ attempts: 0, events: 0, queued: 0 });

    env.PUSH_QUEUE = workingQueue;
    await expect(relayXmtpDelivery(relay, delivery)).resolves.toMatchObject({
      matched: 1,
      queued: 1,
      deduplicated: 0,
    });
    expect(queued).toHaveLength(1);

    const retriedState = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM delivery_attempts WHERE app_id = 'app-a') AS attempts,
        (SELECT COUNT(*) FROM xmtp_delivery_events) AS events,
        (SELECT COALESCE(SUM(queued_count), 0)
          FROM app_usage_daily
          WHERE app_id = 'app-a' AND event_type = 'xmtp.new_message') AS queued
    `).first<{ attempts: number; events: number; queued: number }>();
    expect(retriedState).toEqual({ attempts: 1, events: 1, queued: 1 });
  });

  it('rejects a second inbox for one app installation before mutating route state', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a-original',
      'AQID',
      'opaque_app_a'
    ));
    const state = () => db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmacs,
        (SELECT COUNT(*) FROM xmtp_listener_changes) AS changes,
        (SELECT COUNT(*) FROM xmtp_listener_dirty_routes) AS dirty,
        (SELECT inbox_id FROM xmtp_identities WHERE app_id = 'app-a') AS inbox,
        (SELECT inbox_handle FROM xmtp_identities WHERE app_id = 'app-a') AS handle,
        (SELECT hmac_key FROM xmtp_topic_hmac_keys LIMIT 1) AS hmac
    `).first();
    const before = await state();

    await expect(appA.upsertRegistration({
      ...registration(
        'https://push.example/app-a-conflict',
        'BAUG',
        'must_not_replace_the_original'
      ),
      inboxId: '44'.repeat(32),
    })).rejects.toBeInstanceOf(XmtpInstallationIdentityConflictError);

    expect(await state()).toEqual(before);
  });

  it('serializes registration mutations by app and installation, not inbox', async () => {
    const firstInput = { inboxId, installationId };
    const secondInput = { inboxId: '44'.repeat(32), installationId };
    const first = await acquireXmtpRegistrationMutationLock(db, 'app-a', firstInput);
    expect(first).toBeTruthy();
    expect(await acquireXmtpRegistrationMutationLock(db, 'app-a', secondInput)).toBeNull();
    await releaseXmtpRegistrationMutationLock(db, 'app-a', firstInput, first as string);
    expect(await acquireXmtpRegistrationMutationLock(db, 'app-a', secondInput)).toBeTruthy();
  });

  it('caps parsed and direct snapshot and delta pages at ten routes', async () => {
    expect(parseListenerPageLimit(null)).toBe(10);
    expect(parseListenerPageLimit('10')).toBe(10);
    expect(() => parseListenerPageLimit('11')).toThrow('limit must be between 1 and 10');

    const appA = new D1XmtpStore(env, 'app-a');
    for (let index = 0; index < 11; index += 1) {
      const suffix = (index + 1).toString(16).padStart(2, '0');
      await appA.upsertRegistration({
        ...registration(
          `https://push.example/page-${index}`,
          'AQID',
          `opaque_page_${index}`
        ),
        inboxId: suffix.repeat(32),
        installationId: (index + 32).toString(16).padStart(2, '0').repeat(32),
      });
    }

    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });
    expect(snapshot.registrations).toHaveLength(10);
    expect(snapshot.nextPageToken).toBeTruthy();

    const deltas = await getXmtpListenerDeltas(db, { after: '0', limit: 100 });
    expect(deltas.changes).toHaveLength(10);
    expect(deltas.hasMore).toBe(true);
  });

  it('reports ready only for a fresh listener at the latest change cursor', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a',
      'AQID',
      'opaque_app_a'
    ));
    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });

    expect(await getXmtpListenerHealth(db, true)).toMatchObject({
      deliveryReady: false,
      listener: { configured: true, status: 'unknown' },
      bridge: { status: 'pending', pendingRegistrationCount: 1 },
    });

    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'listener-primary',
      ready: true,
      cursor: snapshot.cursor,
      observedAt: new Date().toISOString(),
      streamConnectedAt: new Date().toISOString(),
      lastControlSyncAt: new Date().toISOString(),
      registrationCount: 1,
      topicCount: 1,
    });
    expect(await getXmtpListenerHealth(db, true)).toMatchObject({
      deliveryReady: false,
      listener: { configured: true, status: 'not_ready' },
      bridge: { status: 'failed' },
    });

    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'listener-primary',
      ready: true,
      deliveryReady: true,
      lastDeliveryProbeAt: new Date().toISOString(),
      cursor: snapshot.cursor,
      observedAt: new Date().toISOString(),
      streamConnectedAt: new Date().toISOString(),
      lastControlSyncAt: new Date().toISOString(),
      registrationCount: 1,
      topicCount: 1,
    });
    expect(await getXmtpListenerHealth(db, true)).toMatchObject({
      deliveryReady: true,
      listener: { configured: true, status: 'ready' },
      bridge: {
        status: 'synced',
        pendingRegistrationCount: 0,
        failedRegistrationCount: 0,
      },
    });
  });

  it('skips an invalid legacy HMAC epoch without breaking the full snapshot', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    const appB = new D1XmtpStore(env, 'app-b');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a',
      'AQID',
      'opaque_app_a'
    ));
    await appB.upsertRegistration(registration(
      'https://push.example/app-b',
      'BAUG',
      'opaque_app_b'
    ));

    const appATopic = await db.prepare(`
      SELECT xt.id
      FROM xmtp_topics xt
      JOIN xmtp_identities xi ON xi.id = xt.identity_id
      WHERE xi.app_id = 'app-a'
    `).first<{ id: string }>();
    expect(appATopic?.id).toBeTruthy();
    await db.prepare(`
      INSERT INTO xmtp_topic_hmac_keys (id, topic_id, epoch, hmac_key)
      VALUES ('legacy-bad-key', ?, 'legacy', 'not-base64!')
    `).bind(appATopic?.id).run();

    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });
    expect(snapshot.registrations).toHaveLength(2);
    expect(snapshot.registrations.find((route) => route.appId === 'app-a')?.topics[0].hmacKeys)
      .toEqual([{ thirtyDayPeriodsSinceEpoch: 7, key: 'AQID' }]);
    expect(snapshot.registrations.find((route) => route.appId === 'app-b')?.topics[0].hmacKeys)
      .toEqual([{ thirtyDayPeriodsSinceEpoch: 7, key: 'BAUG' }]);

    const health = await getXmtpListenerHealth(db, true);
    expect(health.bridge).toMatchObject({
      status: 'pending',
      failedRegistrationCount: 1,
    });
  });

  it('retains a deleted route token until all active consumers pass its aged tombstone', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    const appB = new D1XmtpStore(env, 'app-b');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a',
      'AQID',
      'opaque_app_a'
    ));
    await appB.upsertRegistration(registration(
      'https://push.example/app-b',
      'BAUG',
      'opaque_app_b'
    ));

    const beforeDelete = await getXmtpListenerSnapshot(db, { limit: 100 });
    const routeA = beforeDelete.registrations.find((route) => route.appId === 'app-a');
    const routeB = beforeDelete.registrations.find((route) => route.appId === 'app-b');
    expect(routeA?.deliveryToken).toBeTruthy();
    expect(routeB?.deliveryToken).toBeTruthy();

    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'listener-primary',
      ready: true,
      cursor: beforeDelete.cursor,
      observedAt: new Date().toISOString(),
    });
    await appA.disableRegistration({
      endpoint: 'https://push.example/app-a',
      inboxId,
      installationId,
    });
    const afterDelete = await getXmtpListenerDeltas(db, {
      after: beforeDelete.cursor,
      limit: 100,
    });
    expect(afterDelete.changes).toHaveLength(1);

    await db.prepare(`
      UPDATE xmtp_listener_changes
      SET created_at = '2020-01-01T00:00:00.000Z'
      WHERE app_id = 'app-a'
    `).run();

    await compactXmtpListenerChanges(db);
    expect(await db.prepare(`
      SELECT delivery_token
      FROM xmtp_listener_installations
      WHERE app_id = 'app-a' AND installation_id = ?
    `).bind(installationId).first<{ delivery_token: string }>()).toEqual({
      delivery_token: routeA?.deliveryToken,
    });

    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'listener-primary',
      ready: true,
      cursor: afterDelete.cursor,
      observedAt: new Date().toISOString(),
    });
    await compactXmtpListenerChanges(db);

    expect(await db.prepare(`
      SELECT delivery_token
      FROM xmtp_listener_installations
      WHERE app_id = 'app-a' AND installation_id = ?
    `).bind(installationId).first()).toBeNull();
    expect(await db.prepare(`
      SELECT delivery_token
      FROM xmtp_listener_installations
      WHERE app_id = 'app-b' AND installation_id = ?
    `).bind(installationId).first<{ delivery_token: string }>()).toEqual({
      delivery_token: routeB?.deliveryToken,
    });
  });

  it('repairs an outbox change left dirty by a terminated registration mutation', async () => {
    const appA = new D1XmtpStore(env, 'app-a');
    await appA.upsertRegistration(registration(
      'https://push.example/app-a',
      'AQID',
      'opaque_app_a'
    ));
    const before = await getXmtpListenerSnapshot(db, { limit: 100 });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM xmtp_listener_dirty_routes
    `).first()).toEqual({ count: 0 });

    await markXmtpListenerRouteDirty(db, 'app-a', installationId);
    await db.prepare(`
      UPDATE xmtp_topic_hmac_keys
      SET hmac_key = 'BwgJ'
      WHERE topic_id IN (
        SELECT xt.id
        FROM xmtp_topics xt
        JOIN xmtp_identities xi ON xi.id = xt.identity_id
        WHERE xi.app_id = 'app-a' AND xi.installation_id = ?
      )
    `).bind(installationId).run();

    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'listener-primary',
      ready: true,
      deliveryReady: true,
      cursor: before.cursor,
      observedAt: new Date().toISOString(),
    });
    expect(await getXmtpListenerHealth(db, true)).toMatchObject({
      deliveryReady: false,
      bridge: { status: 'pending', pendingRegistrationCount: 1 },
    });

    expect(await reconcileXmtpListenerDirtyRoutes(db)).toBe(1);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM xmtp_listener_dirty_routes
    `).first()).toEqual({ count: 0 });
    const deltas = await getXmtpListenerDeltas(db, { after: before.cursor, limit: 100 });
    expect(deltas.changes).toHaveLength(1);
    expect(deltas.changes[0].registration?.topics[0].hmacKeys).toEqual([
      { thirtyDayPeriodsSinceEpoch: 7, key: 'BwgJ' },
    ]);
  });
});
