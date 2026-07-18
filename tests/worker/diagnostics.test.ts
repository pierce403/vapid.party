import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { handleApi } from '../../src/worker/api';
import {
  compactOperationalHistory,
  checkAndIncrementRateLimit,
  disableSubscription,
  D1XmtpStore,
  updateDeliveryAttempt,
} from '../../src/worker/db';
import { getXmtpListenerSnapshot, saveXmtpListenerStatus } from '../../src/worker/listener-registry';
import type { NormalizedXmtpRegistration, XmtpRegistrationResult } from '../../src/worker/core';
import type { Env, PushQueueJob } from '../../src/worker/types';
import { migrationStatements } from './migration-helpers';

const inboxId = '11'.repeat(32);
const installationId = '22'.repeat(32);
const groupTopic = `/xmtp/mls/1/g-${'33'.repeat(16)}/proto`;
const welcomeTopic = `/xmtp/mls/1/w-${installationId}/proto`;

async function applyMigration(db: D1Database, path: string): Promise<void> {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const statement of migrationStatements(sql)) await db.prepare(statement).run();
}

function registration(topics: NormalizedXmtpRegistration['topics'] = [
  {
    topic: groupTopic,
    algorithm: 'hmac-sha256',
    hmacKeys: [{ epoch: '7', key: 'AQID' }],
  },
  {
    topic: welcomeTopic,
    algorithm: 'hmac-sha256',
    hmacKeys: [],
  },
]): NormalizedXmtpRegistration {
  return {
    endpoint: 'https://push.example/diagnostic-endpoint',
    p256dh: `B${'A'.repeat(86)}`,
    auth: 'A'.repeat(22),
    deliveryKind: 'web_push',
    expirationTime: null,
    inboxId,
    installationId,
    inboxHandle: 'opaque_diagnostic_inbox',
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    topics,
  };
}

function publicRegistrationRequest(
  endpoint: string,
  options: {
    inboxId?: string;
    installationId?: string;
    p256dh?: string;
    auth?: string;
  } = {}
) {
  const requestInstallationId = options.installationId ?? installationId;
  return {
    version: 1,
    app: { id: 'converge.cv', origin: 'https://converge.cv' },
    identity: {
      inboxId: options.inboxId ?? inboxId,
      installationId: requestInstallationId,
    },
    subscription: {
      endpoint,
      expirationTime: null,
      keys: {
        p256dh: options.p256dh ?? `B${'A'.repeat(86)}`,
        auth: options.auth ?? 'A'.repeat(22),
      },
    },
    xmtp: {
      env: 'production',
      topics: [
        { topic: groupTopic, hmacKeys: [{ epoch: '7', key: 'AQID' }] },
        { topic: `/xmtp/mls/1/w-${requestInstallationId}/proto`, hmacKeys: [] },
      ],
      topicSource: 'conversations.hmacKeys',
    },
    notification: { inboxHandle: 'opaque_diagnostic_inbox' },
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    registeredAt: new Date().toISOString(),
  };
}

function publicDeleteRequest(endpoint: string) {
  return {
    version: 1,
    app: { id: 'converge.cv', origin: 'https://converge.cv' },
    endpoint,
    identity: { inboxId, installationId },
    deletedAt: new Date().toISOString(),
  };
}

function requiredDiagnostics(result: XmtpRegistrationResult) {
  if (!result.diagnostics) throw new Error('Expected an issued diagnostic receipt');
  return result.diagnostics;
}

