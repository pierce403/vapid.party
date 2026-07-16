import { ZodError } from 'zod';
import {
  authenticateApiKey,
  hasInternalIngestAuth,
  hasXmtpListenerSyncAuth,
} from './auth';
import {
  acquireAppSubscriptionMutationLock,
  acquireXmtpEndpointMutationLock,
  acquireXmtpRegistrationMutationLock,
  checkAndIncrementRateLimit,
  checkAndIncrementPublicRateLimit,
  countActiveXmtpRegistrations,
  countSubscriptions,
  createPublicApp,
  deleteApp,
  discardQueuedDeliveryAttempts,
  disableSubscription,
  D1XmtpStore,
  enqueueXmtpDiagnosticTest,
  ensureConvergeApp,
  diagnosticReceiptMatches,
  getActiveXmtpRegistrationState,
  getActiveSubscriptionEndpointKeys,
  getAppById,
  getAppPublicProfile,
  getAppUsageStats,
  getPublicLeaderboard,
  getSubscriptionManagementState,
  getXmtpDiagnosticStatus,
  getSubscriptionsByApp,
  getSubscriptionsByIds,
  hasActiveSubscriptionEndpoint,
  insertDeliveryAttempt,
  isAppSubscriptionLimitError,
  isXmtpAppCapacityLimitError,
  isXmtpGlobalCapacityLimitError,
  isXmtpHmacKeySizeError,
  isPublicAppCapacityLimitError,
  isPublicSubscriptionCapacityLimitError,
  isPublicApp,
  publicRequestScopeHash,
  recordAppDomainVerification,
  releaseAppSubscriptionMutationLock,
  releaseXmtpEndpointMutationLock,
  releaseXmtpRegistrationMutationLock,
  scopedPublicRateLimitAction,
  subscriptionManagementTokenMatches,
  updatePublicApp,
  upsertPublicSubscription,
  upsertSubscription,
  rotatePublicAppSecret,
  XmtpAppIsolationPendingError,
  XmtpDiagnosticRateLimitError,
  XmtpEndpointKeyConflictError,
  XmtpInstallationIdentityConflictError,
} from './db';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  readJsonBounded,
  RequestBodyTooLargeError,
  zodErrorResponse,
} from './http';
import {
  PublicAppCreateSchema,
  PublicAppUpdateSchema,
  PublicSubscribeSchema,
  PublicSubscriptionDeleteSchema,
  SendNotificationSchema,
  SubscribeSchema,
  XmtpListenerStatusSchema,
} from './schemas';
import {
  APP_DOMAIN_VERIFICATION_FRESHNESS_MS,
  appDomainRecord,
  DnsLookupError,
  normalizeAppDomain,
  verifyAppDomainRecord,
} from './domain';
import {
  enrollmentTicketMatches,
  issueEnrollmentTicket,
  type PublicSubscriptionTicketInput,
} from './enrollment-ticket';
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

const MAX_GENERIC_SEND_RECIPIENTS = 100;
const MAX_GENERIC_QUEUE_BATCH_BYTES = 240_000;
const MAX_WEB_PUSH_PAYLOAD_BYTES = 3_000;
const PUBLIC_SENDS_PER_MINUTE = 2_000;
const PUBLIC_SENDS_PER_DAY = 100_000;
const PUBLIC_STATE_MUTATIONS_PER_MINUTE = 5_000;
const PUBLIC_VERIFICATIONS_PER_MINUTE = 5_000;
const DELIVERY_ATTEMPT_ID_SIZE_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

class PushQueuePublishError extends Error {
  constructor(readonly rollbackSucceeded: boolean) {
    super('Push queue publish failed');
    this.name = 'PushQueuePublishError';
  }
}

async function requireApiApp(request: Request, env: Env): Promise<AppRecord | Response> {
  const app = await authenticateApiKey(request, env);
  if (!app) {
    return errorResponse('Missing or invalid X-API-Key header', ERROR_CODES.INVALID_API_KEY, 401);
  }
  return app;
}

async function requirePathApiApp(
  request: Request,
  env: Env,
  appId: string
): Promise<AppRecord | Response> {
  const app = await requireApiApp(request, env);
  if (app instanceof Response) return app;
  if (app.id !== appId) {
    return errorResponse('The app secret does not match this app', ERROR_CODES.FORBIDDEN, 403);
  }
  if (!await isPublicApp(env.DB, app.id)) {
    return errorResponse('App not found', ERROR_CODES.APP_NOT_FOUND, 404);
  }
  return app;
}

async function requireOperatorPathApiApp(
  request: Request,
  env: Env,
  appId: string
): Promise<AppRecord | Response> {
  const app = await requireApiApp(request, env);
  if (app instanceof Response) return app;
  if (app.id !== appId) {
    return errorResponse('The app secret does not match this app', ERROR_CODES.FORBIDDEN, 403);
  }
  if (await isPublicApp(env.DB, app.id)) {
    return errorResponse(
      'Public apps cannot inspect XMTP routes without installation ownership proof',
      ERROR_CODES.FORBIDDEN,
      403
    );
  }
  return app;
}

