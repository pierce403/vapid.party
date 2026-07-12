import type { AppRecord, Env } from './types';
import { ensureConvergeApp, getAppByApiKey, getAppsByOwner } from './db';
import { timingSafeEqualString } from './encoding';

export interface WalletAuth {
  walletAddress: string;
}

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

export async function authenticateApiKey(request: Request, env: Env): Promise<AppRecord | null> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return null;
  let app = await getAppByApiKey(env.DB, apiKey);
  if (!app && env.CONVERGE_API_KEY && timingSafeEqualString(apiKey, env.CONVERGE_API_KEY)) {
    app = await ensureConvergeApp(env);
  }
  if (!app) return null;

  if (!isGenericApiKeyAllowed(app.id, apiKey, env)) return null;

  return app;
}

export function verifyWalletAuth(request: Request): WalletAuth | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const [, payload] = token.split('.');
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { exp?: number; sub?: string; address?: string };

    if (decoded.exp && Date.now() / 1000 > decoded.exp) return null;
    const walletAddress = decoded.sub || decoded.address;
    return walletAddress ? { walletAddress: walletAddress.toLowerCase() } : null;
  } catch {
    return null;
  }
}

export async function ownsApp(env: Env, walletAddress: string, appId: string): Promise<boolean> {
  const apps = await getAppsByOwner(env.DB, walletAddress);
  return apps.some((app) => app.id === appId);
}
