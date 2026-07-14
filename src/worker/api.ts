import { ZodError } from 'zod';
import {
  authenticateApiKey,
  hasInternalIngestAuth,
  hasXmtpListenerSyncAuth,
} from './auth';
import {
  checkAndIncrementRateLimit,
  countSubscriptions,
  D1XmtpStore,
  ensureConvergeApp,
  getSubscriptionsByApp,
  getSubscriptionsByIds,
  insertDeliveryAttempt,
  upsertSubscription,
  XmtpAppIsolationPendingError,
} from './db';
import { ERROR_CODES, errorResponse, jsonResponse, readJson, zodErrorResponse } from './http';
import {
  SendNotificationSchema,
  SubscribeSchema,
  XmtpListenerStatusSchema,
} from './schemas';
import {
  registerGenericXmtpSubscription,
  relayXmtpDelivery,
  registerXmtpSubscription,
  unregisterGenericXmtpSubscription,
  unregisterXmtpSubscription,
} from './core';
import {
  getXmtpListenerDeltas,
  getXmtpListenerHealth,
  getXmtpListenerSnapshot,
  parseListenerPageLimit,
  saveXmtpListenerStatus,
} from './listener-registry';
import type { AppRecord, Env, PushQueueJob, SubscriptionRecord } from './types';

async function requireApiApp(request: Request, env: Env): Promise<AppRecord | Response> {
  const app = await authenticateApiKey(request, env);
  if (!app) {
    return errorResponse('Missing or invalid X-API-Key header', ERROR_CODES.INVALID_API_KEY, 401);
  }
  return app;
}

async function queueGenericPushes(
  env: Env,
  appId: string,
  subscriptions: SubscriptionRecord[],
  payload: Record<string, unknown>
): Promise<PushQueueJob[]> {
  const jobs: PushQueueJob[] = [];

  for (const subscription of subscriptions) {
    const deliveryAttemptId = await insertDeliveryAttempt(env.DB, {
      appId,
      subscriptionId: subscription.id,
      eventType: 'generic.push',
      payload,
    });

    const job: PushQueueJob = {
      deliveryAttemptId,
      appId,
      subscriptionId: subscription.id,
      payload,
      source: 'generic',
    };
    await env.PUSH_QUEUE.send(job);
    jobs.push(job);
  }

  return jobs;
}

