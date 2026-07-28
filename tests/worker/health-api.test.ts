import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/worker/listener-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/listener-registry')>();
  return { ...actual, getXmtpListenerHealth: vi.fn() };
});

vi.mock('../../src/worker/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/db')>();
  return { ...actual, getDeliveryServiceHealth: vi.fn() };
});

import { handleApi } from '../../src/worker/api';
import { getDeliveryServiceHealth } from '../../src/worker/db';
import { getXmtpListenerHealth } from '../../src/worker/listener-registry';
import type { DeliveryServiceHealth } from '../../src/worker/db';
import type { XmtpListenerHealth } from '../../src/worker/listener-registry';
import type { Env, PushQueueJob } from '../../src/worker/types';

const healthyXmtp: XmtpListenerHealth = {
  deliveryReady: true,
  listener: {
    configured: true,
    online: true,
    status: 'ready',
    lastCheckedAt: '2026-07-28T12:34:56.000Z',
    lastDeliveryProbeAt: '2026-07-28T12:34:55.000Z',
  },
  network: { lastEnvelopeAt: '2026-07-28T12:34:00.000Z' },
  bridge: {
    status: 'synced',
    pendingRegistrationCount: 0,
    failedRegistrationCount: 0,
    lastSuccessfulSyncAt: '2026-07-28T12:34:54.000Z',
  },
};

const healthyDelivery: DeliveryServiceHealth = {
  status: 'ready',
  pendingAttemptCount: 0,
  queue: { status: 'ready', backlogCount: 0, backlogBytes: 0 },
  deadLetterQueue: { status: 'ready', backlogCount: 0, backlogBytes: 0 },
  issues: [],
};

function env(): Env {
  return {
    DB: {} as D1Database,
    PUSH_QUEUE: {} as Queue<PushQueueJob>,
    PUSH_DEAD_LETTER_QUEUE: {} as Queue<PushQueueJob>,
    RELAY_COORDINATOR: {} as DurableObjectNamespace,
    XMTP_LISTENER: {} as NonNullable<Env['XMTP_LISTENER']>,
    XMTP_LISTENER_SYNC_TOKEN: 'sync-secret',
    INTERNAL_INGEST_TOKEN: 'ingest-secret',
    VERSION_METADATA: {
      id: 'worker-version-id',
      tag: 'release-tag',
      timestamp: '2026-07-28T12:00:00.000Z',
    },
  };
}

describe('public health API contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getXmtpListenerHealth).mockResolvedValue(healthyXmtp);
    vi.mocked(getDeliveryServiceHealth).mockResolvedValue(healthyDelivery);
  });

  it('returns a no-store 200 only when every required service path is healthy', async () => {
    const response = await handleApi(new Request('https://vapid.party/api/health'), env());
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Pragma')).toBe('no-cache');
    expect(await response?.json()).toMatchObject({
      success: true,
      data: {
        status: 'healthy',
        version: 'release-tag',
        worker: {
          online: true,
          versionId: 'worker-version-id',
          versionTag: 'release-tag',
        },
        xmtp: { deliveryReady: true },
        delivery: { status: 'ready' },
        diagnostics: [],
      },
    });
  });

  it('returns a diagnostic 503 when a component is degraded', async () => {
    vi.mocked(getXmtpListenerHealth).mockResolvedValue({
      ...healthyXmtp,
      deliveryReady: false,
      listener: {
        ...healthyXmtp.listener,
        status: 'not_ready',
        issue: 'stream_disconnected',
      },
    });

    const response = await handleApi(new Request('https://vapid.party/api/health'), env());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      data: {
        status: 'degraded',
        diagnostics: [{
          component: 'xmtp_listener',
          code: 'xmtp_stream_disconnected',
          message: 'The XMTP network stream is disconnected.',
        }],
      },
    });
  });

  it('preserves a safe partial response and redacts source exceptions', async () => {
    vi.mocked(getXmtpListenerHealth).mockRejectedValue(
      new Error('secret xmtp SQL and bearer data')
    );
    vi.mocked(getDeliveryServiceHealth).mockRejectedValue(
      new Error('secret Queue provider details')
    );

    const response = await handleApi(new Request('https://vapid.party/api/health'), env());
    const body = await response?.json();
    expect(response?.status).toBe(503);
    expect(body).toMatchObject({
      data: {
        status: 'unavailable',
        worker: { online: true },
        xmtp: {
          deliveryReady: false,
          listener: { online: false, status: 'unknown' },
        },
        delivery: {
          status: 'unknown',
          queue: { status: 'unknown' },
          deadLetterQueue: { status: 'unknown' },
        },
        diagnostics: [
          {
            component: 'xmtp_listener',
            code: 'xmtp_health_unavailable',
          },
          {
            component: 'delivery',
            code: 'delivery_health_unavailable',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
