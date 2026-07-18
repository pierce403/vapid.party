import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendXmtpCallback } from '../../src/worker/callback';
import { base64UrlToBytes } from '../../src/worker/encoding';
import { generateVapidKeys } from '../../src/worker/vapid';
import type { AppRecord, SubscriptionRecord } from '../../src/worker/types';

async function callbackContext(): Promise<{
  app: AppRecord;
  subscription: SubscriptionRecord;
}> {
  const vapid = await generateVapidKeys();
  return {
    app: {
      id: 'app-callback',
      name: 'Callback App',
      ownerWallet: 'public',
      apiKey: 'unused',
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey,
      metadata: {},
      rateLimit: {
        maxNotificationsPerMinute: 60,
        maxNotificationsPerDay: 10_000,
        maxSubscriptions: 150,
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    },
    subscription: {
      id: 'subscription-callback',
      appId: 'app-callback',
      endpoint: 'https://notify.example.com/api/xmtp',
      p256dh: '',
      auth: '',
      deliveryKind: 'https_callback',
      metadata: { source: 'xmtp', deliveryKind: 'https_callback' },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    },
  };
}

describe('signed XMTP callback delivery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends only an opaque route handle and a verifiable stable delivery id', async () => {
    const { app, subscription } = await callbackContext();
    let captured: Request | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return new Response(null, { status: 204 });
    }));

    const result = await sendXmtpCallback(
      app,
      subscription,
      { type: 'xmtp.new_message', inboxHandle: 'opaque_route_1' },
      'delivery-123'
    );

    expect(result).toEqual({ success: true, statusCode: 204 });
    expect(captured).toBeDefined();
    const request = captured as Request;
    const body = await request.text();
    expect(JSON.parse(body)).toEqual({
      version: 1,
      type: 'xmtp.message_available',
      deliveryId: 'delivery-123',
      inboxHandle: 'opaque_route_1',
    });
    expect(body).not.toContain('topic');
    expect(body).not.toContain('installation');
    expect(request.headers.get('Vapid-Party-App-Id')).toBe(app.id);
    expect(request.headers.get('Vapid-Party-Delivery-Id')).toBe('delivery-123');

    const timestamp = request.headers.get('Vapid-Party-Timestamp') as string;
    const encodedSignature = request.headers
      .get('Vapid-Party-Signature')
      ?.replace(/^v1=/, '');
    const signature = encodedSignature ? base64UrlToBytes(encodedSignature) : null;
    const publicRaw = base64UrlToBytes(app.vapidPublicKey);
    expect(signature).toHaveLength(64);
    expect(publicRaw).toHaveLength(65);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicRaw as Uint8Array,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature as Uint8Array,
      new TextEncoder().encode(`${timestamp}\ndelivery-123\n${body}`)
    )).toBe(true);
  });

  it('classifies callback throttling for Queue retry and bounds Retry-After', async () => {
    const { app, subscription } = await callbackContext();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '900' },
    })));

    expect(await sendXmtpCallback(
      app,
      subscription,
      { inboxHandle: 'opaque_route_2' },
      'delivery-456'
    )).toEqual({
      success: false,
      statusCode: 429,
      terminal: false,
      error: 'Callback returned HTTP 429',
      retryAfterSeconds: 300,
    });
  });

  it('rejects a malformed route handle without calling the callback', async () => {
    const { app, subscription } = await callbackContext();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendXmtpCallback(app, subscription, {}, 'delivery-789')).toMatchObject({
      success: false,
      statusCode: 422,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
