import webPush from 'web-push';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWebPush } from '../../src/worker/push';
import type { AppRecord, SubscriptionRecord } from '../../src/worker/types';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}));

function app(id: string): AppRecord {
  return {
    id,
    name: id,
    ownerWallet: id,
    apiKey: `key-${id}`,
    vapidPublicKey: `public-${id}`,
    vapidPrivateKey: `private-${id}`,
    metadata: {},
    rateLimit: {
      maxNotificationsPerMinute: 60,
      maxNotificationsPerDay: 1000,
      maxSubscriptions: 100,
    },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function subscription(id: string): SubscriptionRecord {
  return {
    id,
    appId: id,
    endpoint: `https://push.example/${id}`,
    p256dh: `p256dh-${id}`,
    auth: `auth-${id}`,
    metadata: {},
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

describe('per-delivery Web Push credentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps concurrent app VAPID keys isolated without global mutation', async () => {
    await Promise.all([
      sendWebPush(app('a'), subscription('a'), { type: 'test-a' }),
      sendWebPush(app('b'), subscription('b'), { type: 'test-b' }),
    ]);

    expect(webPush.setVapidDetails).not.toHaveBeenCalled();
    const calls = vi.mocked(webPush.sendNotification).mock.calls;
    expect(calls[0][2]).toMatchObject({
      vapidDetails: {
        publicKey: 'public-a',
        privateKey: 'private-a',
      },
    });
    expect(calls[1][2]).toMatchObject({
      vapidDetails: {
        publicKey: 'public-b',
        privateKey: 'private-b',
      },
    });
  });

  it('passes short-lived high-urgency options for a diagnostic delivery', async () => {
    await sendWebPush(
      app('diagnostic'),
      subscription('diagnostic'),
      { type: 'vapid.diagnostic', testId: 'test-id' },
      { ttl: 60, urgency: 'high' }
    );
    expect(vi.mocked(webPush.sendNotification).mock.calls[0][2]).toMatchObject({
      timeout: 45_000,
      TTL: 60,
      urgency: 'high',
    });
  });

  it('exposes a bounded Retry-After delay from provider failures', async () => {
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce({
      statusCode: 429,
      message: 'rate limited',
      headers: { 'retry-after': '900' },
    });

    await expect(sendWebPush(
      app('retry-after'),
      subscription('retry-after'),
      { type: 'test' }
    )).resolves.toMatchObject({
      success: false,
      statusCode: 429,
      retryAfterSeconds: 300,
    });
  });

  it('ignores malformed Retry-After values', async () => {
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce({
      statusCode: 503,
      message: 'unavailable',
      headers: { 'Retry-After': 'not-a-date' },
    });

    const result = await sendWebPush(
      app('bad-retry-after'),
      subscription('bad-retry-after'),
      { type: 'test' }
    );
    expect(result.retryAfterSeconds).toBeUndefined();
  });
});
