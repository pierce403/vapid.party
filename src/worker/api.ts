import { ZodError } from 'zod';
import { authenticateApiKey, hasInternalIngestAuth, ownsApp, verifyWalletAuth } from './auth';
import {
  checkAndIncrementRateLimit,
  countSubscriptions,
  createApp,
  D1XmtpStore,
  deleteApp,
  ensureConvergeApp,
  getAppById,
  getAppsByOwner,
  getSubscriptionsByApp,
  getSubscriptionsByIds,
  insertDeliveryAttempt,
  regenerateApiKey,
  updateApp,
  upsertSubscription,
} from './db';
import { ERROR_CODES, errorResponse, jsonResponse, readJson, zodErrorResponse } from './http';
import {
  RegisterAppSchema,
  SendNotificationSchema,
  SubscribeSchema,
  UpdateAppSchema,
} from './schemas';
import { relayXmtpDelivery, registerXmtpSubscription, unregisterXmtpSubscription } from './core';
import type { AppRecord, Env, PushQueueJob, SubscriptionRecord } from './types';

function publicApp(app: AppRecord) {
  return {
    id: app.id,
    name: app.name,
    ownerWallet: app.ownerWallet,
    vapidPublicKey: app.vapidPublicKey,
    metadata: app.metadata,
    rateLimit: app.rateLimit,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

async function requireApiApp(request: Request, env: Env): Promise<AppRecord | Response> {
  const app = await authenticateApiKey(request, env);
  if (!app) {
    return errorResponse('Missing or invalid X-API-Key header', ERROR_CODES.INVALID_API_KEY, 401);
  }
  return app;
}

async function requireWallet(request: Request): Promise<string | Response> {
  const auth = verifyWalletAuth(request);
  if (!auth) {
    return errorResponse('Missing or invalid Authorization bearer token', ERROR_CODES.UNAUTHORIZED, 401);
  }
  return auth.walletAddress;
}

function routeSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
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
      return jsonResponse({
        status: 'healthy',
        runtime: 'cloudflare-worker',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      });
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

    if (method === 'POST' && pathname === '/api/register-app') {
      const wallet = await requireWallet(request);
      if (wallet instanceof Response) return wallet;

      const apps = await getAppsByOwner(env.DB, wallet);
      if (apps.length >= 10) {
        return errorResponse('Maximum apps limit reached', ERROR_CODES.RATE_LIMIT_EXCEEDED, 429);
      }

      const body = await readJson(request);
      const input = RegisterAppSchema.parse(body);
      const app = await createApp(env.DB, wallet, input.name, input.metadata);
      return jsonResponse({
        id: app.id,
        name: app.name,
        apiKey: app.apiKey,
        vapidPublicKey: app.vapidPublicKey,
        createdAt: app.createdAt,
      }, 201);
    }

    if (method === 'GET' && pathname === '/api/apps') {
      const wallet = await requireWallet(request);
      if (wallet instanceof Response) return wallet;
      const apps = await getAppsByOwner(env.DB, wallet);
      return jsonResponse(apps.map(publicApp));
    }

    const segments = routeSegments(pathname);
    if (segments[0] === 'api' && segments[1] === 'apps' && segments[2]) {
      const appId = segments[2];
      const wallet = await requireWallet(request);
      if (wallet instanceof Response) return wallet;

      if (!(await ownsApp(env, wallet, appId))) {
        return errorResponse('App not found', ERROR_CODES.NOT_FOUND, 404);
      }

      if (method === 'GET' && segments.length === 3) {
        const app = await getAppById(env.DB, appId);
        return app ? jsonResponse(publicApp(app)) : errorResponse('App not found', ERROR_CODES.NOT_FOUND, 404);
      }

      if (method === 'PUT' && segments.length === 3) {
        const body = await readJson(request);
        const input = UpdateAppSchema.parse(body);
        const app = await updateApp(env.DB, appId, input);
        return app ? jsonResponse(publicApp(app)) : errorResponse('App not found', ERROR_CODES.NOT_FOUND, 404);
      }

      if (method === 'DELETE' && segments.length === 3) {
        const deleted = await deleteApp(env.DB, appId);
        return jsonResponse({ deleted });
      }

      if (method === 'POST' && segments[3] === 'regenerate-key') {
        const apiKey = await regenerateApiKey(env.DB, appId);
        return apiKey ? jsonResponse({ apiKey }) : errorResponse('App not found', ERROR_CODES.NOT_FOUND, 404);
      }
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

    const message = error instanceof Error ? error.message : 'Internal error';
    return errorResponse(message, ERROR_CODES.INTERNAL_ERROR, 500);
  }
}