export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  try {
    if (method === 'GET' && pathname === '/api/health') {
      const xmtp = await getXmtpListenerHealth(
        env.DB,
        Boolean(env.XMTP_LISTENER && env.XMTP_LISTENER_SYNC_TOKEN && env.INTERNAL_INGEST_TOKEN)
      );
      return jsonResponse({
        status: 'healthy',
        runtime: 'cloudflare-worker',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        xmtp,
      });
    }

    if (method === 'GET' && pathname === '/api/internal/xmtp/deliveries/ready') {
      if (!hasInternalIngestAuth(request, env)) {
        return new Response(null, {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (pathname.startsWith('/api/internal/xmtp/listener/')) {
      if (!hasXmtpListenerSyncAuth(request, env)) {
        return errorResponse('Missing or invalid XMTP listener sync token', ERROR_CODES.UNAUTHORIZED, 401);
      }

      if (method === 'GET' && pathname === '/api/internal/xmtp/listener/snapshot') {
        const snapshot = await getXmtpListenerSnapshot(env.DB, {
          limit: parseListenerPageLimit(url.searchParams.get('limit')),
          pageToken: url.searchParams.get('pageToken') ?? undefined,
        });
        return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
      }

      if (method === 'GET' && pathname === '/api/internal/xmtp/listener/deltas') {
        const after = url.searchParams.get('after');
        if (after === null) {
          return errorResponse('after is required', ERROR_CODES.VALIDATION_ERROR, 422);
        }
        const deltas = await getXmtpListenerDeltas(env.DB, {
          after,
          limit: parseListenerPageLimit(url.searchParams.get('limit')),
        });
        return Response.json(deltas, { headers: { 'Cache-Control': 'no-store' } });
      }

      if (method === 'POST' && pathname === '/api/internal/xmtp/listener/status') {
        const input = XmtpListenerStatusSchema.parse(await readJson(request));
        const result = await saveXmtpListenerStatus(env.DB, input);
        return Response.json({ version: 1, accepted: true, cursor: result.cursor });
      }

      return errorResponse('Not found', ERROR_CODES.NOT_FOUND, 404);
    }

    if (method === 'GET' && pathname === '/api/xmtp/vapid-public-key') {
      const app = await ensureConvergeApp(env);
      if (!app) {
        return errorResponse(
          'Converge VAPID app is not configured',
          ERROR_CODES.NOT_CONFIGURED,
          503,
          { configure: 'Set CONVERGE_APP_ID to an app row or set CONVERGE_VAPID_PUBLIC_KEY/CONVERGE_VAPID_PRIVATE_KEY secrets.' }
        );
      }

      return jsonResponse({ publicKey: app.vapidPublicKey });
    }

    if (pathname === '/api/xmtp/subscriptions' && (method === 'POST' || method === 'DELETE')) {
      const body = await readJson(request);
      const store = new D1XmtpStore(env);

      if (method === 'POST') {
        const result = await registerXmtpSubscription(store, body);
        return jsonResponse(result, result.created ? 201 : 200);
      }

      const result = await unregisterXmtpSubscription(store, body);
      return jsonResponse(result);
    }

    if (pathname === '/api/xmtp/registrations' && (method === 'POST' || method === 'DELETE')) {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;
      const body = await readJson(request);
      const store = new D1XmtpStore(env, app.id);

      if (method === 'POST') {
        const result = await registerGenericXmtpSubscription(store, body);
        return jsonResponse(result, result.created ? 201 : 200);
      }

      return jsonResponse(await unregisterGenericXmtpSubscription(store, body));
    }

    if (method === 'POST' && (
      pathname === '/api/internal/xmtp/deliveries' ||
      pathname === '/api/internal/xmtp/envelopes'
    )) {
      if (!hasInternalIngestAuth(request, env)) {
        return errorResponse('Missing or invalid internal ingest token', ERROR_CODES.UNAUTHORIZED, 401);
      }

      const body = await readJson(request);
      const result = await relayXmtpDelivery(new D1XmtpStore(env), body);
      // The official XMTP HTTP delivery adapter retries every non-200 response.
      return jsonResponse(result, 200);
    }

    if (method === 'GET' && pathname === '/api/vapid/public-key') {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;
      return jsonResponse({ publicKey: app.vapidPublicKey });
    }

    if (method === 'POST' && pathname === '/api/subscribe') {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;

      const count = await countSubscriptions(env.DB, app.id);
      if (count >= app.rateLimit.maxSubscriptions) {
        return errorResponse('Maximum subscriptions limit reached', ERROR_CODES.RATE_LIMIT_EXCEEDED, 429);
      }

      const body = await readJson(request);
      const input = SubscribeSchema.parse(body);
      const subscription = await upsertSubscription(env.DB, app.id, {
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId: input.userId,
        channelId: input.channelId,
        metadata: input.metadata,
        expirationTime: input.expirationTime,
      });

      return jsonResponse({
        id: subscription.id,
        endpoint: subscription.endpoint,
        createdAt: subscription.createdAt,
      }, 201);
    }

    if (method === 'POST' && pathname === '/api/send') {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;

      const body = await readJson(request);
      const input = SendNotificationSchema.parse(body);
      const subscriptions = input.subscriptionIds?.length
        ? await getSubscriptionsByIds(env.DB, app.id, input.subscriptionIds)
        : await getSubscriptionsByApp(env.DB, app.id, { userId: input.userId, channelId: input.channelId });

      if (subscriptions.length === 0) {
        return jsonResponse({ queued: 0, sent: 0, failed: 0, total: 0, jobs: [] });
      }

      const rateLimit = await checkAndIncrementRateLimit(
        env.DB,
        app.id,
        subscriptions.length > 1 ? 'broadcast' : 'notification',
        app.rateLimit.maxNotificationsPerMinute
      );
      if (!rateLimit.allowed) {
        return errorResponse('Rate limit exceeded', ERROR_CODES.RATE_LIMIT_EXCEEDED, 429, rateLimit);
      }

      const jobs = await queueGenericPushes(env, app.id, subscriptions, input.payload);
      return jsonResponse({
        queued: jobs.length,
        sent: 0,
        failed: 0,
        total: subscriptions.length,
        jobs: jobs.map((job) => ({
          deliveryAttemptId: job.deliveryAttemptId,
          subscriptionId: job.subscriptionId,
          source: job.source,
        })),
      }, 202);
    }

    if (pathname.startsWith('/api/')) {
      return errorResponse('Not found', ERROR_CODES.NOT_FOUND, 404);
    }

    return null;
  } catch (error) {
    if (error instanceof ZodError) {
      return zodErrorResponse(error, null);
    }

    if (error instanceof XmtpAppIsolationPendingError) {
      return errorResponse(error.message, ERROR_CODES.NOT_CONFIGURED, 503);
    }

    const message = error instanceof Error ? error.message : 'Internal error';
    return errorResponse(message, ERROR_CODES.INTERNAL_ERROR, 500);
  }
}
