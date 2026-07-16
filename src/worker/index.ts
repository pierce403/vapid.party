import { getContainer } from '@cloudflare/containers';
import { handleApi } from './api';
import { corsResponse } from './http';
import {
  compactXmtpListenerChanges,
  reconcileXmtpListenerDirtyRoutes,
} from './listener-registry';
import { handleQueue } from './queue';
import type { Env, PushQueueJob } from './types';
import {
  compactExpiredSubscriptions,
  compactOperationalHistory,
  reconcileStalePushDeliveryAttempts,
} from './db';
import { withStaticSecurityHeaders } from './security-headers';

export { RelayCoordinator } from './relay-coordinator';
export { XmtpListenerContainer } from './xmtp-listener-container';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsResponse();
    }

    const response = await handleApi(request, env);
    if (response) return response;

    if (env.ASSETS) {
      return withStaticSecurityHeaders(await env.ASSETS.fetch(request));
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<PushQueueJob>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await reconcileXmtpListenerDirtyRoutes(env.DB);
      await compactXmtpListenerChanges(env.DB);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'xmtp_listener_maintenance_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }

    // Expired browser capabilities stop routing/counting immediately. Cleanup
    // uses the normal XMTP tombstone path and is isolated from both listener
    // reconciliation and operational-history retention failures.
    try {
      const expired = await compactExpiredSubscriptions(env.DB);
      if (expired.backlogLikely) {
        console.warn(JSON.stringify({
          event: 'expired_subscription_backlog',
          ...expired,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'expired_subscription_compaction_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }

    // A source Queue message can age out during an outage without another
    // consumer invocation. Close those coarse D1 attempts after the one-hour
    // Queue retention plus grace so they cannot remain queued indefinitely.
    try {
      const stale = await reconcileStalePushDeliveryAttempts(env.DB);
      if (stale.reconciled >= 5_000) {
        console.warn(JSON.stringify({
          event: 'stale_push_attempt_backlog',
          ...stale,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'stale_push_attempt_reconciliation_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }

    // Privacy retention must not depend on listener reconciliation succeeding.
    try {
      const compaction = await compactOperationalHistory(env.DB);
      if (compaction.backlogLikely) {
        console.warn(JSON.stringify({
          event: 'operational_history_backlog',
          ...compaction,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'operational_history_compaction_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }

    if (!env.XMTP_LISTENER || !env.XMTP_LISTENER_SYNC_TOKEN || !env.INTERNAL_INGEST_TOKEN) {
      console.warn(JSON.stringify({
        event: 'xmtp_listener_start_skipped',
        reason: 'missing_required_secret',
      }));
      return;
    }

    const baseUrl = (env.VAPID_PARTY_PUBLIC_URL || 'https://vapid.party').replace(/\/$/, '');
    const listener = getContainer(env.XMTP_LISTENER, 'primary');
    await listener.startAndWaitForPorts({
      ports: 8080,
      cancellationOptions: {
        instanceGetTimeoutMS: 8_000,
        portReadyTimeoutMS: 45_000,
      },
      startOptions: {
        enableInternet: true,
        envVars: {
          VAPID_PARTY_CONTROL_URL: baseUrl,
          VAPID_PARTY_DELIVERY_URL: `${baseUrl}/api/internal/xmtp/deliveries`,
          XMTP_LISTENER_SYNC_TOKEN: env.XMTP_LISTENER_SYNC_TOKEN,
          INTERNAL_INGEST_TOKEN: env.INTERNAL_INGEST_TOKEN,
          INSTANCE_ID: 'primary',
          APP_VERSION: 'vapid-party-xmtp-listener/1.0.0',
        },
      },
    });
  },
} satisfies ExportedHandler<Env, PushQueueJob>;
