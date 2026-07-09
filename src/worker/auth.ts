import type { AppRecord, Env } from './types';
import { getAppByApiKey, getAppsByOwner } from './db';

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

export async function authenticateApiKey(request: Request, env: Env): Promise<AppRecord | null> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return null;
  return getAppByApiKey(env.DB, apiKey);
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
