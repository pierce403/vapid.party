import type { WebPushResult } from './push';
import type { AppRecord, PushPayload, SubscriptionRecord } from './types';
import { bytesToBase64Url } from './encoding';
import { getVapidPublicJwk } from './vapid';

const CALLBACK_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_SECONDS = 300;
const encoder = new TextEncoder();

function boundedRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
}

async function callbackSigningKey(app: AppRecord): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      ...getVapidPublicJwk(app.vapidPublicKey),
      d: app.vapidPrivateKey,
      key_ops: ['sign'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

export interface XmtpCallbackBody {
  version: 1;
  type: 'xmtp.message_available';
  deliveryId: string;
  inboxHandle: string;
}

export async function sendXmtpCallback(
  app: AppRecord,
  subscription: SubscriptionRecord,
  payload: PushPayload,
  deliveryId: string
): Promise<WebPushResult> {
  const inboxHandle = payload.inboxHandle;
  if (
    typeof inboxHandle !== 'string'
    || inboxHandle.length < 8
    || inboxHandle.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(inboxHandle)
  ) {
    return { success: false, statusCode: 422, error: 'Callback route handle is invalid' };
  }

  const body = JSON.stringify({
    version: 1,
    type: 'xmtp.message_available',
    deliveryId,
    inboxHandle,
  } satisfies XmtpCallbackBody);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signingInput = `${timestamp}\n${deliveryId}\n${body}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await callbackSigningKey(app),
    encoder.encode(signingInput)
  );

  try {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'Vapid-Party-App-Id': app.id,
        'Vapid-Party-Delivery-Id': deliveryId,
        'Vapid-Party-Timestamp': timestamp,
        'Vapid-Party-Signature': `v1=${bytesToBase64Url(new Uint8Array(signature))}`,
      },
      body,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { success: true, statusCode: response.status }
      : {
          success: false,
          statusCode: response.status,
          terminal: response.status === 404 || response.status === 410,
          error: `Callback returned HTTP ${response.status}`,
          ...(boundedRetryAfterSeconds(response.headers.get('retry-after')) === undefined
            ? {}
            : { retryAfterSeconds: boundedRetryAfterSeconds(response.headers.get('retry-after')) }),
        };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Callback failed',
    };
  }
}