describe('privacy-safe XMTP registration diagnostics', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let queued: PushQueueJob[];

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-14',
      d1Databases: { DB: 'diagnostic-test-db' },
    });
    db = await miniflare.getD1Database('DB');
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
      '../../migrations/d1/0006_public_apps_and_usage.sql',
      '../../migrations/d1/0007_public_xmtp_and_callbacks.sql',
    ]) await applyMigration(db, path);

    await db.prepare(`
      INSERT INTO apps (
        id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
      ) VALUES ('converge', 'Converge', 'converge', 'secret', 'public', 'private')
    `).run();

    queued = [];
    const emptyMetrics = { backlogCount: 0, backlogBytes: 0 };
    env = {
      DB: db,
      PUSH_QUEUE: {
        metrics: async () => emptyMetrics,
        send: async (message: PushQueueJob) => {
          queued.push(message);
          return { metadata: { metrics: emptyMetrics } };
        },
        sendBatch: async () => ({ metadata: { metrics: emptyMetrics } }),
      },
      RELAY_COORDINATOR: {} as DurableObjectNamespace,
      XMTP_LISTENER: {} as NonNullable<Env['XMTP_LISTENER']>,
      XMTP_LISTENER_SYNC_TOKEN: 'listener-secret',
      INTERNAL_INGEST_TOKEN: 'ingest-secret',
    };
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  async function markListenerReady(): Promise<void> {
    const snapshot = await getXmtpListenerSnapshot(db, { limit: 100 });
    const now = new Date().toISOString();
    await saveXmtpListenerStatus(db, {
      version: 1,
      instanceId: 'primary',
      ready: true,
      deliveryReady: true,
      cursor: snapshot.cursor,
      observedAt: now,
      streamConnectedAt: now,
      lastEnvelopeAt: now,
      lastControlSyncAt: now,
      registrationCount: 1,
      topicCount: 2,
    });
  }

  async function post(path: string, receipt?: string): Promise<Response> {
    return (await handleApi(new Request(`https://vapid.party${path}`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.10',
        ...(receipt ? { Authorization: `Bearer ${receipt}` } : {}),
      },
    }), env)) as Response;
  }

  async function postJson(
    path: string,
    body: unknown,
    options: {
      receipt?: string;
      apiKey?: string;
      diagnostics?: boolean;
      ip?: string;
      method?: 'POST' | 'DELETE';
    } = {}
  ): Promise<Response> {
    return (await handleApi(new Request(`https://vapid.party${path}`, {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': options.ip ?? '203.0.113.10',
        ...(options.diagnostics === false ? {} : { 'X-Vapid-Party-Diagnostics': '1' }),
        ...(options.apiKey ? { 'X-API-Key': options.apiKey } : {}),
        ...(options.receipt ? { Authorization: `Bearer ${options.receipt}` } : {}),
      },
      body: JSON.stringify(body),
    }), env)) as Response;
  }

  async function postOperatorDiagnostic(
    path: string,
    apiKey: string | undefined,
    receipt: string
  ): Promise<Response> {
    return (await handleApi(new Request(`https://vapid.party${path}`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.10',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        Authorization: `Bearer ${receipt}`,
      },
    }), env)) as Response;
  }

  it('stores only a receipt hash and returns coarse registration coverage', async () => {
    const result = await new D1XmtpStore(env).upsertRegistration(registration());
    const diagnostics = requiredDiagnostics(result);
    await markListenerReady();

    expect(diagnostics).toMatchObject({
      receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      statusPath: '/api/xmtp/status',
      testPath: '/api/xmtp/status/test',
    });
    const stored = await db.prepare(`
      SELECT diagnostic_token_hash FROM xmtp_subscriptions WHERE identity_id = ?
    `).bind(result.identityId).first<{ diagnostic_token_hash: string }>();
    expect(stored?.diagnostic_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.diagnostic_token_hash).not.toBe(diagnostics.receipt);
    const persistedRows = await Promise.all([
      db.prepare('SELECT * FROM subscriptions').all(),
      db.prepare('SELECT * FROM xmtp_identities').all(),
      db.prepare('SELECT * FROM xmtp_subscriptions').all(),
      db.prepare('SELECT * FROM xmtp_topics').all(),
      db.prepare('SELECT * FROM xmtp_topic_hmac_keys').all(),
    ]);
    expect(JSON.stringify(persistedRows)).not.toContain(diagnostics.receipt);

    const response = await post(diagnostics.statusPath, diagnostics.receipt);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(body.data).toMatchObject({
      registration: {
        status: 'active',
        coverage: 'complete',
        groupTopicCount: 1,
        welcomeTopicCount: 1,
        hmacEpochCount: 1,
      },
      route: { status: 'synced', changePending: false },
      pipeline: { deliveryReady: true, listenerStatus: 'ready', bridgeStatus: 'synced' },
      deliveries: { xmtp: { status: 'none' }, diagnostic: { status: 'none' } },
    });

    const serialized = JSON.stringify(body);
    for (const secret of [
      inboxId,
      installationId,
      groupTopic,
      welcomeTopic,
      'https://push.example/diagnostic-endpoint',
      'AQID',
      diagnostics.receipt,
    ]) expect(serialized).not.toContain(secret);
  });

  it('serves returned operator diagnostic paths only to the owning app and receipt', async () => {
    await db.prepare(`
      INSERT INTO apps (
        id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
      ) VALUES (
        'operator-one', 'Operator One', 'operator-one', 'operator-secret',
        'operator-public', 'operator-private'
      )
    `).run();
    const {
      app: operatorAppDescriptor,
      ...operatorRegistration
    } = publicRegistrationRequest('https://fcm.googleapis.com/fcm/send/operator-diagnostic');
    expect(operatorAppDescriptor.id).toBe('converge.cv');

    const registered = await postJson('/api/xmtp/registrations', operatorRegistration, {
      apiKey: 'operator-secret',
      diagnostics: false,
    });
    expect(registered.status).toBe(201);
    const registeredBody = await registered.json() as {
      data: { diagnostics: { receipt: string; statusPath: string; testPath: string } };
    };
    const diagnostics = registeredBody.data.diagnostics;
    expect(diagnostics).toMatchObject({
      receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      statusPath: '/api/apps/operator-one/xmtp/status',
      testPath: '/api/apps/operator-one/xmtp/status/test',
    });

    const missingAppCredential = await postOperatorDiagnostic(
      diagnostics.statusPath,
      undefined,
      diagnostics.receipt
    );
    expect(missingAppCredential.status).toBe(401);
    expect(missingAppCredential.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const status = await postOperatorDiagnostic(
      diagnostics.statusPath,
      'operator-secret',
      diagnostics.receipt
    );
    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(status.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const test = await postOperatorDiagnostic(
      diagnostics.testPath,
      'operator-secret',
      diagnostics.receipt
    );
    expect(test.status).toBe(202);
    expect(queued).toHaveLength(1);

    await db.prepare(`
      INSERT INTO apps (
        id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
      ) VALUES (
        'second-operator', 'Second Operator', 'second-operator', 'second-secret',
        'second-public', 'second-private'
      )
    `).run();
    const secondInstallationId = '44'.repeat(32);
    const {
      app: secondAppDescriptor,
      ...secondRegistration
    } = publicRegistrationRequest(
      'https://fcm.googleapis.com/fcm/send/second-operator-diagnostic',
      { installationId: secondInstallationId }
    );
    expect(secondAppDescriptor.id).toBe('converge.cv');
    const secondRegistered = await postJson('/api/xmtp/registrations', secondRegistration, {
      apiKey: 'second-secret',
      diagnostics: false,
    });
    expect(secondRegistered.status).toBe(201);
    const secondBody = await secondRegistered.json() as {
      data: { diagnostics: { receipt: string } };
    };

    const crossAppReceipt = await postOperatorDiagnostic(
      diagnostics.statusPath,
      'operator-secret',
      secondBody.data.diagnostics.receipt
    );
    expect(crossAppReceipt.status).toBe(404);

    const mismatchedPath = await postOperatorDiagnostic(
      '/api/apps/second-operator/xmtp/status',
      'operator-secret',
      diagnostics.receipt
    );
    expect(mismatchedPath.status).toBe(403);
  });

  it('returns the receipt only in a no-store response and rejects custom endpoints', async () => {
    const rejected = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest('https://127.0.0.1/internal')
    );
    expect(rejected.status).toBe(422);
    expect(rejected.headers.get('Cache-Control')).toBe('no-store');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM subscriptions').first())
      .toEqual({ count: 0 });

    const accepted = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest('https://fcm.googleapis.com/fcm/send/opaque-token')
    );
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get('Cache-Control')).toBe('no-store');
    expect(accepted.headers.get('Pragma')).toBe('no-cache');
    expect(await accepted.json()).toMatchObject({
      data: {
        diagnostics: {
          receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          statusPath: '/api/xmtp/status',
          testPath: '/api/xmtp/status/test',
        },
      },
    });
  });

  it('rotates the receipt on re-registration and flags welcome-only coverage', async () => {
    const store = new D1XmtpStore(env);
    const first = await store.upsertRegistration(registration());
    const second = await store.upsertRegistration(registration([
      { topic: welcomeTopic, algorithm: 'hmac-sha256', hmacKeys: [] },
    ]));
    const firstDiagnostics = requiredDiagnostics(first);
    const secondDiagnostics = requiredDiagnostics(second);
    expect(secondDiagnostics.receipt).not.toBe(firstDiagnostics.receipt);

    expect((await post('/api/xmtp/status', firstDiagnostics.receipt)).status).toBe(404);
    const current = await post('/api/xmtp/status', secondDiagnostics.receipt);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      data: {
        registration: {
          coverage: 'welcome_only',
          groupTopicCount: 0,
          welcomeTopicCount: 1,
          hmacEpochCount: 0,
        },
      },
    });
  });

  it('preserves the old receipt when a refresh fails before finalization', async () => {
    const store = new D1XmtpStore(env);
    const first = await store.upsertRegistration(registration());
    const firstDiagnostics = requiredDiagnostics(first);
    await db.prepare(`
      CREATE TRIGGER fail_listener_change
      BEFORE INSERT ON xmtp_listener_changes
      BEGIN
        SELECT RAISE(ABORT, 'injected listener outbox failure');
      END
    `).run();

    await expect(store.upsertRegistration(registration())).rejects.toThrow(/outbox failure/);
    expect((await post('/api/xmtp/status', firstDiagnostics.receipt)).status).toBe(200);

    await db.prepare('DROP TRIGGER fail_listener_change').run();
    const successful = await store.upsertRegistration(registration());
    const successfulDiagnostics = requiredDiagnostics(successful);
    expect(successfulDiagnostics.receipt).not.toBe(firstDiagnostics.receipt);
    expect((await post('/api/xmtp/status', firstDiagnostics.receipt)).status).toBe(404);
    expect((await post('/api/xmtp/status', successfulDiagnostics.receipt)).status).toBe(200);
  });

  it('rolls back the full topic snapshot when one replacement row fails', async () => {
    const store = new D1XmtpStore(env);
    await store.upsertRegistration(registration());
    const before = await db.prepare(`
      SELECT xt.topic, hk.epoch, hk.hmac_key
      FROM xmtp_topics xt
      LEFT JOIN xmtp_topic_hmac_keys hk ON hk.topic_id = xt.id
      ORDER BY xt.topic, hk.epoch
    `).all();
    await db.prepare(`
      CREATE TRIGGER fail_second_hmac_epoch
      BEFORE INSERT ON xmtp_topic_hmac_keys
      WHEN NEW.epoch = '8'
      BEGIN
        SELECT RAISE(ABORT, 'injected HMAC row failure');
      END
    `).run();

    await expect(store.upsertRegistration(registration([
      {
        topic: groupTopic,
        algorithm: 'hmac-sha256',
        hmacKeys: [
          { epoch: '7', key: 'AQID' },
          { epoch: '8', key: 'BAUG' },
        ],
      },
      { topic: welcomeTopic, algorithm: 'hmac-sha256', hmacKeys: [] },
    ]))).rejects.toThrow(/HMAC row failure/);

    const after = await db.prepare(`
      SELECT xt.topic, hk.epoch, hk.hmac_key
      FROM xmtp_topics xt
      LEFT JOIN xmtp_topic_hmac_keys hk ON hk.topic_id = xt.id
      ORDER BY xt.topic, hk.epoch
    `).all();
    expect(after.results).toEqual(before.results);
  });

  it('queues a bounded minimal test and reports provider progress separately', async () => {
    const result = await new D1XmtpStore(env).upsertRegistration(registration());
    const diagnostics = requiredDiagnostics(result);
    const testResponse = await post(diagnostics.testPath, diagnostics.receipt);
    expect(testResponse.status).toBe(202);
    expect(testResponse.headers.get('Cache-Control')).toBe('no-store');
    const testBody = await testResponse.json() as any;
    expect(testBody.data).toMatchObject({
      queued: true,
      testId: expect.any(String),
      checkedAt: expect.any(String),
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      source: 'diagnostic',
      payload: { type: 'vapid.diagnostic', testId: testBody.data.testId },
    });
    expect(Object.keys(queued[0].payload).sort()).toEqual(['testId', 'type']);

    await updateDeliveryAttempt(db, queued[0].deliveryAttemptId, {
      status: 'sent',
      pushStatus: 201,
    });
    const status = await post(diagnostics.statusPath, diagnostics.receipt);
    expect(await status.json()).toMatchObject({
      data: {
        deliveries: {
          xmtp: { status: 'none' },
          diagnostic: {
            status: 'sent',
            testId: testBody.data.testId,
            queuedAt: expect.any(String),
            lastAttemptAt: expect.any(String),
            providerAcceptedAt: expect.any(String),
          },
        },
      },
    });

    await post(diagnostics.testPath, diagnostics.receipt);
    await post(diagnostics.testPath, diagnostics.receipt);
    const limited = await post(diagnostics.testPath, diagnostics.receipt);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not reset the app-wide diagnostic limit when a receipt rotates', async () => {
    await db.prepare(`
      UPDATE apps
      SET rate_limit = '{"maxNotificationsPerMinute":1}'
      WHERE id = 'converge'
    `).run();
    const store = new D1XmtpStore(env);
    const first = await store.upsertRegistration(registration());
    const firstDiagnostics = requiredDiagnostics(first);
    expect((await post(firstDiagnostics.testPath, firstDiagnostics.receipt)).status).toBe(202);

    const rotated = await store.upsertRegistration(registration());
    const rotatedDiagnostics = requiredDiagnostics(rotated);
    const limited = await post(rotatedDiagnostics.testPath, rotatedDiagnostics.receipt);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects missing, malformed, and unknown receipt capabilities without echoing them', async () => {
    const missing = await post('/api/xmtp/status');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');

    const malformed = await post('/api/xmtp/status', 'not-a-receipt');
    expect(malformed.status).toBe(401);

    const unknownReceipt = 'Z'.repeat(43);
    const unknown = await post('/api/xmtp/status', unknownReceipt);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain(unknownReceipt);
  });

  it('supports legacy-client bootstrap, receipt refresh, replacement, and authorized deletion', async () => {
    const firstEndpoint = 'https://fcm.googleapis.com/fcm/send/lifecycle-one';
    const secondEndpoint = 'https://fcm.googleapis.com/fcm/send/lifecycle-two';

    const legacyCreate = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint),
      { diagnostics: false }
    );
    expect(legacyCreate.status).toBe(201);
    expect((await legacyCreate.json() as any).data.diagnostics).toBeUndefined();
    expect(await db.prepare(`
      SELECT diagnostic_token_hash FROM xmtp_subscriptions WHERE active = 1
    `).first()).toEqual({ diagnostic_token_hash: null });

    const legacyRefresh = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint),
      { diagnostics: false }
    );
    expect(legacyRefresh.status).toBe(200);
    expect((await legacyRefresh.json() as any).data.diagnostics).toBeUndefined();

    const bootstrapped = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint)
    );
    const firstReceipt = (await bootstrapped.json() as any).data.diagnostics.receipt as string;
    const preserved = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint),
      { receipt: firstReceipt }
    );
    expect((await preserved.json() as any).data.diagnostics.receipt).toBe(firstReceipt);

    const rotated = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint)
    );
    const rotatedReceipt = (await rotated.json() as any).data.diagnostics.receipt as string;
    expect(rotatedReceipt).not.toBe(firstReceipt);
    expect((await post('/api/xmtp/status', firstReceipt)).status).toBe(404);

    const unauthorizedReplacement = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(secondEndpoint)
    );
    expect(unauthorizedReplacement.status).toBe(409);

    const replacement = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(secondEndpoint),
      { receipt: rotatedReceipt }
    );
    expect(replacement.status).toBe(200);
    const replacementReceipt = (await replacement.json() as any).data.diagnostics.receipt as string;
    expect(replacementReceipt).toBe(rotatedReceipt);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM subscriptions').first())
      .toEqual({ count: 1 });

    const retryAfterLostResponse = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(secondEndpoint),
      { receipt: rotatedReceipt }
    );
    expect(retryAfterLostResponse.status).toBe(200);
    expect((await retryAfterLostResponse.json() as any).data.diagnostics.receipt)
      .toBe(rotatedReceipt);

    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicDeleteRequest(secondEndpoint),
      { method: 'DELETE' }
    )).status).toBe(409);
    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicDeleteRequest(secondEndpoint),
      { method: 'DELETE', receipt: replacementReceipt }
    )).status).toBe(200);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmacs
    `).first()).toEqual({ subscriptions: 0, identities: 0, topics: 0, hmacs: 0 });
  });

  it('returns 409 without replacing state when one app reuses an installation for another inbox', async () => {
    const originalEndpoint = 'https://fcm.googleapis.com/fcm/send/installation-owner';
    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(originalEndpoint)
    )).status).toBe(201);
    const protectedState = () => db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmacs,
        (SELECT COUNT(*) FROM xmtp_listener_changes) AS changes,
        (SELECT COUNT(*) FROM xmtp_listener_dirty_routes) AS dirty,
        (SELECT inbox_id FROM xmtp_identities WHERE installation_id = ?) AS inbox,
        (SELECT endpoint FROM subscriptions WHERE disabled_at IS NULL) AS endpoint
    `).bind(installationId).first();
    const before = await protectedState();

    const conflict = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(
        'https://fcm.googleapis.com/fcm/send/installation-intruder',
        { inboxId: '44'.repeat(32), installationId }
      )
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('Cache-Control')).toBe('no-store');
    expect(await protectedState()).toEqual(before);
  });

  it('maps the stable D1 subscription quota abort to 429', async () => {
    await db.prepare(`
      CREATE TRIGGER force_subscription_limit_for_test
      BEFORE INSERT ON subscriptions
      WHEN NEW.endpoint LIKE '%/forced-quota-limit'
      BEGIN
        SELECT RAISE(ABORT, 'app_subscription_limit');
      END
    `).run();

    const limited = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(
        'https://fcm.googleapis.com/fcm/send/forced-quota-limit'
      )
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects XMTP capacity before persisting any registration state', async () => {
    await db.prepare(`
      INSERT INTO xmtp_app_capacity (app_id, row_count) VALUES ('converge', 5000)
    `).run();
    await db.prepare(`
      UPDATE xmtp_global_capacity SET row_count = 5000 WHERE id = 1
    `).run();

    const limited = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest('https://fcm.googleapis.com/fcm/send/capacity-preflight')
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_listener_changes) AS changes,
        (SELECT COUNT(*) FROM xmtp_listener_dirty_routes) AS dirty
    `).first()).toEqual({
      subscriptions: 0,
      identities: 0,
      logical: 0,
      topics: 0,
      changes: 0,
      dirty: 0,
    });
  });

  it('does not charge rejected mutations to valid registration quotas', async () => {
    const firstEndpoint = 'https://fcm.googleapis.com/fcm/send/quota-one';
    const replacementEndpoint = 'https://fcm.googleapis.com/fcm/send/quota-two';
    const created = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint)
    );
    const receipt = (await created.json() as any).data.diagnostics.receipt as string;

    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(replacementEndpoint)
    )).status).toBe(409);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM rate_limit_logs
      WHERE action IN ('xmtp-public-registration-refresh', 'xmtp-public-new-registration')
    `).first()).toEqual({ count: 1 });

    const valid = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(firstEndpoint),
      { receipt }
    );
    expect(valid.status).toBe(200);
    expect(await db.prepare(`
      SELECT count FROM rate_limit_logs
      WHERE action = 'xmtp-public-registration-refresh'
    `).first()).toEqual({ count: 1 });
  });

  it('rejects legacy and over-cost public payloads before protected state changes', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/strict-contract';
    const legacy = await postJson('/api/xmtp/subscriptions', {
      endpoint,
      keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) },
      inboxId,
      installationId,
      hmacKeys: { [groupTopic]: 'AQID' },
      preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    });
    expect(legacy.status).toBe(422);
    expect(legacy.headers.get('Cache-Control')).toBe('no-store');

    const oversized = publicRegistrationRequest(endpoint) as any;
    oversized.xmtp.topics = Array.from({ length: 300 }, (_, index) => ({
      topic: `/xmtp/mls/1/g-${index.toString(16).padStart(32, '0')}/proto`,
      hmacKeys: [
        { epoch: '7', key: 'AQID' },
        { epoch: '8', key: 'AQID' },
      ],
    }));
    expect((await postJson('/api/xmtp/subscriptions', oversized)).status).toBe(422);

    const tooLongKey = publicRegistrationRequest(endpoint) as any;
    tooLongKey.xmtp.topics[0].hmacKeys[0].key = 'A'.repeat(1025);
    expect((await postJson('/api/xmtp/subscriptions', tooLongKey)).status).toBe(422);

    const tooManyDecodedKeyBytes = publicRegistrationRequest(endpoint) as any;
    tooManyDecodedKeyBytes.xmtp.topics[0].hmacKeys[0].key = Buffer.alloc(257).toString('base64url');
    expect((await postJson('/api/xmtp/subscriptions', tooManyDecodedKeyBytes)).status).toBe(422);

    const expired = publicRegistrationRequest(endpoint) as any;
    expired.subscription.expirationTime = 0;
    expect((await postJson('/api/xmtp/subscriptions', expired)).status).toBe(422);

    const tooLarge = (await handleApi(new Request(
      'https://vapid.party/api/xmtp/subscriptions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '2000001',
          'CF-Connecting-IP': '203.0.113.10',
        },
        body: '{}',
      }
    ), env)) as Response;
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('Cache-Control')).toBe('no-store');

    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_listener_changes) AS changes,
        (SELECT COUNT(*) FROM xmtp_listener_dirty_routes) AS dirty
    `).first()).toEqual({ subscriptions: 0, identities: 0, topics: 0, changes: 0, dirty: 0 });
  });

  it('keeps a shared physical endpoint key tuple immutable across logical routes', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/shared-capability';
    const secondInbox = '44'.repeat(32);
    const secondInstallation = '55'.repeat(32);
    const thirdInbox = '66'.repeat(32);
    const thirdInstallation = '77'.repeat(32);

    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(endpoint)
    )).status).toBe(201);
    expect((await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(endpoint, {
        inboxId: secondInbox,
        installationId: secondInstallation,
      })
    )).status).toBe(201);

    const before = await db.prepare(`
      SELECT endpoint, p256dh, auth, user_id, channel_id, metadata
      FROM subscriptions WHERE endpoint = ?
    `).bind(endpoint).first();
    expect(before).toMatchObject({
      user_id: null,
      channel_id: null,
      metadata: '{"source":"xmtp","deliveryKind":"web_push"}',
    });
    const rejected = await postJson(
      '/api/xmtp/subscriptions',
      publicRegistrationRequest(endpoint, {
        inboxId: thirdInbox,
        installationId: thirdInstallation,
        p256dh: 'BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
        auth: 'B'.repeat(22),
      })
    );
    expect(rejected.status).toBe(409);
    expect(await db.prepare(`
      SELECT endpoint, p256dh, auth, user_id, channel_id, metadata
      FROM subscriptions WHERE endpoint = ?
    `).bind(endpoint).first()).toEqual(before);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM xmtp_identities
      WHERE inbox_id = ? AND installation_id = ?
    `).bind(thirdInbox, thirdInstallation).first()).toEqual({ count: 0 });
  });

  it('serializes concurrent first claims for one previously unseen endpoint', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/concurrent-capability';
    const secondInbox = '44'.repeat(32);
    const secondInstallation = '55'.repeat(32);
    const [first, second] = await Promise.all([
      postJson('/api/xmtp/subscriptions', publicRegistrationRequest(endpoint)),
      postJson('/api/xmtp/subscriptions', publicRegistrationRequest(endpoint, {
        inboxId: secondInbox,
        installationId: secondInstallation,
        p256dh: 'BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
        auth: 'B'.repeat(22),
      })),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions WHERE active = 1) AS logical
    `).first()).toEqual({ subscriptions: 1, identities: 1, logical: 1 });
  });

  it('does not let invalid receipts consume the valid diagnostic test quota', async () => {
    await db.prepare(`
      UPDATE apps SET rate_limit = '{"maxNotificationsPerMinute":1}' WHERE id = 'converge'
    `).run();
    const result = await new D1XmtpStore(env).upsertRegistration(registration());
    const diagnostics = requiredDiagnostics(result);
    expect((await post('/api/xmtp/status/test', 'Z'.repeat(43))).status).toBe(404);
    expect((await post(diagnostics.testPath, diagnostics.receipt)).status).toBe(202);
    expect((await post(diagnostics.testPath, diagnostics.receipt)).status).toBe(429);
  });

  it('removes endpoint keys, topics, and route capabilities after a terminal provider response', async () => {
    const result = await new D1XmtpStore(env).upsertRegistration(registration());
    const diagnostics = requiredDiagnostics(result);
    await disableSubscription(db, result.subscriptionId);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM xmtp_identities) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS logical,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics,
        (SELECT COUNT(*) FROM xmtp_topic_hmac_keys) AS hmacs
    `).first()).toEqual({ subscriptions: 0, identities: 0, logical: 0, topics: 0, hmacs: 0 });
    expect((await post(diagnostics.statusPath, diagnostics.receipt)).status).toBe(404);
  });

  it('compacts short-lived diagnostic and rate-limit history', async () => {
    const result = await new D1XmtpStore(env).upsertRegistration(registration());
    const old = '2020-01-01T00:00:00.000Z';
    await db.batch([
      db.prepare(`
        INSERT INTO rate_limit_logs (id, app_id, action, count, window_start, created_at)
        VALUES ('old-rate', 'converge', 'old', 1, ?, ?)
      `).bind(old, old),
      db.prepare(`
        INSERT INTO delivery_attempts (
          id, app_id, subscription_id, event_type, payload_json, created_at, updated_at
        ) VALUES ('old-diagnostic', 'converge', ?, 'vapid.diagnostic', '{}', ?, ?)
      `).bind(result.subscriptionId, old, old),
    ]);
    await compactOperationalHistory(db);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM rate_limit_logs WHERE id = 'old-rate') AS rates,
        (SELECT COUNT(*) FROM delivery_attempts WHERE id = 'old-diagnostic') AS diagnostics
    `).first()).toEqual({ rates: 0, diagnostics: 0 });
  });

  it('drains more eligible history than the maximum sustained public-send rate', async () => {
    const old = '2020-01-01T00:00:00.000Z';
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
      INSERT INTO rate_limit_logs (
        id, app_id, action, count, window_start, created_at
      )
      SELECT
        'old-rate-' || value,
        'converge',
        'old-action-' || value,
        1,
        ?,
        ?
      FROM sequence
    `).bind(old, old).run();

    const first = await compactOperationalHistory(db);
    expect(first).toMatchObject({
      batchLimit: 5000,
      deletedRows: 5000,
      backlogLikely: true,
      oldestEligibleAt: old,
    });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM rate_limit_logs WHERE window_start = ?
    `).bind(old).first()).toEqual({ count: 1 });

    const second = await compactOperationalHistory(db);
    expect(second).toMatchObject({
      batchLimit: 5000,
      deletedRows: 1,
      backlogLikely: false,
    });
  });

  it('saturates denied rate counters without writing on every abusive retry', async () => {
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(await checkAndIncrementRateLimit(db, 'converge', 'saturation-test', 1));
    }
    expect(results.map((result) => result.allowed)).toEqual([true, false, false]);
    expect(await db.prepare(`
      SELECT count FROM rate_limit_logs WHERE action = 'saturation-test'
    `).first()).toEqual({ count: 2 });
  });
});
