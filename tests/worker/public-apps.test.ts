import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { handleApi } from '../../src/worker/api';
import { insertDeliveryAttempt, updateDeliveryAttempt } from '../../src/worker/db';
import { appDomainRecord } from '../../src/worker/domain';
import { bytesToBase64Url, bytesToHex, sha256Hex } from '../../src/worker/encoding';
import type { Env, PushQueueJob } from '../../src/worker/types';
import { migrationStatements } from './migration-helpers';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);

async function applyMigration(db: D1Database, path: string): Promise<void> {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [index, statement] of migrationStatements(sql).entries()) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      throw new Error(`Migration statement ${index + 1} failed: ${statement.slice(0, 120)}`, {
        cause: error,
      });
    }
  }
}

interface CreatedApp {
  app: {
    id: string;
    name: string;
    publicVapidKey: string;
    createdAt: string;
  };
  appSecret: string;
}

interface PublicSubscriptionResult {
  subscriptionId: string;
  endpoint: string;
  createdAt: string;
  management: {
    token: string;
    deletePath: string;
  };
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { success: boolean; data?: T; error?: string };
  expect(body.success, body.error).toBe(true);
  expect(body.data).toBeDefined();
  return body.data as T;
}

describe('anonymous public app contract', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let queued: PushQueueJob[];
  let appSecrets: Map<string, string>;
  let publishedBatches: Array<Array<MessageSendRequest<PushQueueJob>>>;
  let singleSendCount: number;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-15',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'public-app-test-db' },
    });
    db = await miniflare.getD1Database('DB');

    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
    ]) await applyMigration(db, path);

    // Exercise 0006 as a real additive migration over an existing app and
    // delivery row containing notification copy from the former contract.
    await db.batch([
      db.prepare(`
        INSERT INTO apps (
          id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
        ) VALUES ('legacy', 'Legacy', 'operator', 'legacy-secret', 'legacy-public', 'legacy-private')
      `),
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('legacy-subscription', 'legacy', 'https://fcm.googleapis.com/fcm/send/legacy', ?, ?)
      `).bind(p256dh, auth),
      db.prepare(`
        INSERT INTO delivery_attempts (
          id, app_id, subscription_id, event_type, status, payload_json
        ) VALUES (
          'legacy-attempt', 'legacy', 'legacy-subscription', 'generic.push', 'sent',
          '{"title":"migration-secret","body":"must disappear"}'
        )
      `),
    ]);
    await applyMigration(db, '../../migrations/d1/0006_public_apps_and_usage.sql');
    await applyMigration(db, '../../migrations/d1/0007_public_xmtp_and_callbacks.sql');

    queued = [];
    appSecrets = new Map();
    publishedBatches = [];
    singleSendCount = 0;
    const emptyMetrics = { backlogCount: 0, backlogBytes: 0 };
    env = {
      DB: db,
      PUSH_QUEUE: {
        metrics: async () => emptyMetrics,
        send: async (message: PushQueueJob) => {
          singleSendCount += 1;
          queued.push(message);
          return { metadata: { metrics: emptyMetrics } };
        },
        sendBatch: async (messages: Iterable<MessageSendRequest<PushQueueJob>>) => {
          const batch = [...messages];
          publishedBatches.push(batch);
          queued.push(...batch.map((message) => message.body));
          return { metadata: { metrics: emptyMetrics } };
        },
      },
      RELAY_COORDINATOR: {} as DurableObjectNamespace,
      INTERNAL_INGEST_TOKEN: 'public-test-salt',
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await miniflare.dispose();
  });

  async function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      appSecret?: string;
      bearer?: string;
      ip?: string;
    } = {}
  ): Promise<Response> {
    return (await handleApi(new Request(`https://vapid.party${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'CF-Connecting-IP': options.ip ?? '203.0.113.40',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.appSecret ? { 'X-API-Key': options.appSecret } : {}),
        ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }), env)) as Response;
  }

  async function createApp(
    overrides: Partial<{
      name: string;
      description: string;
      domain: string;
      leaderboardOptIn: boolean;
    }> = {}
  ): Promise<CreatedApp> {
    const response = await request('/api/apps', {
      method: 'POST',
      body: { name: 'Public Test App', ...overrides },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const created = await data<CreatedApp>(response);
    appSecrets.set(created.app.id, created.appSecret);
    return created;
  }

  async function subscribe(
    appId: string,
    endpoint: string,
    suffix = ''
  ): Promise<{ response: Response; result?: PublicSubscriptionResult }> {
    const body = {
      endpoint,
      keys: { p256dh, auth },
    };
    const ticketResponse = await request(`/api/apps/${appId}/enrollment-ticket`, {
      method: 'POST',
      appSecret: appSecrets.get(appId),
      body,
      ip: `203.0.113.${50 + suffix.length}`,
    });
    if (!ticketResponse.ok) return { response: ticketResponse };
    const ticket = await data<{ token: string; expiresAt: string }>(ticketResponse);
    const response = await request(`/api/apps/${appId}/subscriptions`, {
      method: 'POST',
      body,
      bearer: ticket.token,
      ip: `203.0.113.${50 + suffix.length}`,
    });
    return response.ok
      ? { response, result: await data<PublicSubscriptionResult>(response) }
      : { response };
  }

  async function authenticatedSubscribe(
    created: CreatedApp,
    endpoint: string
  ): Promise<{ id: string; endpoint: string; createdAt: string }> {
    const response = await request('/api/subscribe', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        endpoint,
        keys: { p256dh, auth },
      },
    });
    expect(response.status).toBe(201);
    return data(response);
  }

  async function ownedXmtpRegistration(
    delivery: Record<string, unknown> = {
      kind: 'web_push',
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/public-xmtp',
        expirationTime: null,
        keys: { p256dh, auth },
      },
    },
    options: { inboxHandle?: string } = {}
  ): Promise<{ registration: Record<string, unknown>; keyPair: CryptoKeyPair; publicKey: string }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    ) as CryptoKeyPair;
    const publicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer
    );
    const installationId = bytesToHex(publicKeyBytes);
    return {
      keyPair,
      publicKey: bytesToBase64Url(publicKeyBytes),
      registration: {
        version: 1,
        identity: { inboxId: '11'.repeat(32), installationId },
        delivery,
        xmtp: {
          env: 'production',
          topics: [
            {
              topic: `/xmtp/mls/1/g-${'33'.repeat(16)}/proto`,
              hmacKeys: [{ epoch: '7', key: 'AQID' }],
            },
            {
              topic: `/xmtp/mls/1/w-${installationId}/proto`,
              hmacKeys: [],
            },
          ],
          topicSource: 'conversations.hmacKeys',
        },
        notification: { inboxHandle: options.inboxHandle ?? 'opaque_public_xmtp' },
        preferences: { minimalPayloadOnly: true, plaintextPreview: false },
        registeredAt: new Date().toISOString(),
      },
    };
  }

  async function mintOwnedXmtpTicket(
    created: CreatedApp,
    registration: Record<string, unknown>
  ): Promise<{ token: string; expiresAt: string; signatureText: string }> {
    const response = await request(`/api/apps/${created.app.id}/xmtp/enrollment-ticket`, {
      method: 'POST',
      appSecret: created.appSecret,
      body: { registration },
    });
    expect(response.status).toBe(200);
    return data(response);
  }

  async function signInstallationTicket(
    keyPair: CryptoKeyPair,
    ticket: string
  ): Promise<string> {
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
      { name: 'Ed25519' },
      keyPair.privateKey,
      new TextEncoder().encode(ticket)
    )));
  }

  it('applies 0006 without retaining legacy notification copy', async () => {
    const attempt = await db.prepare(`
      SELECT payload_json, last_error FROM delivery_attempts WHERE id = 'legacy-attempt'
    `).first<{ payload_json: string; last_error: string | null }>();
    expect(attempt).toEqual({ payload_json: '{}', last_error: null });

    const backfill = await db.prepare(`
      SELECT event_type, queued_count, sent_count, failed_count, expired_count
      FROM app_usage_daily WHERE app_id = 'legacy'
    `).first();
    expect(backfill).toEqual({
      event_type: 'generic.push',
      queued_count: 1,
      sent_count: 1,
      failed_count: 0,
      expired_count: 0,
    });

    const droppedUsageTable = await db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_logs'
    `).first();
    expect(droppedUsageTable).toBeNull();

    await db.prepare(`
      INSERT INTO delivery_attempts (
        id, app_id, subscription_id, event_type, status, payload_json, last_error
      ) VALUES (
        'cutover-attempt', 'legacy', 'legacy-subscription', 'generic.push', 'failed',
        '{"title":"written-by-old-worker"}', 'raw provider response'
      )
    `).run();
    expect(await db.prepare(`
      SELECT payload_json, last_error FROM delivery_attempts WHERE id = 'cutover-attempt'
    `).first()).toEqual({ payload_json: '{}', last_error: null });
    await db.prepare(`
      UPDATE delivery_attempts
      SET payload_json = '{"body":"reintroduced"}', last_error = 'https://provider.invalid/raw'
      WHERE id = 'cutover-attempt'
    `).run();
    expect(await db.prepare(`
      SELECT payload_json, last_error FROM delivery_attempts WHERE id = 'cutover-attempt'
    `).first()).toEqual({ payload_json: '{}', last_error: null });

    const legacy = await request('/api/vapid/public-key', { appSecret: 'legacy-secret' });
    expect(legacy.status).toBe(200);
    expect(await data(legacy)).toEqual({ publicKey: 'legacy-public' });

    const legacyStats = await request('/api/apps/legacy/stats', {
      appSecret: 'legacy-secret',
    });
    expect(legacyStats.status).toBe(404);
    const legacyDelete = await request('/api/apps/legacy', {
      method: 'DELETE',
      appSecret: 'legacy-secret',
    });
    expect(legacyDelete.status).toBe(404);
    expect(await db.prepare(`SELECT id FROM apps WHERE id = 'legacy'`).first()).toEqual({
      id: 'legacy',
    });
  });

  it('returns one app secret while D1 stores only its hash', async () => {
    const created = await createApp();
    expect(created.appSecret).toMatch(/^vp_[0-9a-f]{64}$/);
    expect(created.app.publicVapidKey).not.toBe('');

    const persisted = await db.prepare(`
      SELECT
        apps.api_key,
        apps.vapid_private_key,
        credentials.secret_hash,
        credentials.revoked_at
      FROM apps
      JOIN app_credentials credentials ON credentials.app_id = apps.id
      WHERE apps.id = ?
    `).bind(created.app.id).first<{
      api_key: string;
      vapid_private_key: string;
      secret_hash: string;
      revoked_at: string | null;
    }>();
    expect(persisted).toMatchObject({
      secret_hash: await sha256Hex(created.appSecret),
      revoked_at: null,
    });
    expect(persisted?.api_key).toMatch(/^disabled:/);
    expect(persisted?.api_key).not.toBe(created.appSecret);
    expect(persisted?.vapid_private_key).not.toContain(created.appSecret);

    const credentialRows = await db.prepare(`
      SELECT * FROM app_credentials WHERE app_id = ?
    `).bind(created.app.id).all();
    expect(JSON.stringify(credentialRows.results)).not.toContain(created.appSecret);
    expect(await db.prepare(`SELECT rate_limit FROM apps WHERE id = ?`)
      .bind(created.app.id).first()).toEqual({
      rate_limit: JSON.stringify({
        maxNotificationsPerMinute: 60,
        maxNotificationsPerDay: 10000,
        maxSubscriptions: 150,
      }),
    });
  });

  it('does not charge the global app-creation bucket after a scoped denial', async () => {
    const created = await createApp({ name: 'Rate Seed' });
    expect(created.app.id).not.toBe('');
    await db.prepare(`
      UPDATE public_rate_limits SET count = 20
      WHERE action = 'app-create-scoped'
    `).run();

    const denied = await request('/api/apps', {
      method: 'POST',
      body: { name: 'Must Be Scoped Out' },
    });
    expect(denied.status).toBe(429);
    expect(await db.prepare(`
      SELECT count FROM public_rate_limits
      WHERE scope_hash = 'global' AND action = 'app-create-global'
    `).first()).toEqual({ count: 1 });
  });

  it('fails closed before persisting an app when the anonymous app ceiling is full', async () => {
    await db.prepare(`
      UPDATE public_platform_capacity SET app_count = 25000 WHERE id = 1
    `).run();
    const before = await db.prepare('SELECT COUNT(*) AS count FROM apps').first();
    const response = await request('/api/apps', {
      method: 'POST',
      body: { name: 'Over Capacity' },
      ip: '203.0.113.99',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'CAPACITY_EXCEEDED',
      details: { maxPublicApps: 25_000 },
    });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM apps').first()).toEqual(before);
  });

  it('rotates the app secret once and revokes the previous capability', async () => {
    const created = await createApp();
    const response = await request(`/api/apps/${created.app.id}/secret/rotate`, {
      method: 'POST',
      appSecret: created.appSecret,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const rotated = await data<{ appId: string; appSecret: string }>(response);
    expect(rotated).toMatchObject({
      appId: created.app.id,
      appSecret: expect.stringMatching(/^vp_[0-9a-f]{64}$/),
    });
    expect(rotated.appSecret).not.toBe(created.appSecret);

    expect((await request(`/api/apps/${created.app.id}/stats`, {
      appSecret: created.appSecret,
    })).status).toBe(401);
    expect((await request(`/api/apps/${created.app.id}/stats`, {
      appSecret: rotated.appSecret,
    })).status).toBe(200);

    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM app_credentials
      WHERE app_id = ? AND revoked_at IS NULL
    `).bind(created.app.id).first()).toEqual({ count: 1 });
  });

  it('authenticates private stats and rejects a secret from another app', async () => {
    const first = await createApp({ name: 'First' });
    const second = await createApp({ name: 'Second' });

    const stats = await request(`/api/apps/${first.app.id}/stats`, {
      appSecret: first.appSecret,
    });
    expect(stats.status).toBe(200);
    expect(stats.headers.get('Cache-Control')).toBe('no-store');
    expect(stats.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const statsBody = await data<Record<string, unknown>>(stats);
    expect(statsBody).toMatchObject({
      app: {
        id: first.app.id,
        name: 'First',
        publicVapidKey: first.app.publicVapidKey,
      },
      subscriptions: { active: 0, xmtpRegistrations: 0 },
    });
    expect(JSON.stringify(statsBody)).not.toContain(first.appSecret);
    expect(JSON.stringify(statsBody)).not.toContain('vapidPrivateKey');

    const mismatch = await request(`/api/apps/${first.app.id}/stats`, {
      appSecret: second.appSecret,
    });
    expect(mismatch.status).toBe(403);
    const mismatchBody = await mismatch.json() as { code: string };
    expect(mismatchBody.code).toBe('FORBIDDEN');

    const invalidPatch = await request(`/api/apps/${first.app.id}/profile`, {
      method: 'PATCH',
      appSecret: first.appSecret,
      body: {},
    });
    expect(invalidPatch.status).toBe(422);
    expect(invalidPatch.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('publishes only the app id and public VAPID key from public config', async () => {
    const created = await createApp({ name: 'Not Public Metadata', description: 'private-ish copy' });
    const response = await request(`/api/apps/${created.app.id}/vapid-public-key`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const config = await data<Record<string, unknown>>(response);
    expect(config).toEqual({
      appId: created.app.id,
      publicKey: created.app.publicVapidKey,
    });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(created.appSecret);
    expect(serialized).not.toContain('Not Public Metadata');
    expect(serialized).not.toContain('private');
  });

  it('allows provider-scoped enrollment and requires its hashed management token to delete', async () => {
    const created = await createApp();
    const invalid = await subscribe(created.app.id, 'https://example.com/push-target');
    expect(invalid.response.status).toBe(422);

    const forgedRoutingLabel = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'POST',
      body: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/forged-route',
        keys: { p256dh, auth },
        userId: 'victim-user',
      },
    });
    expect(forgedRoutingLabel.status).toBe(422);

    const endpoint = 'https://fcm.googleapis.com/fcm/send/public-test-token';
    const missingTicket = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'POST',
      body: { endpoint, keys: { p256dh, auth } },
    });
    expect(missingTicket.status).toBe(401);

    const ticketResponse = await request(`/api/apps/${created.app.id}/enrollment-ticket`, {
      method: 'POST',
      appSecret: created.appSecret,
      body: { endpoint, keys: { p256dh, auth } },
    });
    expect(ticketResponse.status).toBe(200);
    expect(ticketResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(ticketResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const ticket = await data<{ token: string; expiresAt: string }>(ticketResponse);
    expect(ticket.token).toMatch(/^vpet1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());

    const expiredTicketRequest = await request(`/api/apps/${created.app.id}/enrollment-ticket`, {
      method: 'POST',
      appSecret: created.appSecret,
      body: { endpoint, expirationTime: 0, keys: { p256dh, auth } },
    });
    expect(expiredTicketRequest.status).toBe(422);

    const mismatchedTicket = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: {
        endpoint: `${endpoint}-different`,
        keys: { p256dh, auth },
      },
    });
    expect(mismatchedTicket.status).toBe(401);

    const other = await createApp({ name: 'Other Ticket App' });
    const wrongAppTicket = await request(`/api/apps/${other.app.id}/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: { endpoint, keys: { p256dh, auth } },
    });
    expect(wrongAppTicket.status).toBe(401);

    const enrolled = await subscribe(created.app.id, endpoint);
    expect(enrolled.response.status).toBe(201);
    expect(enrolled.response.headers.get('Cache-Control')).toBe('no-store');
    expect(enrolled.result?.management.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await db.prepare(`
      SELECT management_token_hash FROM subscriptions WHERE id = ?
    `).bind(enrolled.result?.subscriptionId).first<{ management_token_hash: string }>();
    expect(stored?.management_token_hash).toBe(
      await sha256Hex(enrolled.result?.management.token as string)
    );
    expect(stored?.management_token_hash).not.toBe(enrolled.result?.management.token);

    const wrongDelete = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'DELETE',
      bearer: 'Z'.repeat(43),
      body: { endpoint },
    });
    expect(wrongDelete.status).toBe(401);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM subscriptions WHERE id = ?
    `).bind(enrolled.result?.subscriptionId).first()).toEqual({ count: 1 });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM rate_limit_logs
      WHERE app_id = ? AND action = 'subscription-public-delete'
    `).bind(created.app.id).first()).toEqual({ count: 0 });

    const deleted = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'DELETE',
      bearer: enrolled.result?.management.token,
      body: { endpoint },
    });
    expect(deleted.status).toBe(200);
    expect(await data(deleted)).toEqual({ disabled: true });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM subscriptions WHERE id = ?
    `).bind(enrolled.result?.subscriptionId).first()).toEqual({ count: 0 });
  });

  it('rate-limits public delete verification before app lookup or endpoint locks', async () => {
    const created = await createApp();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/delete-preauth';
    const junk = await request(`/api/apps/${created.app.id}/subscriptions`, {
      method: 'DELETE',
      bearer: 'Z'.repeat(43),
      body: { endpoint },
    });
    expect(junk.status).toBe(200);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM rate_limit_logs
      WHERE app_id = ? AND action = 'subscription-public-delete'
    `).bind(created.app.id).first()).toEqual({ count: 0 });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM xmtp_registration_mutation_locks
    `).first()).toEqual({ count: 0 });

    await db.prepare(`
      UPDATE public_rate_limits SET count = 600
      WHERE action = 'subscription-delete-verify'
    `).run();
    const limited = await request('/api/apps/does-not-exist/subscriptions', {
      method: 'DELETE',
      body: { malformed: true },
    });
    expect(limited.status).toBe(429);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM xmtp_registration_mutation_locks
    `).first()).toEqual({ count: 0 });
  });

  it('fails closed before storing a subscription when public capacity is full', async () => {
    const created = await createApp();
    await db.prepare(`
      UPDATE public_platform_capacity SET subscription_count = 250000 WHERE id = 1
    `).run();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/subscription-capacity';
    const enrolled = await subscribe(created.app.id, endpoint);
    expect(enrolled.response.status).toBe(503);
    expect(await enrolled.response.json()).toMatchObject({
      success: false,
      code: 'CAPACITY_EXCEEDED',
      details: { maxPublicSubscriptions: 250_000 },
    });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM subscriptions WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({ count: 0 });
  });

  it('enrolls public XMTP only with an exact ticket and installation-key proof', async () => {
    const created = await createApp();
    const { registration, keyPair, publicKey } = await ownedXmtpRegistration();

    const enrolled = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      body: { registration, proof: { publicKey, signature: 'AA' } },
    });
    expect(enrolled.status).toBe(422);

    const ticket = await mintOwnedXmtpTicket(created, registration);
    expect(ticket.token).toBe(ticket.signatureText);
    expect(ticket.token).toMatch(/^vpxet1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const signature = await signInstallationTicket(keyPair, ticket.signatureText);
    const authorizedEnrollment = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: { registration, proof: { publicKey, signature } },
    });
    expect(authorizedEnrollment.status).toBe(201);
    expect(authorizedEnrollment.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(authorizedEnrollment.headers.get('Access-Control-Allow-Headers'))
      .toContain('X-Vapid-Party-Management-Token');
    const result = await data<{
      created: boolean;
      diagnostics: { receipt: string; statusPath: string; testPath: string };
    }>(authorizedEnrollment);
    expect(result).toMatchObject({
      created: true,
      diagnostics: {
        statusPath: `/api/apps/${created.app.id}/xmtp/status`,
        testPath: `/api/apps/${created.app.id}/xmtp/status/test`,
      },
    });
    expect(result.diagnostics.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const status = await request(`/api/apps/${created.app.id}/xmtp/status`, {
      method: 'POST',
      bearer: result.diagnostics.receipt,
      body: {},
    });
    expect(status.status).toBe(200);
    expect(status.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const replay = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: { registration, proof: { publicKey, signature } },
    });
    expect(replay.status).toBe(200);
    const replayResult = await data<{ created: boolean; diagnostics?: unknown }>(replay);
    expect(replayResult).toEqual(expect.objectContaining({ created: false }));
    expect(replayResult.diagnostics).toBeUndefined();

    const tampered = structuredClone(registration);
    (tampered.notification as { inboxHandle: string }).inboxHandle = 'opaque_tampered_route';
    const rejected = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: { registration: tampered, proof: { publicKey, signature } },
    });
    expect(rejected.status).toBe(401);

    const identity = registration.identity as { inboxId: string; installationId: string };
    const delivery = registration.delivery as { kind: 'web_push'; subscription: { endpoint: string } };
    const deleted = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'DELETE',
      bearer: result.diagnostics.receipt,
      body: {
        version: 1,
        identity,
        delivery: { kind: 'web_push', endpoint: delivery.subscription.endpoint },
        deletedAt: new Date().toISOString(),
      },
    });
    expect(deleted.status).toBe(200);
    expect(await data(deleted)).toEqual({ disabled: true });

    const genericBypass = await request('/api/xmtp/registrations', {
      method: 'POST',
      appSecret: created.appSecret,
      body: registration,
    });
    expect(genericBypass.status).toBe(403);
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM xmtp_identities WHERE app_id = ?) AS identities,
        (SELECT COUNT(*) FROM xmtp_subscriptions) AS registrations,
        (SELECT COUNT(*) FROM xmtp_topics) AS topics
    `).bind(created.app.id).first()).toEqual({ identities: 0, registrations: 0, topics: 0 });
  });

  it('restricts XMTP callbacks to the fresh exact verified app domain', async () => {
    const created = await createApp({ domain: 'notify.example.com' });
    const wrong = await ownedXmtpRegistration({
      kind: 'https_callback',
      url: 'https://other.example.com/api/xmtp',
    });
    const unverified = await request(`/api/apps/${created.app.id}/xmtp/enrollment-ticket`, {
      method: 'POST',
      appSecret: created.appSecret,
      body: { registration: wrong.registration },
    });
    expect(unverified.status).toBe(409);

    const timestamp = new Date().toISOString();
    await db.prepare(`
      UPDATE app_public_profiles
      SET domain_verification_status = 'verified',
          domain_verified_at = ?,
          domain_last_checked_at = ?,
          domain_verified_vapid_key = ?
      WHERE app_id = ?
    `).bind(timestamp, timestamp, created.app.publicVapidKey, created.app.id).run();
    const wrongDomain = await request(`/api/apps/${created.app.id}/xmtp/enrollment-ticket`, {
      method: 'POST',
      appSecret: created.appSecret,
      body: { registration: wrong.registration },
    });
    expect(wrongDomain.status).toBe(422);

    const staleTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    await db.prepare(`
      UPDATE app_public_profiles SET domain_last_checked_at = ? WHERE app_id = ?
    `).bind(staleTimestamp, created.app.id).run();
    const dnsRecord = appDomainRecord(
      'notify.example.com',
      created.app.id,
      created.app.publicVapidKey
    );
    const dnsFetch = vi.fn(async () => new Response(JSON.stringify({
      Status: 0,
      Answer: [{ name: `${dnsRecord.name}.`, type: 16, data: `"${dnsRecord.value}"` }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', dnsFetch);

    const owned = await ownedXmtpRegistration({
      kind: 'https_callback',
      url: 'https://notify.example.com/api/xmtp',
    });
    const ticket = await mintOwnedXmtpTicket(created, owned.registration);
    expect(dnsFetch).toHaveBeenCalledOnce();
    expect((await db.prepare(`
      SELECT domain_last_checked_at FROM app_public_profiles WHERE app_id = ?
    `).bind(created.app.id).first<{ domain_last_checked_at: string }>())?.domain_last_checked_at)
      .not.toBe(staleTimestamp);
    const signature = await signInstallationTicket(owned.keyPair, ticket.signatureText);
    const enrolled = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: ticket.token,
      body: {
        registration: owned.registration,
        proof: { publicKey: owned.publicKey, signature },
      },
    });
    expect(enrolled.status).toBe(201);
    expect(await db.prepare(`
      SELECT endpoint, delivery_kind, p256dh, auth
      FROM subscriptions WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({
      endpoint: 'https://notify.example.com/api/xmtp',
      delivery_kind: 'https_callback',
      p256dh: '',
      auth: '',
    });

    const replacement = await ownedXmtpRegistration({
      kind: 'https_callback',
      url: 'https://notify.example.com/api/xmtp',
    });
    const replacementTicket = await mintOwnedXmtpTicket(created, replacement.registration);
    const invalidReplacement = await request(
      `/api/apps/${created.app.id}/xmtp/subscriptions`,
      {
        method: 'POST',
        bearer: replacementTicket.token,
        body: {
          registration: replacement.registration,
          proof: {
            publicKey: replacement.publicKey,
            signature: bytesToBase64Url(new Uint8Array(64).fill(7)),
          },
        },
      }
    );
    expect(invalidReplacement.status).toBe(401);
    expect(await db.prepare(`
      SELECT installation_id FROM xmtp_identities WHERE app_id = ? AND inbox_handle = ?
    `).bind(created.app.id, 'opaque_public_xmtp').first()).toEqual({
      installation_id: (owned.registration.identity as { installationId: string }).installationId,
    });

    const replacementSignature = await signInstallationTicket(
      replacement.keyPair,
      replacementTicket.signatureText
    );
    const replaced = await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: replacementTicket.token,
      body: {
        registration: replacement.registration,
        proof: { publicKey: replacement.publicKey, signature: replacementSignature },
      },
    });
    expect(replaced.status).toBe(201);
    expect(await db.prepare(`
      SELECT installation_id FROM xmtp_identities WHERE app_id = ? AND inbox_handle = ?
    `).bind(created.app.id, 'opaque_public_xmtp').all()).toMatchObject({
      results: [{
        installation_id: (replacement.registration.identity as { installationId: string })
          .installationId,
      }],
    });

    const other = await ownedXmtpRegistration({
      kind: 'https_callback',
      url: 'https://notify.example.com/api/xmtp',
    }, { inboxHandle: 'opaque_other_recipient' });
    const otherTicket = await mintOwnedXmtpTicket(created, other.registration);
    const otherSignature = await signInstallationTicket(other.keyPair, otherTicket.signatureText);
    expect((await request(`/api/apps/${created.app.id}/xmtp/subscriptions`, {
      method: 'POST',
      bearer: otherTicket.token,
      body: {
        registration: other.registration,
        proof: { publicKey: other.publicKey, signature: otherSignature },
      },
    })).status).toBe(201);

    const revoked = await request(`/api/apps/${created.app.id}/xmtp/callback-routes`, {
      method: 'DELETE',
      appSecret: created.appSecret,
      body: { inboxHandle: 'opaque_public_xmtp' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await data<{ disabled: number }>(revoked)).toEqual({ disabled: 1 });
    expect(await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM xmtp_identities
          WHERE app_id = ? AND inbox_handle = 'opaque_public_xmtp') AS revoked_count,
        (SELECT COUNT(*) FROM xmtp_identities
          WHERE app_id = ? AND inbox_handle = 'opaque_other_recipient') AS active_count,
        (SELECT COUNT(*) FROM subscriptions
          WHERE app_id = ? AND delivery_kind = 'https_callback') AS endpoint_count
    `).bind(created.app.id, created.app.id, created.app.id).first()).toEqual({
      revoked_count: 0,
      active_count: 1,
      endpoint_count: 1,
    });
    const repeated = await request(`/api/apps/${created.app.id}/xmtp/callback-routes`, {
      method: 'DELETE',
      appSecret: created.appSecret,
      body: { inboxHandle: 'opaque_public_xmtp' },
    });
    expect(await data<{ disabled: number }>(repeated)).toEqual({ disabled: 0 });
  });

  it('keeps notification content transient while recording aggregate queued usage', async () => {
    const created = await createApp();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/transient-payload';
    const enrolled = await subscribe(created.app.id, endpoint);
    const sentinel = 'content-must-stay-in-the-queue';

    const sent = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: [enrolled.result?.subscriptionId],
        payload: { title: 'Transient', body: sentinel, data: { sentinel } },
      },
    });
    expect(sent.status).toBe(202);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ body: sentinel, data: { sentinel } });

    const attempt = await db.prepare(`
      SELECT payload_json, last_error FROM delivery_attempts
      WHERE app_id = ? AND event_type = 'generic.push'
    `).bind(created.app.id).first<{ payload_json: string; last_error: string | null }>();
    expect(attempt).toEqual({ payload_json: '{}', last_error: null });
    expect(JSON.stringify(attempt)).not.toContain(sentinel);

    const stats = await request(`/api/apps/${created.app.id}/stats`, {
      appSecret: created.appSecret,
    });
    expect(await data(stats)).toMatchObject({
      usage: { todayUtc: { queued: 1, providerAccepted: 0 } },
    });
  });

  it('publishes one bounded JSON batch instead of partially sending recipients', async () => {
    const created = await createApp();
    const first = await authenticatedSubscribe(
      created,
      'https://fcm.googleapis.com/fcm/send/batch-one'
    );
    const second = await authenticatedSubscribe(
      created,
      'https://fcm.googleapis.com/fcm/send/batch-two'
    );

    const response = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: [first.id, second.id],
        payload: { title: 'One atomic batch' },
      },
    });

    expect(response.status).toBe(202);
    expect(singleSendCount).toBe(0);
    expect(publishedBatches).toHaveLength(1);
    expect(publishedBatches[0]).toHaveLength(2);
    expect(publishedBatches[0].map((message) => message.contentType)).toEqual(['json', 'json']);
    expect(publishedBatches[0].map((message) => message.body.subscriptionId).sort())
      .toEqual([first.id, second.id].sort());
  });

  it('returns 503 and atomically removes attempts and queued usage when batch publish fails', async () => {
    const created = await createApp();
    const first = await authenticatedSubscribe(
      created,
      'https://fcm.googleapis.com/fcm/send/rollback-one'
    );
    const second = await authenticatedSubscribe(
      created,
      'https://fcm.googleapis.com/fcm/send/rollback-two'
    );
    env.PUSH_QUEUE.sendBatch = async () => {
      throw new Error('simulated queue outage');
    };

    const response = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: [first.id, second.id],
        payload: { title: 'Must roll back' },
      },
    });
    const body = await response.json() as { success: boolean; code: string; error: string };

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      code: 'PUSH_FAILED',
      error: 'Push queue is temporarily unavailable',
    });
    expect(singleSendCount).toBe(0);
    expect(queued).toEqual([]);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM delivery_attempts WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({ count: 0 });
    expect(await db.prepare(`
      SELECT COALESCE(SUM(queued_count), 0) AS queued
      FROM app_usage_daily WHERE app_id = ? AND event_type = 'generic.push'
    `).bind(created.app.id).first()).toEqual({ queued: 0 });
  });

  it('rejects recipient, Web Push payload, and Queue batch bounds before mutation', async () => {
    const created = await createApp();
    const ids = Array.from({ length: 101 }, (_, index) => `bounded-${index}`);
    await db.batch(ids.map((id, index) => db.prepare(`
      INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      id,
      created.app.id,
      `https://fcm.googleapis.com/fcm/send/bounded-${index}`,
      p256dh,
      auth
    )));

    const tooMany = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: { payload: { title: 'Too many' } },
    });
    expect(tooMany.status).toBe(422);

    const oversizedPayload = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: ids.slice(0, 1),
        payload: {
          title: 'UTF-8 bound',
          data: { blob: '🔥'.repeat(800) },
        },
      },
    });
    expect(oversizedPayload.status).toBe(413);
    expect(await oversizedPayload.json()).toMatchObject({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      details: {
        maxPayloadBytes: 3_000,
        payloadBytes: expect.any(Number),
      },
    });

    const tooLarge = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: ids.slice(0, 100),
        payload: {
          title: 'Too large as a repeated batch',
          data: { blob: 'x'.repeat(2_500) },
        },
      },
    });
    const tooLargeBody = await tooLarge.json() as {
      success: boolean;
      code: string;
      details: { estimatedBatchBytes: number; maxBatchBytes: number };
    };
    expect(tooLarge.status).toBe(413);
    expect(tooLargeBody).toMatchObject({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      details: { maxBatchBytes: 240_000 },
    });
    expect(tooLargeBody.details.estimatedBatchBytes).toBeGreaterThan(240_000);
    expect(publishedBatches).toEqual([]);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM delivery_attempts WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({ count: 0 });
  });

  it('counts provider acceptance and expiry once while retaining failed-attempt counts', async () => {
    const created = await createApp();
    const subscription = await authenticatedSubscribe(
      created,
      'https://fcm.googleapis.com/fcm/send/idempotent-counters'
    );
    const firstAttempt = await insertDeliveryAttempt(db, {
      appId: created.app.id,
      subscriptionId: subscription.id,
      eventType: 'generic.push',
      payload: { title: 'First' },
    });
    const secondAttempt = await insertDeliveryAttempt(db, {
      appId: created.app.id,
      subscriptionId: subscription.id,
      eventType: 'generic.push',
      payload: { title: 'Second' },
    });

    await updateDeliveryAttempt(db, firstAttempt, { status: 'failed', pushStatus: 503 });
    await updateDeliveryAttempt(db, firstAttempt, { status: 'failed', pushStatus: 503 });
    await Promise.all([
      updateDeliveryAttempt(db, firstAttempt, { status: 'sent', pushStatus: 201 }),
      updateDeliveryAttempt(db, firstAttempt, { status: 'sent', pushStatus: 201 }),
    ]);
    await updateDeliveryAttempt(db, firstAttempt, { status: 'expired', pushStatus: 410 });

    await Promise.all([
      updateDeliveryAttempt(db, secondAttempt, { status: 'expired', pushStatus: 410 }),
      updateDeliveryAttempt(db, secondAttempt, { status: 'expired', pushStatus: 410 }),
    ]);
    await updateDeliveryAttempt(db, secondAttempt, { status: 'sent', pushStatus: 201 });

    expect(await db.prepare(`
      SELECT queued_count, sent_count, failed_count, expired_count
      FROM app_usage_daily
      WHERE app_id = ? AND event_type = 'generic.push'
    `).bind(created.app.id).first()).toEqual({
      queued_count: 2,
      sent_count: 1,
      failed_count: 2,
      expired_count: 1,
    });
    expect(await db.prepare(`
      SELECT id, status, attempts FROM delivery_attempts
      WHERE id IN (?, ?) ORDER BY id
    `).bind(firstAttempt, secondAttempt).all()).toMatchObject({
      results: expect.arrayContaining([
        { id: firstAttempt, status: 'sent', attempts: 3 },
        { id: secondAttempt, status: 'expired', attempts: 1 },
      ]),
    });
  });

  it('charges minute and UTC-day send limits by recipient count before queueing', async () => {
    const created = await createApp();
    const first = await subscribe(
      created.app.id,
      'https://fcm.googleapis.com/fcm/send/weighted-one',
      'one'
    );
    const second = await subscribe(
      created.app.id,
      'https://fcm.googleapis.com/fcm/send/weighted-two',
      'two'
    );
    const subscriptionIds = [first.result?.subscriptionId, second.result?.subscriptionId];
    const sendBody = { subscriptionIds, payload: { title: 'Weighted' } };
    const minuteWindow = new Date();
    minuteWindow.setSeconds(0, 0);
    const dayWindow = new Date();
    dayWindow.setUTCHours(0, 0, 0, 0);
    await db.batch([
      db.prepare(`
        INSERT INTO public_rate_limits (scope_hash, action, window_start, count)
        VALUES ('global', 'public-notification-send-minute', ?, 7)
      `).bind(minuteWindow.toISOString()),
      db.prepare(`
        INSERT INTO public_rate_limits (scope_hash, action, window_start, count)
        VALUES ('global', 'public-notification-send-day', ?, 11)
      `).bind(dayWindow.toISOString()),
    ]);

    const globalSendCounts = async () => db.prepare(`
      SELECT
        (SELECT count FROM public_rate_limits
          WHERE scope_hash = 'global' AND action = 'public-notification-send-minute'
            AND window_start = ?) AS minute_count,
        (SELECT count FROM public_rate_limits
          WHERE scope_hash = 'global' AND action = 'public-notification-send-day'
            AND window_start = ?) AS day_count
    `).bind(minuteWindow.toISOString(), dayWindow.toISOString()).first();

    await db.prepare(`
      UPDATE apps SET rate_limit = ? WHERE id = ?
    `).bind(JSON.stringify({
      maxNotificationsPerMinute: 1,
      maxNotificationsPerDay: 100,
      maxSubscriptions: 10000,
    }), created.app.id).run();
    const minuteDenied = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: sendBody,
    });
    expect(minuteDenied.status).toBe(429);
    expect(queued).toHaveLength(0);
    expect(await db.prepare(`
      SELECT count FROM rate_limit_logs
      WHERE app_id = ? AND action = 'notification-send-minute'
    `).bind(created.app.id).first()).toEqual({ count: 2 });
    expect(await globalSendCounts()).toEqual({ minute_count: 7, day_count: 11 });

    await db.prepare('DELETE FROM rate_limit_logs WHERE app_id = ?').bind(created.app.id).run();
    await db.prepare(`
      UPDATE apps SET rate_limit = ? WHERE id = ?
    `).bind(JSON.stringify({
      maxNotificationsPerMinute: 100,
      maxNotificationsPerDay: 1,
      maxSubscriptions: 10000,
    }), created.app.id).run();
    const dailyDenied = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: sendBody,
    });
    expect(dailyDenied.status).toBe(429);
    expect(queued).toHaveLength(0);
    expect(await db.prepare(`
      SELECT count FROM rate_limit_logs
      WHERE app_id = ? AND action = 'notification-send-day'
    `).bind(created.app.id).first()).toEqual({ count: 2 });
    expect(await globalSendCounts()).toEqual({ minute_count: 7, day_count: 11 });
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM delivery_attempts WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({ count: 0 });
  });

  it('reserves public relay capacity globally before queueing', async () => {
    const created = await createApp();
    const enrolled = await subscribe(
      created.app.id,
      'https://fcm.googleapis.com/fcm/send/public-global-capacity'
    );
    const windowStart = new Date();
    windowStart.setSeconds(0, 0);
    await db.prepare(`
      INSERT INTO public_rate_limits (scope_hash, action, window_start, count)
      VALUES ('global', 'public-notification-send-minute', ?, 2000)
    `).bind(windowStart.toISOString()).run();

    const limited = await request('/api/send', {
      method: 'POST',
      appSecret: created.appSecret,
      body: {
        subscriptionIds: [enrolled.result?.subscriptionId],
        payload: { title: 'Global capacity' },
      },
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      details: { limit: 2_000 },
    });
    expect(publishedBatches).toEqual([]);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count FROM delivery_attempts WHERE app_id = ?
    `).bind(created.app.id).first()).toEqual({ count: 0 });
  });

  it('lists only explicitly opted-in, freshly DNS-verified aggregate profiles', async () => {
    const created = await createApp({
      name: 'Verified Builder',
      description: 'A real public profile',
      domain: 'Example.COM.',
      leaderboardOptIn: true,
    });
    const before = await request('/api/leaderboard');
    expect(await data(before)).toMatchObject({ apps: [] });

    const expectedRecord = appDomainRecord(
      'example.com',
      created.app.id,
      created.app.publicVapidKey
    );
    const dnsFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      Status: 0,
      Answer: [{
        name: `${expectedRecord.name}.`,
        type: 16,
        TTL: 60,
        data: JSON.stringify(expectedRecord.value),
      }],
    }), { headers: { 'Content-Type': 'application/dns-json' } }));
    vi.stubGlobal('fetch', dnsFetch);

    const verified = await request(`/api/apps/${created.app.id}/domain/verify`, {
      method: 'POST',
      appSecret: created.appSecret,
    });
    expect(verified.status).toBe(200);
    expect(await data(verified)).toMatchObject({ domain: 'example.com', status: 'verified' });

    const day = new Date().toISOString().slice(0, 10);
    await db.prepare(`
      INSERT INTO app_usage_daily (
        app_id, day, event_type, queued_count, sent_count, failed_count, expired_count
      ) VALUES (?, ?, 'generic.push', 9, 7, 1, 1)
      ON CONFLICT(app_id, day, event_type) DO UPDATE SET sent_count = 7
    `).bind(created.app.id, day).run();

    const leaderboard = await request('/api/leaderboard');
    const body = await data<{
      generatedAt: string;
      window: { kind: string; days: number };
      apps: Array<Record<string, unknown>>;
    }>(leaderboard);
    expect(body.apps).toEqual([{
      rank: 1,
      appId: created.app.id,
      name: 'Verified Builder',
      description: 'A real public profile',
      verifiedDomain: 'example.com',
      domainVerifiedAt: expect.any(String),
      providerAcceptedLast7Days: 7,
    }]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(created.appSecret);
    expect(serialized).not.toContain(created.app.publicVapidKey);
    expect(serialized).not.toContain('vapidPrivateKey');
    expect(serialized).not.toContain('legacy-subscription');
    expect(serialized).not.toContain('migration-secret');

    await db.prepare(`
      UPDATE app_public_profiles
      SET domain_last_checked_at = ?
      WHERE app_id = ?
    `).bind(
      new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
      created.app.id
    ).run();
    expect(await data<{ apps: unknown[] }>(await request('/api/leaderboard')))
      .toMatchObject({ apps: [] });
    const staleOptIn = await request(`/api/apps/${created.app.id}/profile`, {
      method: 'PATCH',
      appSecret: created.appSecret,
      body: { leaderboardOptIn: true },
    });
    expect(staleOptIn.status).toBe(409);
  });
});
