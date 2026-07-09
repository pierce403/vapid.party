import { z } from 'zod';
import {
  XmtpDeleteSubscriptionRequestSchema,
  XmtpEnvelopeSchema,
  XmtpSubscriptionRequestSchema,
} from './schemas';
import { timingSafeEqualString } from './encoding';
import type { PushPayload, XmtpTopicMatch } from './types';

const UNSAFE_XMTP_KEYS = new Set([
  'body',
  'message',
  'messageText',
  'plaintext',
  'plaintextBody',
  'preview',
  'plaintextPreview',
  'sender',
  'senderName',
  'displayName',
  'attachment',
  'attachmentUrl',
  'attachments',
  'decryptedContent',
]);

export interface NormalizedXmtpTopic {
  topic: string;
  hmacKey: string;
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
  findTopicMatches(topic: string, hmacKey: string): Promise<XmtpTopicMatch[]>;
  enqueueXmtpPush(match: XmtpTopicMatch, payload: PushPayload): Promise<void>;
}

export function normalizeXmtpRegistration(input: unknown): NormalizedXmtpRegistration {
  const parsed = XmtpSubscriptionRequestSchema.parse(input);
  const subscription = parsed.subscription ?? {
    endpoint: parsed.endpoint as string,
    keys: parsed.keys as { p256dh: string; auth: string },
    expirationTime: parsed.expirationTime,
  };

  const topics: NormalizedXmtpTopic[] = [];

  if (parsed.topics) {
    topics.push(...parsed.topics.map((topic) => ({
      topic: topic.topic,
      hmacKey: topic.hmacKey,
      algorithm: topic.algorithm,
      conversationId: topic.conversationId,
    })));
  }

  if (Array.isArray(parsed.hmacKeys)) {
    topics.push(...parsed.hmacKeys.map((topic) => ({
      topic: topic.topic,
      hmacKey: topic.hmacKey,
      algorithm: topic.algorithm,
      conversationId: topic.conversationId,
    })));
  } else if (parsed.hmacKeys) {
    for (const [topic, value] of Object.entries(parsed.hmacKeys)) {
      if (typeof value === 'string') {
        topics.push({ topic, hmacKey: value, algorithm: 'hmac-sha256' });
      } else {
        topics.push({
          topic,
          hmacKey: value.hmacKey,
          algorithm: value.algorithm ?? 'hmac-sha256',
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
    preferences: parsed.preferences,
    topics,
  };
}

export function normalizeXmtpDelete(input: unknown): { endpoint: string; inboxId: string; installationId: string } {
  return XmtpDeleteSubscriptionRequestSchema.parse(input);
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

export function buildXmtpPushPayload(input?: { conversationId?: string }): PushPayload {
  const payload: PushPayload = {
    type: 'xmtp.new_message',
    title: 'Converge',
    body: 'New encrypted message',
    url: '/',
  };

  if (input?.conversationId) {
    payload.conversationId = input.conversationId;
  }

  return payload;
}

export function containsUnsafeXmtpKey(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.some(containsUnsafeXmtpKey);

  return Object.entries(input as Record<string, unknown>).some(([key, value]) => (
    UNSAFE_XMTP_KEYS.has(key) || containsUnsafeXmtpKey(value)
  ));
}

export function parseXmtpEnvelope(input: unknown): z.infer<typeof XmtpEnvelopeSchema> {
  if (containsUnsafeXmtpKey(input)) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'XMTP envelope ingestion must not include plaintext-like content fields',
    }]);
  }

  return XmtpEnvelopeSchema.parse(input);
}

export function matchesTopicHmac(
  envelope: { topic: string; hmacKey: string },
  topic: { topic: string; hmacKey: string }
): boolean {
  return envelope.topic === topic.topic && timingSafeEqualString(envelope.hmacKey, topic.hmacKey);
}

export async function relayXmtpEnvelope(
  store: XmtpRelayStore,
  input: unknown
): Promise<{ matched: number; queued: number }> {
  const envelope = parseXmtpEnvelope(input);
  const matches = await store.findTopicMatches(envelope.topic, envelope.hmacKey);

  let queued = 0;
  for (const match of matches) {
    if (!matchesTopicHmac(envelope, { topic: envelope.topic, hmacKey: envelope.hmacKey })) {
      continue;
    }

    await store.enqueueXmtpPush(
      match,
      buildXmtpPushPayload({ conversationId: envelope.conversationId ?? match.conversationId })
    );
    queued += 1;
  }

  return { matched: matches.length, queued };
}
