import {
  GenericXmtpDeleteSubscriptionRequestSchema,
  GenericXmtpSubscriptionRequestSchema,
  XmtpPublicDeleteSubscriptionRequestSchema,
  XmtpPublicSubscriptionRequestSchema,
  XmtpDeleteSubscriptionRequestSchema,
  XmtpDeliveryRequestSchema,
  XmtpSubscriptionRequestSchema,
  PublicXmtpDeleteRequestSchema,
  PublicXmtpRegistrationSchema,
} from './schemas';
import type { PushPayload, XmtpTopicMatch } from './types';

export interface NormalizedXmtpHmacKey {
  epoch: string;
  key: string;
}

export interface NormalizedXmtpTopic {
  topic: string;
  hmacKeys: NormalizedXmtpHmacKey[];
  algorithm: 'hmac-sha256' | 'sha256';
  conversationId?: string;
}

export interface NormalizedXmtpRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
  deliveryKind: 'web_push' | 'https_callback';
  expirationTime?: number | null;
  inboxId: string;
  installationId: string;
  address?: string;
  inboxHandle?: string;
  preferences: {
    minimalPayloadOnly: true;
    plaintextPreview: false;
  };
  topics: NormalizedXmtpTopic[];
}

export interface XmtpRegistrationResult {
  subscriptionId: string;
  identityId: string;
  topicsRegistered: number;
  hmacKeysRegistered: number;
  created: boolean;
  diagnostics?: {
    receipt: string;
    statusPath: string;
    testPath: string;
  };
}

export interface XmtpUnsubscribeResult {
  disabled: boolean;
}

export interface XmtpRegistrationStore {
  upsertRegistration(
    input: NormalizedXmtpRegistration,
    options?: {
      diagnosticReceipt?: string;
      issueDiagnosticReceipt?: boolean;
      immutableEndpointKeys?: boolean;
      diagnosticBasePath?: string;
    }
  ): Promise<XmtpRegistrationResult>;
  disableRegistration(input: { endpoint: string; inboxId: string; installationId: string }): Promise<XmtpUnsubscribeResult>;
}

export interface XmtpRelayStore {
  findDeliveryMatches(installationId: string, topic: string, deliveryToken: string): Promise<XmtpTopicMatch[]>;
  enqueueXmtpPush(
    match: XmtpTopicMatch,
    payload: PushPayload,
    idempotencyKey: string
  ): Promise<boolean>;
}

export function isAllowedPublicWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.port && url.port !== '443') return false;
  if (url.username || url.password || url.hash) return false;

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'fcm.googleapis.com') {
    return url.search === '' && /^\/(?:fcm\/send|wp)\/[^/]+$/.test(url.pathname);
  }
  if (hostname === 'updates.push.services.mozilla.com') {
    return url.search === '' && /^\/wpush\/v\d+\/[^/]+$/.test(url.pathname);
  }
  if (hostname.endsWith('.push.apple.com')) {
    return url.search === '' && /^\/[^/]+$/.test(url.pathname);
  }
  if (hostname === 'notify.windows.com' || hostname.endsWith('.notify.windows.com')) {
    return (url.pathname === '/' || url.pathname === '/w/')
      && url.searchParams.size === 1
      && Boolean(url.searchParams.get('token'));
  }
  return false;
}

function addTopic(
  output: Map<string, NormalizedXmtpTopic>,
  input: {
    topic: string;
    hmacKeys?: NormalizedXmtpHmacKey[];
    algorithm?: 'hmac-sha256' | 'sha256';
    conversationId?: string;
  }
): void {
  const existing = output.get(input.topic);
  const topic = existing ?? {
    topic: input.topic,
    hmacKeys: [],
    algorithm: input.algorithm ?? 'hmac-sha256',
    conversationId: input.conversationId,
  };

  for (const candidate of input.hmacKeys ?? []) {
    if (!topic.hmacKeys.some((entry) => entry.epoch === candidate.epoch && entry.key === candidate.key)) {
      topic.hmacKeys.push(candidate);
    }
  }

  output.set(input.topic, topic);
}

