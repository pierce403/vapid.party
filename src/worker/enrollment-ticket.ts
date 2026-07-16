import type { AppRecord } from './types';
import { base64UrlToBytes, bytesToBase64Url, sha256Hex } from './encoding';

const TICKET_VERSION = 'vpet1';
const TICKET_TTL_SECONDS = 5 * 60;
const encoder = new TextEncoder();

export interface PublicSubscriptionTicketInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

interface EnrollmentTicketClaims {
  v: 1;
  appId: string;
  subscriptionHash: string;
  expiresAt: number;
}

function normalizedSubscription(input: PublicSubscriptionTicketInput): string {
  return JSON.stringify({
    endpoint: input.endpoint,
    keys: {
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
    },
    expirationTime: input.expirationTime ?? null,
  });
}

async function subscriptionHash(input: PublicSubscriptionTicketInput): Promise<string> {
  return sha256Hex(normalizedSubscription(input));
}

async function ticketKey(app: AppRecord): Promise<CryptoKey> {
  const privateKey = base64UrlToBytes(app.vapidPrivateKey);
  if (!privateKey || privateKey.length !== 32) {
    throw new Error('App VAPID private key cannot derive enrollment tickets');
  }
  const material = await crypto.subtle.importKey('raw', privateKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(app.id),
      info: encoder.encode('vapid.party/public-subscription-ticket/v1'),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

function claimsBytes(claims: EnrollmentTicketClaims): Uint8Array {
  return encoder.encode(JSON.stringify(claims));
}

export async function issueEnrollmentTicket(
  app: AppRecord,
  input: PublicSubscriptionTicketInput
): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const claims: EnrollmentTicketClaims = {
    v: 1,
    appId: app.id,
    subscriptionHash: await subscriptionHash(input),
    expiresAt,
  };
  const payload = bytesToBase64Url(claimsBytes(claims));
  const signingInput = encoder.encode(`${TICKET_VERSION}.${payload}`);
  const signature = await crypto.subtle.sign('HMAC', await ticketKey(app), signingInput);
  return {
    token: `${TICKET_VERSION}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function enrollmentTicketMatches(
  token: string,
  app: AppRecord,
  input: PublicSubscriptionTicketInput
): Promise<boolean> {
  const match = /^vpet1\.([A-Za-z0-9_-]{1,1500})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const payloadBytes = base64UrlToBytes(match[1]);
  const signature = base64UrlToBytes(match[2]);
  if (!payloadBytes || payloadBytes.length > 1024 || !signature || signature.length !== 32) {
    return false;
  }

  const signatureValid = await crypto.subtle.verify(
    'HMAC',
    await ticketKey(app),
    signature,
    encoder.encode(`${TICKET_VERSION}.${match[1]}`)
  );
  if (!signatureValid) return false;

  let claims: EnrollmentTicketClaims;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<EnrollmentTicketClaims>;
    if (
      parsed.v !== 1
      || parsed.appId !== app.id
      || typeof parsed.subscriptionHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.subscriptionHash)
      || !Number.isInteger(parsed.expiresAt)
    ) return false;
    claims = parsed as EnrollmentTicketClaims;
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.expiresAt <= now || claims.expiresAt > now + TICKET_TTL_SECONDS + 5) return false;
  if (claims.subscriptionHash !== await subscriptionHash(input)) return false;
  return true;
}
