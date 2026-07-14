import { getContainer } from '@cloudflare/containers';
import { handleApi } from './api';
import { corsResponse } from './http';
import {
  compactXmtpListenerChanges,
  reconcileXmtpListenerDirtyRoutes,
} from './listener-registry';
import { handleQueue } from './queue';
import type { Env, PushQueueJob } from './types';

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
      return env.ASSETS.fetch(request);
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