function appRoute(pathname: string): { appId: string; suffix: string } | null {
  const match = /^\/api\/apps\/([A-Za-z0-9_-]{1,128})(\/.*)?$/.exec(pathname);
  return match ? { appId: match[1], suffix: match[2] ?? '' } : null;
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

function privateNoStore(response: Response): Response {
  noStore(response);
  response.headers.delete('Access-Control-Allow-Origin');
  response.headers.delete('Access-Control-Allow-Methods');
  response.headers.delete('Access-Control-Allow-Headers');
  return response;
}

function diagnosticReceipt(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const receipt = authorization.slice(7);
  return /^[A-Za-z0-9_-]{43}$/.test(receipt) ? receipt : null;
}

function enrollmentTicket(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  return token.length <= 2048 && token.startsWith('vpet1.') ? token : null;
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

async function enforcePublicSubscriptionMutationRate(
  request: Request,
  env: Env,
  appId: string,
  method: 'post' | 'delete'
): Promise<Response | null> {
  const serviceRate = await checkAndIncrementPublicRateLimit(
    env.DB,
    'global',
    'public-state-mutation-global',
    PUBLIC_STATE_MUTATIONS_PER_MINUTE
  );
  if (!serviceRate.allowed) {
    return noStore(errorResponse(
      'Public app mutation capacity is temporarily rate limited',
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      429,
      serviceRate
    ));
  }
  const scopedAction = await scopedPublicRateLimitAction(
    request,
    env,
    method === 'post' ? 'subscription-public-upsert' : 'subscription-public-delete'
  );
  const scopedRate = await checkAndIncrementRateLimit(env.DB, appId, scopedAction, 12);
  if (!scopedRate.allowed) {
    return noStore(errorResponse(
      'Public subscription rate limit exceeded',
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      429,
      scopedRate
    ));
  }
  const globalRate = await checkAndIncrementRateLimit(
    env.DB,
    appId,
    `subscription-public-${method}`,
    120
  );
  if (!globalRate.allowed) {
    return noStore(errorResponse(
      'Public subscription rate limit exceeded',
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      429,
      globalRate
    ));
  }
  return null;
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

async function releaseAppSubscriptionLockSafely(
  env: Env,
  appId: string,
  lockToken: string
): Promise<void> {
  try {
    await releaseAppSubscriptionMutationLock(env.DB, appId, lockToken);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'app_subscription_lock_release_failed',
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

  try {
    for (const subscription of subscriptions) {
      const deliveryAttemptId = await insertDeliveryAttempt(env.DB, {
        appId,
        subscriptionId: subscription.id,
        eventType: 'generic.push',
        payload,
      });

      jobs.push({
        deliveryAttemptId,
        appId,
        subscriptionId: subscription.id,
        payload,
        source: 'generic',
      });
    }
  } catch (error) {
    await discardQueuedDeliveryAttempts(
      env.DB,
      jobs.map((job) => job.deliveryAttemptId)
    );
    throw error;
  }

  try {
    await env.PUSH_QUEUE.sendBatch(jobs.map((job) => ({
      body: job,
      contentType: 'json',
    })));
  } catch {
    let rollbackSucceeded = true;
    try {
      await discardQueuedDeliveryAttempts(
        env.DB,
        jobs.map((job) => job.deliveryAttemptId)
      );
    } catch {
      rollbackSucceeded = false;
    }
    throw new PushQueuePublishError(rollbackSucceeded);
  }
  return jobs;
}

function estimateGenericQueueBatchBytes(
  appId: string,
  subscriptions: SubscriptionRecord[],
  payload: Record<string, unknown>
): number {
  const encoder = new TextEncoder();
  let bytes = 2; // JSON array brackets.
  for (const [index, subscription] of subscriptions.entries()) {
    const request: MessageSendRequest<PushQueueJob> = {
      body: {
        deliveryAttemptId: DELIVERY_ATTEMPT_ID_SIZE_PLACEHOLDER,
        appId,
        subscriptionId: subscription.id,
        payload,
        source: 'generic',
      },
      contentType: 'json',
    };
    const json = JSON.stringify(request);
    bytes += encoder.encode(json).byteLength + (index === 0 ? 0 : 1);
  }
  return bytes;
}

async function handlePublicXmtpMutation(
  request: Request,
  env: Env,
  app: AppRecord,
  normalizers: {
    registration: (input: unknown) => NormalizedXmtpRegistration;
    deletion: (input: unknown) => { endpoint: string; inboxId: string; installationId: string };
  },
  options: { alwaysIssueReceipt?: boolean; diagnosticBasePath?: string } = {}
): Promise<Response> {
  const method = request.method.toUpperCase();
  const store = new D1XmtpStore(env, app.id);
  const attemptLimited = await enforcePublicMutationAttemptRate(request, env, app.id);
  if (attemptLimited) return attemptLimited;
  const body = await readJsonBounded(request, 2_000_000);

  if (method === 'POST') {
    const input = normalizers.registration(body);
    if (!isAllowedPublicWebPushEndpoint(input.endpoint)) {
      return noStore(errorResponse(
        'The push endpoint is not a supported browser Web Push provider',
        ERROR_CODES.VALIDATION_ERROR,
        422
      ));
    }

    const preflight = await authorizePublicRegistrationMutation(request, env, app.id, input);
    if (preflight instanceof Response) return preflight;
    const appLockToken = await acquireAppSubscriptionMutationLock(env.DB, app.id);
    if (!appLockToken) {
      return conflictResponse('This app is already updating its subscription quota');
    }
    try {
      const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
      if (!lockToken) {
        return conflictResponse('This XMTP registration is already being updated');
      }
      let endpointLockToken: string | null = null;
      try {
        endpointLockToken = await acquireXmtpEndpointMutationLock(env.DB, app.id, input.endpoint);
        if (!endpointLockToken) {
          return conflictResponse('This Web Push endpoint is already being updated');
        }
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
        const scopedRate = await checkAndIncrementRateLimit(
          env.DB,
          app.id,
          scopedAction,
          authorized.exists ? 60 : 10
        );
        if (!scopedRate.allowed) {
          return noStore(errorResponse(
            'Public XMTP registration rate limit exceeded',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            scopedRate
          ));
        }
        const globalRate = await checkAndIncrementRateLimit(
          env.DB,
          app.id,
          rateAction,
          authorized.exists ? 600 : 120
        );
        if (!globalRate.allowed) {
          return noStore(errorResponse(
            'Public XMTP registration rate limit exceeded',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            globalRate
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
          issueDiagnosticReceipt: options.alwaysIssueReceipt
            || diagnosticsRequested(request)
            || Boolean(authorized.receipt),
          immutableEndpointKeys: true,
          diagnosticBasePath: options.diagnosticBasePath,
        });
        return noStore(jsonResponse(result, result.created ? 201 : 200));
      } finally {
        if (endpointLockToken) {
          await releaseEndpointLockSafely(env, app.id, input.endpoint, endpointLockToken);
        }
        await releaseMutationLockSafely(env, app.id, input, lockToken);
      }
    } finally {
      await releaseAppSubscriptionLockSafely(env, app.id, appLockToken);
    }
  }

  const input = normalizers.deletion(body);
  const preflight = await authorizePublicRegistrationDelete(request, env, app.id, input);
  if (preflight instanceof Response) return preflight;
  if (!preflight.exists) return noStore(jsonResponse({ disabled: false }));
  const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
  if (!lockToken) return conflictResponse('This XMTP registration is already being updated');
  let endpointLockToken: string | null = null;
  try {
    endpointLockToken = await acquireXmtpEndpointMutationLock(env.DB, app.id, input.endpoint);
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

export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const route = appRoute(pathname);
  const isDiagnosticRequest = method === 'POST' && (
    pathname === '/api/xmtp/status' || pathname === '/api/xmtp/status/test'
  );
  const isPublicXmtpMutation = pathname === '/api/xmtp/subscriptions'
    && (method === 'POST' || method === 'DELETE');
  const isPrivateAppRequest = Boolean(route && (
    (method === 'GET' && (route.suffix === '/stats' || route.suffix === '/domain'))
    || (method === 'PATCH' && route.suffix === '/profile')
    || (method === 'POST' && (
      route.suffix === '/domain/verify'
      || route.suffix === '/secret/rotate'
      || route.suffix === '/enrollment-ticket'
      || route.suffix === '/xmtp/subscriptions'
      || route.suffix === '/xmtp/status'
      || route.suffix === '/xmtp/status/test'
    ))
    || (method === 'DELETE' && route.suffix === '')
  ));
  const isAppSensitiveRequest = pathname === '/api/apps'
    || Boolean(route && route.suffix !== '/vapid-public-key');
  const isSensitiveRequest = isDiagnosticRequest || isPublicXmtpMutation || isAppSensitiveRequest;

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

    if (method === 'POST' && pathname === '/api/apps') {
      const attemptRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'app-create-attempt-global',
        PUBLIC_VERIFICATIONS_PER_MINUTE
      );
      if (!attemptRate.allowed) {
        return noStore(errorResponse(
          'Anonymous app creation capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          attemptRate
        ));
      }
      const scopeHash = await publicRequestScopeHash(request, env);
      const scopedRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        scopeHash,
        'app-create-scoped',
        20
      );
      if (!scopedRate.allowed) {
        return noStore(errorResponse(
          'Anonymous app creation rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          scopedRate
        ));
      }
      const globalRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'app-create-global',
        600
      );
      if (!globalRate.allowed) {
        return noStore(errorResponse(
          'Anonymous app creation rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          globalRate
        ));
      }
      const input = PublicAppCreateSchema.parse(await readJsonBounded(request, 16_384));
      const domain = input.domain ? normalizeAppDomain(input.domain) : undefined;
      if (input.domain && !domain) {
        return noStore(errorResponse(
          'Domain must be a registrable hostname without a scheme, path, port, wildcard, or IP address',
          ERROR_CODES.VALIDATION_ERROR,
          422
        ));
      }
      const created = await createPublicApp(env.DB, { ...input, domain: domain ?? undefined });
      return noStore(jsonResponse({
        app: {
          id: created.app.id,
          name: created.app.name,
          publicVapidKey: created.app.vapidPublicKey,
          createdAt: created.app.createdAt,
        },
        appSecret: created.appSecret,
      }, 201));
    }

    if (method === 'GET' && pathname === '/api/leaderboard') {
      const response = jsonResponse({
        generatedAt: new Date().toISOString(),
        window: { kind: 'utc_dates', days: 7 },
        apps: await getPublicLeaderboard(env.DB),
      });
      response.headers.set('Cache-Control', 'public, max-age=60');
      return response;
    }

    if (route && method === 'GET' && route.suffix === '/vapid-public-key') {
      const [app, publicApp] = await Promise.all([
        getAppById(env.DB, route.appId),
        isPublicApp(env.DB, route.appId),
      ]);
      if (!app || !publicApp) {
        return errorResponse('App not found', ERROR_CODES.APP_NOT_FOUND, 404);
      }
      return jsonResponse({ appId: app.id, publicKey: app.vapidPublicKey });
    }

    if (route && method === 'POST' && route.suffix === '/enrollment-ticket') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const serviceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-state-mutation-global',
        PUBLIC_STATE_MUTATIONS_PER_MINUTE
      );
      if (!serviceRate.allowed) {
        return privateNoStore(errorResponse(
          'Public app mutation capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          serviceRate
        ));
      }
      const rate = await checkAndIncrementRateLimit(
        env.DB,
        app.id,
        'public-enrollment-ticket',
        300
      );
      if (!rate.allowed) {
        return privateNoStore(errorResponse(
          'Enrollment ticket rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          rate
        ));
      }
      const input = PublicSubscribeSchema.parse(await readJsonBounded(request, 65_536));
      if (!isAllowedPublicWebPushEndpoint(input.endpoint)) {
        return privateNoStore(errorResponse(
          'The push endpoint is not a supported browser Web Push provider',
          ERROR_CODES.VALIDATION_ERROR,
          422
        ));
      }
      return privateNoStore(jsonResponse(await issueEnrollmentTicket(app, input)));
    }

    if (route && route.suffix === '/subscriptions' && (method === 'POST' || method === 'DELETE')) {
      const verificationServiceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-subscription-verification-global',
        PUBLIC_VERIFICATIONS_PER_MINUTE
      );
      if (!verificationServiceRate.allowed) {
        return noStore(errorResponse(
          'Public subscription verification capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          verificationServiceRate
        ));
      }
      const preAuthScope = await publicRequestScopeHash(request, env);
      const preAuthRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        preAuthScope,
        method === 'POST' ? 'subscription-ticket-verify' : 'subscription-delete-verify',
        600
      );
      if (!preAuthRate.allowed) {
        return noStore(errorResponse(
          'Public subscription verification rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          preAuthRate
        ));
      }
      const [app, publicApp] = await Promise.all([
        getAppById(env.DB, route.appId),
        isPublicApp(env.DB, route.appId),
      ]);
      if (!app || !publicApp) {
        return noStore(errorResponse('App not found', ERROR_CODES.APP_NOT_FOUND, 404));
      }

      let publicSubscriptionInput: PublicSubscriptionTicketInput | undefined;
      if (method === 'POST') {
        publicSubscriptionInput = PublicSubscribeSchema.parse(
          await readJsonBounded(request, 65_536)
        );
        if (!isAllowedPublicWebPushEndpoint(publicSubscriptionInput.endpoint)) {
          return noStore(errorResponse(
            'The push endpoint is not a supported browser Web Push provider',
            ERROR_CODES.VALIDATION_ERROR,
            422
          ));
        }
        const ticket = enrollmentTicket(request);
        if (
          !ticket
          || !await enrollmentTicketMatches(ticket, app, publicSubscriptionInput)
        ) {
          return noStore(errorResponse(
            'Missing, expired, or mismatched enrollment ticket',
            ERROR_CODES.UNAUTHORIZED,
            401
          ));
        }
      }

      if (method === 'POST') {
        const input = publicSubscriptionInput as PublicSubscriptionTicketInput;
        const rateLimited = await enforcePublicSubscriptionMutationRate(
          request,
          env,
          app.id,
          'post'
        );
        if (rateLimited) return rateLimited;
        const appLockToken = await acquireAppSubscriptionMutationLock(env.DB, app.id);
        if (!appLockToken) {
          return conflictResponse('This app is already updating its subscription quota');
        }
        try {
          const lockToken = await acquireXmtpEndpointMutationLock(env.DB, app.id, input.endpoint);
          if (!lockToken) {
            return conflictResponse('This Web Push endpoint is already being updated');
          }
          try {
            const existing = await getSubscriptionManagementState(env.DB, app.id, input.endpoint);
            if (existing && (
              existing.p256dh !== input.keys.p256dh
              || existing.auth !== input.keys.auth
            )) {
              return conflictResponse(
                'An active Web Push endpoint cannot be reused with different subscription keys'
              );
            }
            if (existing && !existing.managementTokenHash) {
              return conflictResponse('This endpoint is managed through another enrollment contract');
            }
            if (
              !existing
              && await countSubscriptions(env.DB, app.id) >= app.rateLimit.maxSubscriptions
            ) {
              return noStore(errorResponse(
                'Maximum subscriptions limit reached',
                ERROR_CODES.RATE_LIMIT_EXCEEDED,
                429
              ));
            }
            const result = await upsertPublicSubscription(env.DB, app.id, {
              endpoint: input.endpoint,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              expirationTime: input.expirationTime,
            });
            return noStore(jsonResponse({
              subscriptionId: result.subscription.id,
              endpoint: result.subscription.endpoint,
              createdAt: result.subscription.createdAt,
              management: {
                token: result.managementToken,
                deletePath: `/api/apps/${app.id}/subscriptions`,
              },
            }, existing ? 200 : 201));
          } finally {
            await releaseEndpointLockSafely(env, app.id, input.endpoint, lockToken);
          }
        } finally {
          await releaseAppSubscriptionLockSafely(env, app.id, appLockToken);
        }
      }

      const input = PublicSubscriptionDeleteSchema.parse(
        await readJsonBounded(request, 16_384)
      );
      const token = diagnosticReceipt(request);
      if (!token) {
        return noStore(errorResponse(
          'Missing or invalid subscription management token',
          ERROR_CODES.UNAUTHORIZED,
          401
        ));
      }
      const lockToken = await acquireXmtpEndpointMutationLock(env.DB, app.id, input.endpoint);
      if (!lockToken) return conflictResponse('This Web Push endpoint is already being updated');
      try {
        const state = await getSubscriptionManagementState(env.DB, app.id, input.endpoint);
        if (!state) return noStore(jsonResponse({ disabled: false }));
        if (
          !state.managementTokenHash
          || !await subscriptionManagementTokenMatches(token, state.managementTokenHash)
        ) {
          return noStore(errorResponse(
            'Subscription management token is not valid for this endpoint',
            ERROR_CODES.UNAUTHORIZED,
            401
          ));
        }
        const rateLimited = await enforcePublicSubscriptionMutationRate(
          request,
          env,
          app.id,
          'delete'
        );
        if (rateLimited) return rateLimited;
        await disableSubscription(env.DB, state.id);
        return noStore(jsonResponse({ disabled: true }));
      } finally {
        await releaseEndpointLockSafely(env, app.id, input.endpoint, lockToken);
      }
    }

    if (route && method === 'POST' && (
      route.suffix === '/xmtp/status' || route.suffix === '/xmtp/status/test'
    )) {
      const app = await requireOperatorPathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);

      const kind = route.suffix.endsWith('/test') ? 'test' : 'status';
      const attemptLimited = await enforceDiagnosticAttemptRate(
        request,
        env,
        app.id,
        kind
      );
      if (attemptLimited) return privateNoStore(attemptLimited);

      const receipt = diagnosticReceipt(request);
      if (!receipt) {
        return privateNoStore(errorResponse(
          'Missing or invalid diagnostic receipt',
          ERROR_CODES.UNAUTHORIZED,
          401
        ));
      }

      if (kind === 'status') {
        const status = await getXmtpDiagnosticStatus(env, receipt, app.id);
        if (!status) {
          return privateNoStore(errorResponse(
            'Diagnostic receipt is not active',
            ERROR_CODES.NOT_FOUND,
            404
          ));
        }
        return privateNoStore(jsonResponse(status));
      }

      const scopedRateLimit = await scopedPublicRateLimitAction(
        request,
        env,
        'xmtp-diagnostic-test'
      );
      const result = await enqueueXmtpDiagnosticTest(
        env,
        receipt,
        scopedRateLimit,
        app.id
      );
      if (!result) {
        return privateNoStore(errorResponse(
          'Diagnostic receipt is not active',
          ERROR_CODES.NOT_FOUND,
          404
        ));
      }
      return privateNoStore(jsonResponse(result, 202));
    }

    if (route && route.suffix.startsWith('/xmtp/')) {
      const response = errorResponse(
        'General-public XMTP enrollment is disabled until installation ownership proof is available',
        ERROR_CODES.FORBIDDEN,
        403
      );
      return method === 'POST' ? privateNoStore(response) : noStore(response);
    }

    if (route && method === 'GET' && route.suffix === '/stats') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      return privateNoStore(jsonResponse({
        generatedAt: new Date().toISOString(),
        ...(await getAppUsageStats(env.DB, app)),
      }));
    }

    if (route && method === 'PATCH' && route.suffix === '/profile') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const input = PublicAppUpdateSchema.parse(await readJsonBounded(request, 16_384));
      const domain = typeof input.domain === 'string'
        ? normalizeAppDomain(input.domain)
        : input.domain;
      if (typeof input.domain === 'string' && !domain) {
        return privateNoStore(errorResponse(
          'Domain must be a registrable hostname without a scheme, path, port, wildcard, or IP address',
          ERROR_CODES.VALIDATION_ERROR,
          422
        ));
      }
      const serviceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-state-mutation-global',
        PUBLIC_STATE_MUTATIONS_PER_MINUTE
      );
      if (!serviceRate.allowed) {
        return privateNoStore(errorResponse(
          'Public app mutation capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          serviceRate
        ));
      }
      if (input.leaderboardOptIn === true) {
        const profile = await getAppPublicProfile(env.DB, app.id);
        const checkedAt = profile.domainLastCheckedAt
          ? new Date(profile.domainLastCheckedAt).getTime()
          : 0;
        if (
          profile.domainVerificationStatus !== 'verified'
          || Date.now() - checkedAt > APP_DOMAIN_VERIFICATION_FRESHNESS_MS
        ) {
          return privateNoStore(errorResponse(
            'Verify this app domain before listing it on the leaderboard',
            ERROR_CODES.CONFLICT,
            409
          ));
        }
      }
      const updated = await updatePublicApp(env.DB, app.id, { ...input, domain });
      return updated
        ? privateNoStore(jsonResponse({ app: {
            id: updated.app.id,
            name: updated.app.name,
            publicVapidKey: updated.app.vapidPublicKey,
          }, profile: updated.profile }))
        : privateNoStore(errorResponse('App not found', ERROR_CODES.APP_NOT_FOUND, 404));
    }

    if (route && method === 'GET' && route.suffix === '/domain') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const profile = await getAppPublicProfile(env.DB, app.id);
      return privateNoStore(jsonResponse({
        domain: profile.domain,
        status: profile.domainVerificationStatus,
        checkedAt: profile.domainLastCheckedAt,
        verifiedAt: profile.domainVerifiedAt,
        record: profile.domain
          ? appDomainRecord(profile.domain, app.id, app.vapidPublicKey)
          : null,
      }));
    }

    if (route && method === 'POST' && route.suffix === '/domain/verify') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const profile = await getAppPublicProfile(env.DB, app.id);
      if (!profile.domain) {
        return privateNoStore(errorResponse(
          'Set an app domain before verification',
          ERROR_CODES.CONFLICT,
          409
        ));
      }
      const serviceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-domain-verify',
        600
      );
      if (!serviceRate.allowed) {
        return privateNoStore(errorResponse(
          'Domain verification capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          serviceRate
        ));
      }
      const scopedAction = await scopedPublicRateLimitAction(request, env, 'domain-verify');
      const scopedRate = await checkAndIncrementRateLimit(env.DB, app.id, scopedAction, 6);
      if (!scopedRate.allowed) {
        return privateNoStore(errorResponse(
          'Domain verification rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          scopedRate
        ));
      }
      const appRate = await checkAndIncrementRateLimit(env.DB, app.id, 'domain-verify', 30);
      if (!appRate.allowed) {
        return privateNoStore(errorResponse(
          'Domain verification rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          appRate
        ));
      }
      const status = await verifyAppDomainRecord(
        profile.domain,
        app.id,
        app.vapidPublicKey
      );
      const updated = await recordAppDomainVerification(
        env.DB,
        app.id,
        profile.domain,
        status,
        status === 'verified' ? app.vapidPublicKey : undefined
      );
      return privateNoStore(jsonResponse({
        domain: profile.domain,
        status,
        checkedAt: updated?.domainLastCheckedAt,
        verifiedAt: updated?.domainVerifiedAt,
        record: appDomainRecord(profile.domain, app.id, app.vapidPublicKey),
      }));
    }

    if (route && method === 'POST' && route.suffix === '/secret/rotate') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const serviceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-state-mutation-global',
        PUBLIC_STATE_MUTATIONS_PER_MINUTE
      );
      if (!serviceRate.allowed) {
        return privateNoStore(errorResponse(
          'Public app mutation capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          serviceRate
        ));
      }
      const rate = await checkAndIncrementRateLimit(
        env.DB,
        app.id,
        'app-secret-rotate',
        10,
        { window: 'day' }
      );
      if (!rate.allowed) {
        return privateNoStore(errorResponse(
          'App secret rotation limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          rate
        ));
      }
      const currentAppSecret = request.headers.get('x-api-key') as string;
      const appSecret = await rotatePublicAppSecret(env.DB, app.id, currentAppSecret);
      if (!appSecret) {
        return privateNoStore(errorResponse(
          'The app secret changed before this rotation completed',
          ERROR_CODES.CONFLICT,
          409
        ));
      }
      return privateNoStore(jsonResponse({
        appId: app.id,
        appSecret,
      }));
    }

    if (route && method === 'DELETE' && route.suffix === '') {
      const app = await requirePathApiApp(request, env, route.appId);
      if (app instanceof Response) return privateNoStore(app);
      const serviceRate = await checkAndIncrementPublicRateLimit(
        env.DB,
        'global',
        'public-state-mutation-global',
        PUBLIC_STATE_MUTATIONS_PER_MINUTE
      );
      if (!serviceRate.allowed) {
        return privateNoStore(errorResponse(
          'Public app mutation capacity is temporarily rate limited',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          serviceRate
        ));
      }
      const appLockToken = await acquireAppSubscriptionMutationLock(env.DB, app.id);
      if (!appLockToken) {
        return privateNoStore(conflictResponse(
          'This app is already updating its subscription state'
        ));
      }
      try {
        return privateNoStore(jsonResponse({ deleted: await deleteApp(env.DB, app.id) }));
      } finally {
        await releaseAppSubscriptionLockSafely(env, app.id, appLockToken);
      }
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
        const input = XmtpListenerStatusSchema.parse(await readJsonBounded(request, 32_768));
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
      const app = await ensureConvergeApp(env);
      if (!app) {
        return noStore(errorResponse(
          'Converge VAPID app is not configured',
          ERROR_CODES.NOT_CONFIGURED,
          503
        ));
      }
      return await handlePublicXmtpMutation(
        request,
        env,
        app,
        {
          registration: normalizePublicXmtpRegistration,
          deletion: normalizePublicXmtpDelete,
        }
      );
    }

    if (pathname === '/api/xmtp/registrations' && (method === 'POST' || method === 'DELETE')) {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;
      if (await isPublicApp(env.DB, app.id)) {
        return noStore(errorResponse(
          'Public apps cannot register XMTP routes without installation ownership proof',
          ERROR_CODES.FORBIDDEN,
          403
        ));
      }
      const body = await readJsonBounded(request, 2_000_000);
      const store = new D1XmtpStore(env, app.id);

      if (method === 'POST') {
        const input = normalizeGenericXmtpRegistration(body);
        if (!isAllowedPublicWebPushEndpoint(input.endpoint)) {
          return errorResponse(
            'The push endpoint is not a supported browser Web Push provider',
            ERROR_CODES.VALIDATION_ERROR,
            422
          );
        }
        const appLockToken = await acquireAppSubscriptionMutationLock(env.DB, app.id);
        if (!appLockToken) {
          return conflictResponse('This app is already updating its subscription quota');
        }
        try {
          const existing = await getActiveXmtpRegistrationState(env.DB, app.id, input);
          const [subscriptionCount, logicalCount, endpointExists] = await Promise.all([
            countSubscriptions(env.DB, app.id),
            countActiveXmtpRegistrations(env.DB, app.id),
            hasActiveSubscriptionEndpoint(env.DB, app.id, input.endpoint),
          ]);
          if (
            !existing
            && (
              logicalCount >= app.rateLimit.maxSubscriptions
              || (!endpointExists && subscriptionCount >= app.rateLimit.maxSubscriptions)
            )
          ) {
            return errorResponse(
              'Maximum subscriptions limit reached',
              ERROR_CODES.RATE_LIMIT_EXCEEDED,
              429
            );
          }
          const lockToken = await acquireXmtpRegistrationMutationLock(env.DB, app.id, input);
          if (!lockToken) {
            return conflictResponse('This XMTP registration is already being updated');
          }
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
            const result = await store.upsertRegistration(input, {
              issueDiagnosticReceipt: true,
              immutableEndpointKeys: true,
              diagnosticBasePath: `/api/apps/${app.id}/xmtp`,
            });
            return noStore(jsonResponse(result, result.created ? 201 : 200));
          } finally {
            if (endpointLockToken) {
              await releaseEndpointLockSafely(env, app.id, input.endpoint, endpointLockToken);
            }
            await releaseMutationLockSafely(env, app.id, input, lockToken);
          }
        } finally {
          await releaseAppSubscriptionLockSafely(env, app.id, appLockToken);
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

      const body = await readJsonBounded(request, 21_000_000);
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

      const body = await readJsonBounded(request, 65_536);
      const input = SubscribeSchema.parse(body);
      if (!isAllowedPublicWebPushEndpoint(input.endpoint)) {
        return errorResponse(
          'The push endpoint is not a supported browser Web Push provider',
          ERROR_CODES.VALIDATION_ERROR,
          422
        );
      }
      if (await isPublicApp(env.DB, app.id)) {
        const serviceRate = await checkAndIncrementPublicRateLimit(
          env.DB,
          'global',
          'public-state-mutation-global',
          PUBLIC_STATE_MUTATIONS_PER_MINUTE
        );
        if (!serviceRate.allowed) {
          return errorResponse(
            'Public app mutation capacity is temporarily rate limited',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            serviceRate
          );
        }
        const appRate = await checkAndIncrementRateLimit(
          env.DB,
          app.id,
          'public-authenticated-subscribe',
          300
        );
        if (!appRate.allowed) {
          return errorResponse(
            'Public app subscription rate limit exceeded',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            appRate
          );
        }
      }
      const appLockToken = await acquireAppSubscriptionMutationLock(env.DB, app.id);
      if (!appLockToken) {
        return conflictResponse('This app is already updating its subscription quota');
      }
      try {
        const [count, endpointExists] = await Promise.all([
          countSubscriptions(env.DB, app.id),
          hasActiveSubscriptionEndpoint(env.DB, app.id, input.endpoint),
        ]);
        if (!endpointExists && count >= app.rateLimit.maxSubscriptions) {
          return errorResponse(
            'Maximum subscriptions limit reached',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429
          );
        }
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
      } finally {
        await releaseAppSubscriptionLockSafely(env, app.id, appLockToken);
      }
    }

    if (method === 'POST' && pathname === '/api/send') {
      const app = await requireApiApp(request, env);
      if (app instanceof Response) return app;

      const body = await readJsonBounded(request, 65_536);
      const input = SendNotificationSchema.parse(body);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength;
      if (payloadBytes > MAX_WEB_PUSH_PAYLOAD_BYTES) {
        return errorResponse(
          'Notification payload is too large for reliable Web Push delivery',
          ERROR_CODES.PAYLOAD_TOO_LARGE,
          413,
          { payloadBytes, maxPayloadBytes: MAX_WEB_PUSH_PAYLOAD_BYTES }
        );
      }
      const subscriptions = input.subscriptionIds?.length
        ? await getSubscriptionsByIds(env.DB, app.id, input.subscriptionIds)
        : await getSubscriptionsByApp(env.DB, app.id, {
            userId: input.userId,
            channelId: input.channelId,
            limit: MAX_GENERIC_SEND_RECIPIENTS + 1,
          });

      if (subscriptions.length > MAX_GENERIC_SEND_RECIPIENTS) {
        return errorResponse(
          `A send request can target at most ${MAX_GENERIC_SEND_RECIPIENTS} active subscriptions`,
          ERROR_CODES.VALIDATION_ERROR,
          422
        );
      }

      if (subscriptions.length === 0) {
        return jsonResponse({ queued: 0, sent: 0, failed: 0, total: 0, jobs: [] });
      }

      const estimatedBatchBytes = estimateGenericQueueBatchBytes(
        app.id,
        subscriptions,
        input.payload
      );
      if (estimatedBatchBytes > MAX_GENERIC_QUEUE_BATCH_BYTES) {
        return errorResponse(
          'Notification batch is too large to publish safely',
          ERROR_CODES.PAYLOAD_TOO_LARGE,
          413,
          { estimatedBatchBytes, maxBatchBytes: MAX_GENERIC_QUEUE_BATCH_BYTES }
        );
      }

      const minuteRateLimit = await checkAndIncrementRateLimit(
        env.DB,
        app.id,
        'notification-send-minute',
        app.rateLimit.maxNotificationsPerMinute,
        { amount: subscriptions.length }
      );
      if (!minuteRateLimit.allowed) {
        return errorResponse(
          'Per-minute notification rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          minuteRateLimit
        );
      }
      const dailyRateLimit = await checkAndIncrementRateLimit(
        env.DB,
        app.id,
        'notification-send-day',
        app.rateLimit.maxNotificationsPerDay,
        { amount: subscriptions.length, window: 'day' }
      );
      if (!dailyRateLimit.allowed) {
        return errorResponse(
          'Daily notification rate limit exceeded',
          ERROR_CODES.RATE_LIMIT_EXCEEDED,
          429,
          dailyRateLimit
        );
      }

      // Isolate tenant exhaustion before reserving shared relay capacity. A
      // public app that is already over its own minute/day allowance must not
      // be able to consume the cross-app service buckets with rejected sends.
      if (await isPublicApp(env.DB, app.id)) {
        const globalMinuteRate = await checkAndIncrementPublicRateLimit(
          env.DB,
          'global',
          'public-notification-send-minute',
          PUBLIC_SENDS_PER_MINUTE,
          { amount: subscriptions.length }
        );
        if (!globalMinuteRate.allowed) {
          return errorResponse(
            'Public relay capacity is temporarily rate limited',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            globalMinuteRate
          );
        }
        const globalDayRate = await checkAndIncrementPublicRateLimit(
          env.DB,
          'global',
          'public-notification-send-day',
          PUBLIC_SENDS_PER_DAY,
          { amount: subscriptions.length, window: 'day' }
        );
        if (!globalDayRate.allowed) {
          return errorResponse(
            'Public relay daily capacity is temporarily exhausted',
            ERROR_CODES.RATE_LIMIT_EXCEEDED,
            429,
            globalDayRate
          );
        }
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
      if (isPrivateAppRequest) return privateNoStore(response);
      return isSensitiveRequest ? noStore(response) : response;
    }

    if (
      error instanceof XmtpEndpointKeyConflictError
      || error instanceof XmtpInstallationIdentityConflictError
    ) {
      return conflictResponse(error.message);
    }

    if (isAppSubscriptionLimitError(error)) {
      const response = errorResponse(
        'Maximum subscriptions limit reached',
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        429
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (isXmtpAppCapacityLimitError(error)) {
      const response = errorResponse(
        'This app has reached its XMTP listener row capacity',
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        429,
        { maxTopicAndHmacRows: 5000 }
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (isXmtpGlobalCapacityLimitError(error)) {
      const response = errorResponse(
        'XMTP listener capacity is temporarily full',
        ERROR_CODES.CAPACITY_EXCEEDED,
        503,
        { maxTopicAndHmacRows: 25000 }
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (isXmtpHmacKeySizeError(error)) {
      const response = errorResponse(
        'XMTP HMAC keys must decode to between 1 and 256 bytes',
        ERROR_CODES.VALIDATION_ERROR,
        422
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (isPublicAppCapacityLimitError(error)) {
      return noStore(errorResponse(
        'Anonymous app capacity is temporarily full',
        ERROR_CODES.CAPACITY_EXCEEDED,
        503,
        { maxPublicApps: 25000 }
      ));
    }

    if (isPublicSubscriptionCapacityLimitError(error)) {
      const response = errorResponse(
        'Anonymous subscription capacity is temporarily full',
        ERROR_CODES.CAPACITY_EXCEEDED,
        503,
        { maxPublicSubscriptions: 250000 }
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (error instanceof RequestBodyTooLargeError) {
      const response = errorResponse(
        error.message,
        ERROR_CODES.PAYLOAD_TOO_LARGE,
        413
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (error instanceof XmtpAppIsolationPendingError) {
      const response = errorResponse(error.message, ERROR_CODES.NOT_CONFIGURED, 503);
      return isSensitiveRequest ? noStore(response) : response;
    }


    if (error instanceof XmtpDiagnosticRateLimitError) {
      const response = errorResponse(
        error.message,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        429,
        error.resetAt ? { resetAt: error.resetAt } : undefined
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (error instanceof DnsLookupError) {
      const response = errorResponse(
        error.message,
        ERROR_CODES.DNS_LOOKUP_FAILED,
        502
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
    }

    if (error instanceof PushQueuePublishError) {
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({
        event: 'push_queue_publish_failed',
        requestId,
        rollbackSucceeded: error.rollbackSucceeded,
      }));
      return noStore(errorResponse(
        'Push queue is temporarily unavailable',
        ERROR_CODES.PUSH_FAILED,
        503,
        { requestId }
      ));
    }

    if (isAppSensitiveRequest) {
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({
        event: 'public_app_request_failed',
        requestId,
        method,
        route: route?.suffix ?? pathname,
      }));
      const response = errorResponse(
        'App request failed',
        ERROR_CODES.INTERNAL_ERROR,
        500,
        { requestId }
      );
      return isPrivateAppRequest ? privateNoStore(response) : noStore(response);
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
