import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertDeliveryAttempt,
  reconcileStalePushDeliveryAttempts,
} from '../../src/worker/db';
import {
  handleQueue,
  isRetryablePushFailure,
  pushRetryDelaySeconds,
} from '../../src/worker/queue';
import { handleTerminalPushFailure, sendWebPush } from '../../src/worker/push';
import type { Env, PushQueueJob } from '../../src/worker/types';
import { migrationStatements } from './migration-helpers';

vi.mock('../../src/worker/push', () => ({
  sendWebPush: vi.fn(),
  handleTerminalPushFailure: vi.fn(),
}));

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);

async function applyMigration(db: D1Database, path: string): Promise<void> {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const statement of migrationStatements(sql)) await db.prepare(statement).run();
}

interface TestMessage {
  message: Message<PushQueueJob>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function queueMessage(job: PushQueueJob, attempts = 1): TestMessage {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: job,
      attempts,
      ack,
      retry,
    } as Message<PushQueueJob>,
    ack,
    retry,
  };
}

describe('at-least-once Queue delivery claims', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendWebPush).mockResolvedValue({ success: true, statusCode: 201 });
    vi.mocked(handleTerminalPushFailure).mockResolvedValue(undefined);

    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-07-15',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'queue-test-db' },
    });
    db = await miniflare.getD1Database('DB');
    for (const path of [
      '../../migrations/d1/0001_cloudflare_relay.sql',
      '../../migrations/d1/0002_converge_push_contract.sql',
      '../../migrations/d1/0003_xmtp_listener_registry_expand.sql',
      '../../migrations/d1/0004_app_scoped_xmtp_identity_contract.sql',
      '../../migrations/d1/0005_xmtp_diagnostics.sql',
      '../../migrations/d1/0006_public_apps_and_usage.sql',
    ]) await applyMigration(db, path);

    await db.batch([
      db.prepare(`
        INSERT INTO apps (
          id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
        ) VALUES ('app-a', 'App A', 'owner-a', 'key-a', 'public-a', 'private-a')
      `),
      db.prepare(`
        INSERT INTO apps (
          id, name, owner_wallet, api_key, vapid_public_key, vapid_private_key
        ) VALUES ('app-b', 'App B', 'owner-b', 'key-b', 'public-b', 'private-b')
      `),
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('sub-a', 'app-a', 'https://fcm.googleapis.com/fcm/send/a', ?, ?)
      `).bind(p256dh, auth),
      db.prepare(`
        INSERT INTO subscriptions (id, app_id, endpoint, p256dh, auth)
        VALUES ('sub-b', 'app-b', 'https://fcm.googleapis.com/fcm/send/b', ?, ?)
      `).bind(p256dh, auth),
    ]);

    env = {
      DB: db,
      PUSH_QUEUE: {} as Queue<PushQueueJob>,
      RELAY_COORDINATOR: {} as DurableObjectNamespace,
      VAPID_SUBJECT: 'mailto:test@vapid.party',
    };
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  async function insertAttempt(source: PushQueueJob['source'] = 'generic'): Promise<PushQueueJob> {
    const deliveryAttemptId = await insertDeliveryAttempt(db, {
      appId: 'app-a',
      subscriptionId: 'sub-a',
      eventType: source === 'diagnostic'
        ? 'vapid.diagnostic'
        : source === 'xmtp'
          ? 'xmtp.new_message'
          : 'generic.push',
      payload: { type: 'test' },
    });
    return {
      deliveryAttemptId,
      appId: 'app-a',
      subscriptionId: 'sub-a',
      payload: { type: 'test' },
      source,
    };
  }

  async function consume(testMessage: TestMessage): Promise<void> {
    await handleQueue({
      queue: 'vapid-party-push-send',
      messages: [testMessage.message],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<PushQueueJob>, env);
  }

  async function attempt(id: string): Promise<{
    status: string;
    attempts: number;
    push_status: number | null;
    last_error: string | null;
  } | null> {
    return db.prepare(`
      SELECT status, attempts, push_status, last_error
      FROM delivery_attempts WHERE id = ?
    `).bind(id).first();
  }

  async function usage(): Promise<{
    queued: number;
    sent: number;
    failed: number;
    expired: number;
  }> {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(queued_count), 0) AS queued,
        COALESCE(SUM(sent_count), 0) AS sent,
        COALESCE(SUM(failed_count), 0) AS failed,
        COALESCE(SUM(expired_count), 0) AS expired
      FROM app_usage_daily WHERE app_id = 'app-a'
    `).first<{
      queued: number;
      sent: number;
      failed: number;
      expired: number;
    }>();
    return row ?? { queued: 0, sent: 0, failed: 0, expired: 0 };
  }

  it('claims an ordinary delivery, records provider acceptance, and deletes the generic attempt', async () => {
    const job = await insertAttempt();
    const message = queueMessage(job);

    await consume(message);

    expect(sendWebPush).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await attempt(job.deliveryAttemptId)).toBeNull();
    expect(await usage()).toEqual({ queued: 1, sent: 1, failed: 0, expired: 0 });
  });

  it.each(['sent', 'expired'] as const)(
    'acks a duplicate %s attempt without another provider call',
    async (status) => {
      const job = await insertAttempt('xmtp');
      await db.prepare(`
        UPDATE delivery_attempts SET status = ?, updated_at = ? WHERE id = ?
      `).bind(status, new Date().toISOString(), job.deliveryAttemptId).run();
      const message = queueMessage(job, 2);

      await consume(message);

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      if (status === 'expired') {
        expect(handleTerminalPushFailure).toHaveBeenCalledOnce();
        expect(vi.mocked(handleTerminalPushFailure).mock.calls[0]?.[1]).toBe('sub-a');
      }
    }
  );

  it('acks a stale Queue job whose rolled-back attempt is missing', async () => {
    const message = queueMessage({
      deliveryAttemptId: crypto.randomUUID(),
      appId: 'app-a',
      subscriptionId: 'sub-a',
      payload: { type: 'stale' },
      source: 'generic',
    });

    await consume(message);

    expect(sendWebPush).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks a mismatched app/subscription tuple without touching the queued attempt', async () => {
    const job = await insertAttempt();
    const mismatched = queueMessage({ ...job, appId: 'app-b', subscriptionId: 'sub-b' });

    await consume(mismatched);

    expect(sendWebPush).not.toHaveBeenCalled();
    expect(mismatched.ack).toHaveBeenCalledOnce();
    expect(mismatched.retry).not.toHaveBeenCalled();
    expect(await attempt(job.deliveryAttemptId)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('releases a retryable failure exactly once before a later successful generation', async () => {
    const job = await insertAttempt();
    vi.mocked(sendWebPush).mockResolvedValueOnce({
      success: false,
      statusCode: 503,
      error: 'unavailable',
    });
    const first = queueMessage(job, 1);

    await consume(first);

    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(await attempt(job.deliveryAttemptId)).toEqual({
      status: 'queued',
      attempts: 1,
      push_status: 503,
      last_error: 'provider_unavailable',
    });
    expect(await usage()).toEqual({ queued: 1, sent: 0, failed: 1, expired: 0 });

    const second = queueMessage(job, 2);
    await consume(second);

    expect(second.ack).toHaveBeenCalledOnce();
    expect(await attempt(job.deliveryAttemptId)).toBeNull();
    expect(await usage()).toEqual({ queued: 1, sent: 1, failed: 1, expired: 0 });
  });

  it('retries an active lease without calling the provider', async () => {
    const job = await insertAttempt();
    await db.prepare(`
      UPDATE delivery_attempts
      SET status = 'processing', attempts = 1, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), job.deliveryAttemptId).run();
    const message = queueMessage(job, 2);

    await consume(message);

    expect(sendWebPush).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    const delay = message.retry.mock.calls[0]?.[0]?.delaySeconds;
    expect(delay).toBeGreaterThanOrEqual(30);
    expect(delay).toBeLessThanOrEqual(300);
  });

  it('reclaims an expired lease with a new generation', async () => {
    const job = await insertAttempt();
    await db.prepare(`
      UPDATE delivery_attempts
      SET status = 'processing', attempts = 1, updated_at = '2026-01-01T00:00:00.000Z'
      WHERE id = ?
    `).bind(job.deliveryAttemptId).run();
    const message = queueMessage(job, 2);

    await consume(message);

    expect(sendWebPush).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await attempt(job.deliveryAttemptId)).toBeNull();
  });

  it.each([404, 410])(
    'does not clean up an endpoint when terminal HTTP %s loses its lease generation',
    async (statusCode) => {
      const job = await insertAttempt('xmtp');
      vi.mocked(sendWebPush).mockImplementationOnce(async () => {
        // Simulate an expired-lease reclaim while the old provider call is
        // still in flight. Its terminal result no longer owns completion.
        await db.prepare(`
          UPDATE delivery_attempts
          SET attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'processing'
        `).bind(new Date().toISOString(), job.deliveryAttemptId).run();
        return { success: false, terminal: true, statusCode };
      });
      const message = queueMessage(job);

      await consume(message);

      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(handleTerminalPushFailure).not.toHaveBeenCalled();
      expect(await attempt(job.deliveryAttemptId)).toMatchObject({
        status: 'processing',
        attempts: 2,
      });
    }
  );

  it.each([400, 401, 403])(
    'records permanent HTTP %s once and acks without retry',
    async (statusCode) => {
      const job = await insertAttempt();
      vi.mocked(sendWebPush).mockResolvedValueOnce({
        success: false,
        statusCode,
        error: 'permanent rejection',
      });
      const message = queueMessage(job);

      await consume(message);

      expect(sendWebPush).toHaveBeenCalledOnce();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(await attempt(job.deliveryAttemptId)).toBeNull();
      expect(await usage()).toEqual({ queued: 1, sent: 0, failed: 1, expired: 0 });
    }
  );

  it.each([
    { statusCode: 429, retryAfterSeconds: 120, delaySeconds: 120 },
    { statusCode: 503, retryAfterSeconds: undefined, delaySeconds: 30 },
  ])('retries HTTP $statusCode with bounded delay', async (providerResult) => {
    const job = await insertAttempt();
    vi.mocked(sendWebPush).mockResolvedValueOnce({
      success: false,
      statusCode: providerResult.statusCode,
      error: 'retryable',
      ...(providerResult.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: providerResult.retryAfterSeconds }),
    });
    const message = queueMessage(job);

    await consume(message);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({
      delaySeconds: providerResult.delaySeconds,
    });
    expect(await attempt(job.deliveryAttemptId)).toMatchObject({
      status: 'queued',
      attempts: 1,
      push_status: providerResult.statusCode,
    });
  });

  it('retries only network failures, 408/425/429, and 5xx responses', () => {
    for (const status of [undefined, 408, 425, 429, 500, 503]) {
      expect(isRetryablePushFailure(status)).toBe(true);
    }
    for (const status of [200, 301, 400, 401, 403, 404, 410, 422]) {
      expect(isRetryablePushFailure(status)).toBe(false);
    }
    expect(pushRetryDelaySeconds({ success: false }, 5)).toBe(300);
    expect(pushRetryDelaySeconds({ success: false, retryAfterSeconds: 900 }, 1)).toBe(300);
  });

  it('reconciles stale queued and abandoned leases once with a bounded batch', async () => {
    const queued = await insertAttempt();
    const processing = await insertAttempt('xmtp');
    const recent = await insertAttempt();
    await db.batch([
      db.prepare(`
        UPDATE delivery_attempts SET updated_at = '2026-01-01T00:00:00.000Z'
        WHERE id = ?
      `).bind(queued.deliveryAttemptId),
      db.prepare(`
        UPDATE delivery_attempts
        SET status = 'processing', attempts = 1, updated_at = '2026-01-01T00:00:00.000Z'
        WHERE id = ?
      `).bind(processing.deliveryAttemptId),
      db.prepare(`
        UPDATE delivery_attempts SET updated_at = '2099-01-01T00:00:00.000Z'
        WHERE id = ?
      `).bind(recent.deliveryAttemptId),
    ]);

    await expect(reconcileStalePushDeliveryAttempts(db, {
      before: '2026-07-01T00:00:00.000Z',
    })).resolves.toEqual({ reconciled: 2 });
    expect(await attempt(queued.deliveryAttemptId)).toBeNull();
    expect(await attempt(processing.deliveryAttemptId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'relay_failure',
    });
    expect(await attempt(recent.deliveryAttemptId)).toMatchObject({ status: 'queued' });
    expect(await usage()).toEqual({ queued: 3, sent: 0, failed: 2, expired: 0 });

    await expect(reconcileStalePushDeliveryAttempts(db, {
      before: '2026-07-01T00:00:00.000Z',
    })).resolves.toEqual({ reconciled: 0 });
    expect(await usage()).toEqual({ queued: 3, sent: 0, failed: 2, expired: 0 });
  });
});