export function normalizeXmtpRegistration(input: unknown): NormalizedXmtpRegistration {
  const parsed = XmtpSubscriptionRequestSchema.parse(input);
  const topics = new Map<string, NormalizedXmtpTopic>();

  if ('version' in parsed) {
    for (const topic of parsed.xmtp.topics) {
      addTopic(topics, { topic: topic.topic, hmacKeys: topic.hmacKeys });
    }

    return {
      endpoint: parsed.subscription.endpoint,
      p256dh: parsed.subscription.keys.p256dh,
      auth: parsed.subscription.keys.auth,
      deliveryKind: 'web_push',
      expirationTime: parsed.subscription.expirationTime,
      inboxId: parsed.identity.inboxId,
      installationId: parsed.identity.installationId,
      address: parsed.identity.address,
      inboxHandle: parsed.notification.inboxHandle,
      preferences: parsed.preferences,
      topics: [...topics.values()],
    };
  }

  const subscription = parsed.subscription ?? {
    endpoint: parsed.endpoint as string,
    keys: parsed.keys as { p256dh: string; auth: string },
    expirationTime: parsed.expirationTime,
  };

  if (parsed.topics) {
    for (const topic of parsed.topics) {
      const hmacKeys = [...(topic.hmacKeys ?? [])];
      if (topic.hmacKey) hmacKeys.push({ epoch: 'legacy', key: topic.hmacKey });
      addTopic(topics, {
        topic: topic.topic,
        hmacKeys,
        algorithm: topic.algorithm,
        conversationId: topic.conversationId,
      });
    }
  }

  if (Array.isArray(parsed.hmacKeys)) {
    for (const topic of parsed.hmacKeys) {
      const hmacKeys = [...(topic.hmacKeys ?? [])];
      if (topic.hmacKey) hmacKeys.push({ epoch: 'legacy', key: topic.hmacKey });
      addTopic(topics, {
        topic: topic.topic,
        hmacKeys,
        algorithm: topic.algorithm,
        conversationId: topic.conversationId,
      });
    }
  } else if (parsed.hmacKeys) {
    for (const [topic, value] of Object.entries(parsed.hmacKeys)) {
      if (typeof value === 'string') {
        addTopic(topics, { topic, hmacKeys: [{ epoch: 'legacy', key: value }] });
      } else {
        addTopic(topics, {
          topic,
          hmacKeys: [{ epoch: 'legacy', key: value.hmacKey }],
          algorithm: value.algorithm,
          conversationId: value.conversationId,
        });
      }
    }
  }

  return {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    deliveryKind: 'web_push',
    expirationTime: subscription.expirationTime,
    inboxId: parsed.inboxId,
    installationId: parsed.installationId,
    address: parsed.address,
    inboxHandle: parsed.inboxHandle,
    preferences: parsed.preferences,
    topics: [...topics.values()],
  };
}

export function normalizeGenericXmtpRegistration(input: unknown): NormalizedXmtpRegistration {
  const parsed = GenericXmtpSubscriptionRequestSchema.parse(input);
  const topics = new Map<string, NormalizedXmtpTopic>();
  for (const topic of parsed.xmtp.topics) {
    addTopic(topics, { topic: topic.topic, hmacKeys: topic.hmacKeys });
  }

  return {
    endpoint: parsed.subscription.endpoint,
    p256dh: parsed.subscription.keys.p256dh,
    auth: parsed.subscription.keys.auth,
    deliveryKind: 'web_push',
    expirationTime: parsed.subscription.expirationTime,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
    address: parsed.identity.address,
    inboxHandle: parsed.notification.inboxHandle,
    preferences: parsed.preferences,
    topics: [...topics.values()],
  };
}

export function normalizePublicXmtpRegistration(input: unknown): NormalizedXmtpRegistration {
  const parsed = XmtpPublicSubscriptionRequestSchema.parse(input);
  const topics = new Map<string, NormalizedXmtpTopic>();
  for (const topic of parsed.xmtp.topics) {
    addTopic(topics, { topic: topic.topic, hmacKeys: topic.hmacKeys });
  }

  return {
    endpoint: parsed.subscription.endpoint,
    p256dh: parsed.subscription.keys.p256dh,
    auth: parsed.subscription.keys.auth,
    deliveryKind: 'web_push',
    expirationTime: parsed.subscription.expirationTime,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
    inboxHandle: parsed.notification.inboxHandle,
    preferences: parsed.preferences,
    topics: [...topics.values()],
  };
}

export function normalizeOwnedPublicXmtpRegistration(input: unknown): NormalizedXmtpRegistration {
  const parsed = PublicXmtpRegistrationSchema.parse(input);
  const topics = new Map<string, NormalizedXmtpTopic>();
  for (const topic of parsed.xmtp.topics) {
    addTopic(topics, { topic: topic.topic, hmacKeys: topic.hmacKeys });
  }
  const webPush = parsed.delivery.kind === 'web_push'
    ? parsed.delivery.subscription
    : undefined;
  const endpoint = parsed.delivery.kind === 'web_push'
    ? parsed.delivery.subscription.endpoint
    : parsed.delivery.url;

  return {
    endpoint,
    p256dh: webPush?.keys.p256dh ?? '',
    auth: webPush?.keys.auth ?? '',
    deliveryKind: parsed.delivery.kind,
    expirationTime: webPush?.expirationTime,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
    inboxHandle: parsed.notification.inboxHandle,
    preferences: parsed.preferences,
    topics: [...topics.values()],
  };
}

