import type { AppRecord, Env } from './types';
import { ensureConvergeApp, getAppByApiKey, getAppByCredentialHash } from './db';
import { sha256Hex, timingSafeEqualString } from './encoding';

export const PUBLIC_CONVERGE_ROUTES = new Set([
  'GET /api/xmtp/vapid-public-key',
  'POST /api/xmtp/subscriptions',
  'DELETE /api/xmtp/subscriptions',
]);

export function isPublicConvergeRoute(method: string, pathname: string): boolean {
  return PUBLIC_CONVERGE_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

export function isGenericApiKeyAllowed(
  appId: string,
  apiKey: string,
  env: Pick<Env, 'CONVERGE_APP_ID' | 'CONVERGE_API_KEY'>
): boolean {
  const convergeAppId = env.CONVERGE_APP_ID || 'converge';
  if (appId !== convergeAppId) return true;
  return Boolean(
    env.CONVERGE_API_KEY && timingSafeEqualString(apiKey, env.CONVERGE_API_KEY)
  );
}

export function hasInternalIngestAuth(
  request: Request,
  env: Pick<Env, 'INTERNAL_INGEST_TOKEN'>
): boolean {
  if (!env.INTERNAL_INGEST_TOKEN) return false;
  const authorization = request.headers.get('authorization');
  const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const legacyToken = request.headers.get('x-internal-token');
  return [bearerToken, legacyToken].some(
    (candidate) => candidate && timingSafeEqualString(candidate, env.INTERNAL_INGEST_TOKEN as string)
  );
}

export function hasXmtpListenerSyncAuth(
  request: Request,
  env: Pick<Env, 'XMTP_LISTENER_SYNC_TOKEN'>
): boolean {
  if (!env.XMTP_LISTENER_SYNC_TOKEN) return false;
  const authorization = request.headers.get('authorization');
  const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  return Boolean(
    bearerToken && timingSafeEqualString(bearerToken, env.XMTP_LISTENER_SYNC_TOKEN)
  );
}

export async function authenticateApiKey(request: Request, env: Env): Promise<AppRecord | null> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return null;
  let app = await getAppByCredentialHash(env.DB, await sha256Hex(apiKey));
  if (!app) app = await getAppByApiKey(env.DB, apiKey);
  if (!app && env.CONVERGE_API_KEY && timingSafeEqualString(apiKey, env.CONVERGE_API_KEY)) {
    app = await ensureConvergeApp(env);
  }
  if (!app) return null;

  if (!isGenericApiKeyAllowed(app.id, apiKey, env)) return null;

  return app;
}
