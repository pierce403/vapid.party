import { describe, expect, it } from 'vitest';
import { handleApi } from '../../src/worker/api';
import type { Env, PushQueueJob } from '../../src/worker/types';

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    PUSH_QUEUE: {} as Queue<PushQueueJob>,
    RELAY_COORDINATOR: {} as DurableObjectNamespace,
    ...overrides,
  };
}

describe('XMTP delivery health', () => {
  it('provides an authenticated bodyless delivery-ingest readiness probe', async () => {
    const env = testEnv({ INTERNAL_INGEST_TOKEN: 'ingest-secret' });
    const ready = await handleApi(new Request(
      'https://vapid.party/api/internal/xmtp/deliveries/ready',
      { headers: { Authorization: 'Bearer ingest-secret' } }
    ), env);
    expect(ready?.status).toBe(204);
    expect(await ready?.text()).toBe('');
    expect(ready?.headers.get('Cache-Control')).toBe('no-store');

    const unauthorized = await handleApi(new Request(
      'https://vapid.party/api/internal/xmtp/deliveries/ready',
      { headers: { Authorization: 'Bearer wrong' } }
    ), env);
    expect(unauthorized?.status).toBe(401);
    expect(await unauthorized?.text()).toBe('');
  });

  it('reports XMTP delivery unconfigured without the container or ingest secret', async () => {
    const withoutContainer = await handleApi(
      new Request('https://vapid.party/api/health'),
      testEnv({
        XMTP_LISTENER_SYNC_TOKEN: 'sync-secret',
        INTERNAL_INGEST_TOKEN: 'ingest-secret',
      })
    );
    const withoutContainerBody = await withoutContainer?.json() as {
      data: { xmtp: { deliveryReady: boolean; listener: { configured: boolean } } };
    };
    expect(withoutContainerBody.data.xmtp).toMatchObject({
      deliveryReady: false,
      listener: { configured: false },
    });

    const withoutIngestSecret = await handleApi(
      new Request('https://vapid.party/api/health'),
      testEnv({
        XMTP_LISTENER: {} as NonNullable<Env['XMTP_LISTENER']>,
        XMTP_LISTENER_SYNC_TOKEN: 'sync-secret',
      })
    );
    const withoutIngestBody = await withoutIngestSecret?.json() as {
      data: { xmtp: { deliveryReady: boolean; listener: { configured: boolean } } };
    };
    expect(withoutIngestBody.data.xmtp).toMatchObject({
      deliveryReady: false,
      listener: { configured: false },
    });
  });
});

describe('removed wallet management surface', () => {
  it('does not trust unsigned wallet bearer payloads for app administration', async () => {
    const forgedPayload = btoa(JSON.stringify({ sub: '0x0000000000000000000000000000000000000001' }))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const authorization = `Bearer ignored.${forgedPayload}.ignored`;
    const requests = [
      new Request('https://vapid.party/api/register-app', {
        method: 'POST',
        headers: { Authorization: authorization },
      }),
      new Request('https://vapid.party/api/apps', {
        headers: { Authorization: authorization },
      }),
      new Request('https://vapid.party/api/apps/converge', {
        method: 'DELETE',
        headers: { Authorization: authorization },
      }),
      new Request('https://vapid.party/api/apps/converge/regenerate-key', {
        method: 'POST',
        headers: { Authorization: authorization },
      }),
    ];

    for (const request of requests) {
      const response = await handleApi(request, testEnv());
      expect(response?.status).toBe(404);
    }
  });
});