export function normalizeOwnedPublicXmtpDelete(input: unknown): {
  endpoint: string;
  inboxId: string;
  installationId: string;
} {
  const parsed = PublicXmtpDeleteRequestSchema.parse(input);
  return {
    endpoint: parsed.delivery.kind === 'web_push'
      ? parsed.delivery.endpoint
      : parsed.delivery.url,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
  };
}

export function normalizeXmtpDelete(input: unknown): { endpoint: string; inboxId: string; installationId: string } {
  const parsed = XmtpDeleteSubscriptionRequestSchema.parse(input);
  if ('version' in parsed) {
    return {
      endpoint: parsed.endpoint,
      inboxId: parsed.identity.inboxId,
      installationId: parsed.identity.installationId,
    };
  }
  return parsed;
}

export function normalizeGenericXmtpDelete(input: unknown): { endpoint: string; inboxId: string; installationId: string } {
  const parsed = GenericXmtpDeleteSubscriptionRequestSchema.parse(input);
  return {
    endpoint: parsed.endpoint,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
  };
}

export function normalizePublicXmtpDelete(input: unknown): { endpoint: string; inboxId: string; installationId: string } {
  const parsed = XmtpPublicDeleteSubscriptionRequestSchema.parse(input);
  return {
    endpoint: parsed.endpoint,
    inboxId: parsed.identity.inboxId,
    installationId: parsed.identity.installationId,
  };
}

export async function registerXmtpSubscription(
  store: XmtpRegistrationStore,
  input: unknown
): Promise<XmtpRegistrationResult> {
  return store.upsertRegistration(normalizeXmtpRegistration(input));
}

export async function unregisterXmtpSubscription(
  store: XmtpRegistrationStore,
  input: unknown
): Promise<XmtpUnsubscribeResult> {
  return store.disableRegistration(normalizeXmtpDelete(input));
}

export async function registerGenericXmtpSubscription(
  store: XmtpRegistrationStore,
  input: unknown
): Promise<XmtpRegistrationResult> {
  return store.upsertRegistration(normalizeGenericXmtpRegistration(input));
}

export async function unregisterGenericXmtpSubscription(
  store: XmtpRegistrationStore,
  input: unknown
): Promise<XmtpUnsubscribeResult> {
  return store.disableRegistration(normalizeGenericXmtpDelete(input));
}

export function buildXmtpPushPayload(input?: { inboxHandle?: string }): PushPayload {
  const payload: PushPayload = { type: 'xmtp.new_message' };
  if (input?.inboxHandle) payload.inboxHandle = input.inboxHandle;

  return payload;
}

export function parseXmtpDelivery(input: unknown) {
  return XmtpDeliveryRequestSchema.parse(input);
}

export async function relayXmtpDelivery(
  store: XmtpRelayStore,
  input: unknown
): Promise<{ matched: number; queued: number; deduplicated: number; skipped?: 'should_push_false' }> {
  const delivery = parseXmtpDelivery(input);
  const normalized = 'version' in delivery
    ? {
        idempotencyKey: delivery.idempotencyKey,
        installationId: delivery.installationId,
        deliveryToken: delivery.deliveryToken,
        topic: delivery.topic,
        shouldPush: delivery.shouldPush,
      }
    : {
        idempotencyKey: delivery.idempotency_key,
        installationId: delivery.installation.id,
        deliveryToken: delivery.installation.delivery_mechanism.token,
        topic: delivery.subscription.topic,
        shouldPush: delivery.message_context.should_push,
      };

  if (normalized.shouldPush === false) {
    return { matched: 0, queued: 0, deduplicated: 0, skipped: 'should_push_false' };
  }

  const matches = await store.findDeliveryMatches(
    normalized.installationId,
    normalized.topic,
    normalized.deliveryToken
  );

  let queued = 0;
  let deduplicated = 0;
  for (const match of matches) {
    const didQueue = await store.enqueueXmtpPush(
      match,
      buildXmtpPushPayload({
        inboxHandle: match.inboxHandle,
      }),
      normalized.idempotencyKey
    );
    if (didQueue) queued += 1;
    else deduplicated += 1;
  }

  return { matched: matches.length, queued, deduplicated };
}
