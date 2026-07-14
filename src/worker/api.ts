import { ZodError } from 'zod';
import {
  authenticateApiKey,
  hasInternalIngestAuth,
  hasXmtpListenerSyncAuth,
} from './auth';
import {
  acquireXmtpEndpointMutationLock,
  acquireXmtpRegistrationMutationLock,
  checkAndIncrementRateLimit,
  countActiveXmtpRegistrations,
  countSubscriptions,
  D1XmtpStore,
  enqueueXmtpDiagnosticTest,
  ensureConvergeApp,
  diagnosticReceiptMatches,
  getActiveXmtpRegistrationState,
  getActiveSubscriptionEndpointKeys,
  getXmtpDiagnosticStatus,
  getSubscriptionsByApp,
  getSubscriptionsByIds,
  hasActiveSubscriptionEndpoint,
  insertDeliveryAttempt,
  releaseXmtpEndpointMutationLock,
  releaseXmtpRegistrationMutationLock,
  scopedPublicRateLimitAction,
  upsertSubscription,
  XmtpAppIsolationPendingError,
  XmtpDiagnosticRateLimitError,
  XmtpEndpointKeyConflictError,
} from './db';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  readJson,
  readJsonBounded,
  RequestBodyTooLargeError,
  zodErrorResponse,
} from './http';
import {
  SendNotificationSchema,
  SubscribeSchema,
  XmtpListenerStatusSchema,
} from './schemas';
import {
  isAllowedPublicWebPushEndpoint,
  normalizeGenericXmtpDelete,
  normalizeGenericXmtpRegistration,
  normalizePublicXmtpDelete,
  normalizePublicXmtpRegistration,
  relayXmtpDelivery,
  type NormalizedXmtpRegistration,
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

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

function diagnosticReceipt(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const receipt = authorization.slice(7);
  return /^[A-Za-z0-9_-]{43}$/.test(receipt) ? receipt : null;
}

function diagnosticsRequested(request: Request): boolean {
  return request.headers.get('x-vapid-party-diagnostics') === '1';
}

function conflictResponse(message: string): Response {
  return noStore(errorResponse(message, ERROR_CODES.CONFLICT, 409));
}

async function authorizePublicRegistrationMutation(
  request: Request,
  env: Env,
  appId: string,
  input: NormalizedXmtpRegistration
): Promise<{ receipt?: string; exists: boolean } | Response> {
  const endpointKeys = await getActiveSubscriptionEndpointKeys(env.DB, appId, input.endpoint);
  if (endpointKeys && (
    endpointKeys.p256dh !== input.p256dh || endpointKeys.auth !== input.auth
  )) {
    return conflictResponse(
      'An active Web Push endpoint cannot be reused with different subscription keys'
    );
  }

  const state = await getActiveXmtpRegistrationState(env.DB, appId, input);
  if (!state) return { exists: false };

  const receipt = diagnosticReceipt(request);
  const exactSubscription = state.endpoint === input.endpoint
    && state.p256dh === input.p256dh
    && state.auth === input.auth;
  if (state.diagnosticTokenHash) {
    if (receipt && await diagnosticReceiptMatches(receipt, state.diagnosticTokenHash)) {
      // Preserve a valid capability across endpoint replacement so a client
      // can safely retry after a committed mutation whose response was lost.
      return { receipt, exists: true };
    }
    return exactSubscription
      ? { exists: true }
      : conflictResponse(
          'This XMTP installation is already managed by another active registration'
        );
  }

  return exactSubscription
    ? { exists: true }
    : conflictResponse(
        'Refresh the existing push endpoint before replacing this XMTP installation route'
      );
}

async function authorizePublicRegistrationDelete(
  request: Request,
  env: Env,
  appId: string,
  input: { endpoint: string; inboxId: string; installationId: string }
): Promise<{ exists: boolean } | Response> {
  const state = await getActiveXmtpRegistrationState(env.DB, appId, input);
  if (!state) return { exists: false };
  const receipt = diagnosticReceipt(request);
  if (
    state.endpoint !== input.endpoint
    || (
      state.diagnosticTokenHash
      && (!receipt || !await diagnosticReceiptMatches(receipt, state.diagnosticTokenHash))
    )
  ) {
    return conflictResponse('A current diagnostic receipt is required to remove this registration');
  }
  return { exists: true };
}

async function enforcePublicMutationAttemptRate(
  request: Request,
  env: Env,
  appId: string
): Promise<Response | null> {
  const scopedAction = await scopedPublicRateLimitAction(
    request,
    env,
    'xmtp-public-mutation-attempt'
  );
  const rate = await checkAndIncrementRateLimit(env.DB, appId, scopedAction, 60);
  if (rate.allowed) return null;
  return noStore(errorResponse(
    'Public XMTP mutation rate limit exceeded',
    ERROR_CODES.RATE_LIMIT_EXCEEDED,
    429,
    rate
  ));
}

async function enforceDiagnosticAttemptRate(
  request: Request,
  env: Env,
  appId: string,
  kind: 'status' | 'test'
): Promise<Response | null> {
  const action = await scopedPublicRateLimitAction(
    request,
    env,
    `xmtp-diagnostic-${kind}-lookup`
  );
  const rate = await checkAndIncrementRateLimit(
    env.DB,
    appId,
    action,
    kind === 'status' ? 120 : 60
  );
  if (rate.allowed) return null;
  return noStore(errorResponse(
    'Diagnostic request rate limit exceeded',
    ERROR_CODES.RATE_LIMIT_EXCEEDED,
    429,
    rate
  ));
}

async function releaseMutationLockSafely(
  env: Env,
  appId: string,
  input: { inboxId: string; installationId: string },
  lockToken: string
): Promise<void> {
  try {
    await releaseXmtpRegistrationMutationLock(env.DB, appId, input, lockToken);
  } catch (error) {
    // Locks expire after 30 seconds. A cleanup failure must not replace a
    // response for a mutation that already committed successfully.
    console.error(JSON.stringify({
      event: 'xmtp_registration_lock_release_failed',
      appId,
      error: error instanceof Error ? error.message : 'unknown error',
    }));
  }
}

async function releaseEndpointLockSafely(
  env: Env,
  appId: string,
  endpoint: string,
  lockToken: string
): Promise<void> {
  try {
    await releaseXmtpEndpointMutationLock(env.DB, appId, endpoint, lockToken);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'web_push_endpoint_lock_release_failed',
      appId,
      error: error instanceof Error ? error.message : 'unknown error',
    }));
  }
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
  const isDiagnosticRequest = method === 'POST' && (
    pathname === '/api/xmtp/status' || pathname === '/api/xmtp/status/test'
  );
  const isPublicXmtpMutation = pathname === '/api/xmtp/subscriptions'
    && (method === 'POST' || method === 'DELETE');
  const isSensitiveRequest = isDiagnosticRequest || isPublicXmtpMutation;

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

    if (method === 'POST' && (
      pathname === '/api/xmtp/status' || pathname === '/api/xmtp/status/test'
    )) {
      const app = await ensureConvergeApp(env);
      if (!app) {
        return noStore(errorResponse(
          'XMTP diagnostics are not configured',
          ERROR_CODES.NOT_CONFIGURED,
          503
        ));
      }
      const attemptLimited = await enforceDiagnosticAttemptRate(
        request,
        env,
        app.id,
        pathname.endsWith('/test') ? 'test' : 'status'
      );
      if (attemptLimited) return attemptLimited;

      const receipt = diagnosticReceipt(request);
      if (!receipt) {
        return noStore(errorResponse(
          'Missing or invalid diagnostic receipt',
          ERROR_CODES.UNAUTHORIZED,
          401
        ));
      }

      if (pathname === '/api/xmtp/status') {
        const status = await getXmtpDiagnosticStatus(env, receipt);
        if (!status) {
          return noStore(errorResponse(
            'Diagnostic receipt is not active',
            ERROR_CODES.NOT_FOUND,
            404
          ));
        }
        return noStore(jsonResponse(status));
      }

      const scopedRateLimit = await scopedPublicRateLimitAction(
        request,
        env,
        'xmtp-diagnostic-test'
      );
      const result = await enqueueXmtpDiagnosticTest(env, receipt, scopedRateLimit);
      if (!result) {
        return noStore(errorResponse(
          'Diagnostic receipt is not active',
          ERROR_CODES.NOT_FOUND,
          404
        ));
      }
      return noStore(jsonResponse(result, 202));
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
      const store = new D1XmtpStore(env);
      const app = await ensureConvergeApp(env);
      if (!app) {
        return noStore(errorResponse(
          'Converge VAPID app is not configured',
          ERROR_CODES.NOT_CONFIGURED,
          503
        ));
      }
      const attemptLimited = await enforcePublicMutationAttemptRate(request, env, app.id);
      if (attemptLimited) return attemptLimited;

      if (method === 'POST') {
        const body = await readJsonBounded(request, 2_000_000);
        const input = normalizePublicXmtpRegistration(body);
        if (!isAllowedPublicWebPushEndpoint(input.endpoint)) {
          return noStore(errorResponse(
            'The push endpoint is not a supported browser Web Push provider',
            ERROR_CODES.VALIDATION_ERROR,
            422
          ));
        }

        const preflight = await authorizePublicRegistrationMutation(request, env, app.id, input);
        if (preflight instanceof Response) return preflight;
        const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
        if (!lockToken) return conflictResponse('This XMTP registration is already being updated');

        let endpointLockToken: string | null = null;
        try {
          endpointLockToken = await acquireXmtpEndpointMutationLock(
            env.DB,
            app.id,
            input.endpoint
          );
          if (!endpointLockToken) {
            return conflictResponse('This Web Push endpoint is already being updated');
          }
          // Close the race between the read-only preflight and lock acquisition.
          const authorized = await authorizePublicRegistrationMutation(request, env, app.id, input);
          if (authorized instanceof Response) return authorized;
          const [subscriptionCount, logicalRegistrationCount, endpointExists] = await Promise.all([
            countSubscriptions(env.DB, app.id),
            countActiveXmtpRegistrations(env.DB, app.id),
            hasActiveSubscriptionEndpoint(env.DB, app.id, input.endpoint),
          ]);
          const rateAction = authorized.exists
            ? 'xmtp-public-registration-refresh'
            : 'xmtp-public-new-registration';
          const scopedAction = await scopedPublicRateLimitAction(request, env, rateAction);
          const [globalRate, scopedRate] = await Promise.all([
            checkAndIncrementRateLimit(
              env.DB,
              app.id,
              rateAction,
              authorized.exists ? 600 : 120
            ),
            checkAndIncrementRateLimit(
              env.DB,
              app.id,
              scopedAction,
              authorized.exists ? 60 : 10
            ),
          ]);
          if (!globalRate.allowed || !scopedRate.allowed) {
            return noStore(errorResponse(
              'Public XMTP registration rate limit exceeded',
              ERROR_CODES.RATE_LIMIT_EXCEEDED,
              429,
              !scopedRate.allowed ? scopedRate : globalRate
            ));
          }
          if (
            !authorized.exists
            && (
              logicalRegistrationCount >= app.rateLimit.maxSubscriptions
              || (!endpointExists && subscriptionCount >= app.rateLimit.maxSubscriptions)
            )
          ) {
            return noStore(errorResponse(
              'Maximum subscriptions limit reached',
              ERROR_CODES.RATE_LIMIT_EXCEEDED,
              429
            ));
          }

          const result = await store.upsertRegistration(input, {
            diagnosticReceipt: authorized.receipt,
            issueDiagnosticReceipt: diagnosticsRequested(request) || Boolean(authorized.receipt),
            immutableEndpointKeys: true,
          });
          return noStore(jsonResponse(result, result.created ? 201 : 200));
        } finally {
          if (endpointLockToken) {
            await releaseEndpointLockSafely(env, app.id, input.endpoint, endpointLockToken);
          }
          await releaseMutationLockSafely(env, app.id, input, lockToken);
        }
      }

      const body = await readJsonBounded(request, 2_000_000);
      const input = normalizePublicXmtpDelete(body);
      const preflight = await authorizePublicRegistrationDelete(request, env, app.id, input);
      if (preflight instanceof Response) return preflight;
      if (!preflight.exists) return noStore(jsonResponse({ disabled: false }));
      const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
      if (!lockToken) return conflictResponse('This XMTP registration is already being updated');
      let endpointLockToken: string | null = null;
      try {
        endpointLockToken = await acquireXmtpEndpointMutationLock(
          env.DB,
          app.id,
          input.endpoint
        );
        if (!endpointLockToken) {
          return conflictResponse('This Web Push endpoint is already being updated');
        }
        const authorized = await authorizePublicRegistrationDelete(request, env, app.id, input);
        if (authorized instanceof Response) return authorized;
        if (!authorized.exists) return noStore(jsonResponse({ disabled: false }));
        return noStore(jsonResponse(await store.disableRegistration(input)));
      } finally {
        if (endpointLockToken) {
          await releaseEndpointLockSafely(env, app.id, input.endpoint, endpointLockToken);
        }
        await releaseMutationLockSafely(env, app.id, input, lockToken);
      }
    }

    if (pathname === '/api/xmtp/registrations' && (method === 'POST' || method === 'DELETE')) {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;
      const body = await readJson(request);
      const store = new D1XmtpStore(env, app.id);

      if (method === 'POST') {
        const input = normalizeGenericXmtpRegistration(body);
        const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
        if (!lockToken) return conflictResponse('This XMTP registration is already being updated');
        try {
          const result = await store.upsertRegistration(input);
          return noStore(jsonResponse(result, result.created ? 201 : 200));
        } finally {
          await releaseMutationLockSafely(env, app.id, input, lockToken);
        }
      }

      const input = normalizeGenericXmtpDelete(body);
      const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
      if (!lockToken) return conflictResponse('This XMTP registration is already being updated');
      try {
        return noStore(jsonResponse(await store.disableRegistration(input)));
      } finally {
        await releaseMutationLockSafely(env, app.id, input, lockToken);
      }
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
      const response = zodErrorResponse(error, null);
      return isSensitiveRequest ? noStore(response) : response;
    }

    if (error instanceof XmtpEndpointKeyConflictError) {
      return conflictResponse(error.message);
    }

    if (error instanceof RequestBodyTooLargeError) {
      return noStore(errorResponse(
        error.message,
        ERROR_CODES.PAYLOAD_TOO_LARGE,
        413
      ));
    }

    if (error instanceof XmtpAppIsolationPendingError) {
      const response = errorResponse(error.message, ERROR_CODES.NOT_CONFIGURED, 503);
      return isSensitiveRequest ? noStore(response) : response;
    }


    if (error instanceof XmtpDiagnosticRateLimitError) {
      return noStore(errorResponse(
        error.message,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        429,
        error.resetAt ? { resetAt: error.resetAt } : undefined
      ));
    }

    if (isSensitiveRequest) {
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({
        event: 'public_xmtp_request_failed',
        requestId,
        requestType: isDiagnosticRequest ? 'diagnostic' : 'registration',
      }));
      return noStore(errorResponse(
        'XMTP relay request failed',
        ERROR_CODES.INTERNAL_ERROR,
        500,
        { requestId }
      ));
    }

    const message = error instanceof Error ? error.message : 'Internal error';
    const response = errorResponse(
      isDiagnosticRequest ? 'Diagnostic request failed' : message,
      ERROR_CODES.INTERNAL_ERROR,
      500
    );
    return response;
  }
}
