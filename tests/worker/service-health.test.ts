import { describe, expect, it } from 'vitest';
import { getDeliveryServiceHealth } from '../../src/worker/db';
import type { Env, PushQueueJob } from '../../src/worker/types';

interface ActivityRow {
  last_web_push_accepted_at: string | null;
  last_callback_accepted_at: string | null;
  last_delivery_failure_at: string | null;
  last_delivery_failure_category: string | null;
  pending_attempt_count: number;
  oldest_pending_attempt_at: string | null;
}

const emptyActivity: ActivityRow = {
  last_web_push_accepted_at: null,
  last_callback_accepted_at: null,
  last_delivery_failure_at: null,
  last_delivery_failure_category: null,
  pending_attempt_count: 0,
  oldest_pending_attempt_at: null,
};

function queue(metrics: QueueMetrics | Error): Queue<PushQueueJob> {
  return {
    metrics: async () => {
      if (metrics instanceof Error) throw metrics;
      return metrics;
    },
  } as Queue<PushQueueJob>;
}

function env(
  activity: ActivityRow | Error,
  source: QueueMetrics | Error = { backlogCount: 0, backlogBytes: 0 },
  deadLetter?: QueueMetrics | Error
): Env {
  return {
    DB: {
      prepare: () => ({
        first: async () => {
          if (activity instanceof Error) throw activity;
          return activity;
        },
      }),
    } as unknown as D1Database,
    PUSH_QUEUE: queue(source),
    ...(deadLetter === undefined ? {} : { PUSH_DEAD_LETTER_QUEUE: queue(deadLetter) }),
    RELAY_COORDINATOR: {} as DurableObjectNamespace,
  };
}

describe('public delivery service health', () => {
  it('reports ready only with activity plus healthy source and dead-letter Queue metrics', async () => {
    const health = await getDeliveryServiceHealth(env(
      {
        ...emptyActivity,
        last_web_push_accepted_at: '2026-07-28T12:34:56.000Z',
        last_callback_accepted_at: '2026-07-28T12:35:56.000Z',
      },
      { backlogCount: 1, backlogBytes: 128, oldestMessageTimestamp: new Date() },
      { backlogCount: 0, backlogBytes: 0 }
    ));

    expect(health).toMatchObject({
      status: 'ready',
      lastWebPushAcceptedAt: '2026-07-28T12:34:00.000Z',
      lastCallbackAcceptedAt: '2026-07-28T12:35:00.000Z',
      pendingAttemptCount: 0,
      queue: { status: 'ready', backlogCount: 1, backlogBytes: 128 },
      deadLetterQueue: { status: 'ready', backlogCount: 0, backlogBytes: 0 },
      issues: [],
    });
  });

  it('degrades on stale D1 attempts even when Queue metrics have lost the message', async () => {
    const health = await getDeliveryServiceHealth(env(
      {
        ...emptyActivity,
        pending_attempt_count: 1,
        oldest_pending_attempt_at: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
      { backlogCount: 0, backlogBytes: 0 },
      { backlogCount: 0, backlogBytes: 0 }
    ));

    expect(health).toMatchObject({
      status: 'degraded',
      pendingAttemptCount: 1,
      oldestPendingAttemptAt: expect.any(String),
      queue: { status: 'ready' },
      issues: ['delivery_attempt_backlog_stale'],
    });
  });

  it('degrades stale source backlog and any dead-letter backlog', async () => {
    const health = await getDeliveryServiceHealth(env(
      emptyActivity,
      {
        backlogCount: 2,
        backlogBytes: 256,
        oldestMessageTimestamp: new Date(Date.now() - 16 * 60_000),
      },
      {
        backlogCount: 1,
        backlogBytes: 64,
        oldestMessageTimestamp: new Date(),
      }
    ));
    expect(health.status).toBe('degraded');
    expect(health.issues).toEqual([
      'push_queue_backlog_stale',
      'dead_letter_queue_backlog',
    ]);
  });

  it('cannot report ready when the dead-letter binding is missing', async () => {
    const health = await getDeliveryServiceHealth(env(emptyActivity));
    expect(health).toMatchObject({
      status: 'unknown',
      deadLetterQueue: { status: 'unknown' },
      issues: ['dead_letter_queue_metrics_unavailable'],
    });
  });

  it('redacts D1 and Queue metric exceptions into fixed unknown states', async () => {
    const health = await getDeliveryServiceHealth(env(
      new Error('secret SQL table name'),
      new Error('secret source Queue failure'),
      new Error('secret DLQ failure')
    ));
    expect(health).toMatchObject({
      status: 'unknown',
      queue: { status: 'unknown' },
      deadLetterQueue: { status: 'unknown' },
      issues: [
        'delivery_activity_unavailable',
        'push_queue_metrics_unavailable',
        'dead_letter_queue_metrics_unavailable',
      ],
    });
    expect(JSON.stringify(health)).not.toContain('secret');
  });

  it('degrades a pending-attempt backlog whose age is unavailable', async () => {
    const health = await getDeliveryServiceHealth(env(
      { ...emptyActivity, pending_attempt_count: 1 },
      { backlogCount: 0, backlogBytes: 0 },
      { backlogCount: 0, backlogBytes: 0 }
    ));
    expect(health.status).toBe('degraded');
    expect(health.issues).toContain('delivery_attempt_backlog_age_unknown');
  });
});
