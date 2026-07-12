import {
  XmtpDeleteSubscriptionRequestSchema,
  XmtpDeliveryRequestSchema,
  XmtpSubscriptionRequestSchema,
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
}

export interface XmtpUnsubscribeResult {
  disabled: boolean;
}

export interface XmtpRegistrationStore {
  upsertRegistration(input: NormalizedXmtpRegistration): Promise<XmtpRegistrationResult>;
  disableRegistration(input: { endpoint: string; inboxId: string; installationId: string }): Promise<XmtpUnsubscribeResult>;
}

export interface XmtpRelayStore {
  findDeliveryMatches(installationId: string, topic: string): Promise<XmtpTopicMatch[]>;
  enqueueXmtpPush(
    match: XmtpTopicMatch,
    payload: PushPayload,
    idempotencyKey: string
  ): Promise<boolean>;
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
    expirationTime: subscription.expirationTime,
    inboxId: parsed.inboxId,
    installationId: parsed.installationId,
    address: parsed.address,
    inboxHandle: parsed.inboxHandle,
    preferences: parsed.preferences,
    topics: [...topics.values()],
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
  if (delivery.message_context.should_push === false) {
    return { matched: 0, queued: 0, deduplicated: 0, skipped: 'should_push_false' };
  }

  const matches = await store.findDeliveryMatches(
    delivery.installation.id,
    delivery.subscription.topic
  );

  let queued = 0;
  let deduplicated = 0;
  for (const match of matches) {
    const didQueue = await store.enqueueXmtpPush(
      match,
      buildXmtpPushPayload({
        inboxHandle: match.inboxHandle,
      }),
      delivery.idempotency_key
    );
    if (didQueue) queued += 1;
    else deduplicated += 1;
  }

  return { matched: matches.length, queued, deduplicated };
}
