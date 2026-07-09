import { describe, expect, it } from 'vitest';
import {
  buildXmtpPushPayload,
  normalizeXmtpRegistration,
  parseXmtpEnvelope,
  registerXmtpSubscription,
  relayXmtpEnvelope,
  unregisterXmtpSubscription,
  type NormalizedXmtpRegistration,
  type XmtpRegistrationStore,
  type XmtpRelayStore,
} from '../../src/worker/core';
import { normalizeBase64Url } from '../../src/worker/encoding';
import type { PushPayload, XmtpTopicMatch } from '../../src/worker/types';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);
const hmacKey = normalizeBase64Url('B'.repeat(43)) as string;

class MemoryRegistrationStore implements XmtpRegistrationStore {
  registrations = new Map<string, { input: NormalizedXmtpRegistration; subscriptionId: string; identityId: string; active: boolean }>();

  async upsertRegistration(input: NormalizedXmtpRegistration) {
    const key = `${input.endpoint}|${input.inboxId}|${input.installationId}`;
    const current = this.registrations.get(key);
    const subscriptionId = current?.subscriptionId ?? `sub-${this.registrations.size + 1}`;
    const identityId = current?.identityId ?? `identity-${this.registrations.size + 1}`;

    this.registrations.set(key, { input, subscriptionId, identityId, active: true });

    return {
      subscriptionId,
      identityId,
      topicsRegistered: input.topics.length,
      created: !current,
    };
  }

  async disableRegistration(input: { endpoint: string; inboxId: string; installationId: string }) {
    const key = `${input.endpoint}|${input.inboxId}|${input.installationId}`;
    const current = this.registrations.get(key);
    if (!current) return { disabled: false };
    current.active = false;
    return { disabled: true };
  }
}

class MemoryRelayStore implements XmtpRelayStore {
  queued: Array<{ match: XmtpTopicMatch; payload: PushPayload }> = [];

  constructor(private readonly matches: XmtpTopicMatch[]) {}

  async findTopicMatches(topic: string, key: string) {
    return this.matches.filter((match) => match.conversationId === 'safe-conversation' && topic === '/xmtp/topic' && key === hmacKey);
  }

  async enqueueXmtpPush(match: XmtpTopicMatch, payload: PushPayload) {
    this.queued.push({ match, payload });
  }
}

describe('Converge XMTP registration', () => {
  it('validates subscription payloads and requires privacy-preserving preferences', () => {
    const normalized = normalizeXmtpRegistration({
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh, auth },
      inboxId: 'inbox-1',
      installationId: 'install-1',
      hmacKeys: {
        '/xmtp/topic': hmacKey,
      },
      preferences: {
        minimalPayloadOnly: true,
        plaintextPreview: false,
      },
    });

    expect(normalized.endpoint).toBe('https://push.example/subscription/1');
    expect(normalized.topics).toHaveLength(1);
    expect(normalized.preferences.plaintextPreview).toBe(false);
  });

  it('rejects plaintext preview preferences', () => {
    expect(() => normalizeXmtpRegistration({
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh, auth },
      inboxId: 'inbox-1',
      installationId: 'install-1',
      hmacKeys: {
        '/xmtp/topic': hmacKey,
      },
      preferences: {
        minimalPayloadOnly: true,
        plaintextPreview: true,
      },
    })).toThrow();
  });

  it('is idempotent for endpoint plus inboxId plus installationId', async () => {
    const store = new MemoryRegistrationStore();
    const body = {
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh, auth },
      inboxId: 'inbox-1',
      installationId: 'install-1',
      hmacKeys: {
        '/xmtp/topic': hmacKey,
      },
      preferences: {
        minimalPayloadOnly: true,
        plaintextPreview: false,
      },
    };

    const first = await registerXmtpSubscription(store, body);
    const second = await registerXmtpSubscription(store, body);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(second.identityId).toBe(first.identityId);
  });

  it('disables the matching registration on unsubscribe', async () => {
    const store = new MemoryRegistrationStore();
    await registerXmtpSubscription(store, {
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh, auth },
      inboxId: 'inbox-1',
      installationId: 'install-1',
      hmacKeys: {
        '/xmtp/topic': hmacKey,
      },
      preferences: {
        minimalPayloadOnly: true,
        plaintextPreview: false,
      },
    });

    const result = await unregisterXmtpSubscription(store, {
      endpoint: 'https://push.example/subscription/1',
      inboxId: 'inbox-1',
      installationId: 'install-1',
    });

    expect(result.disabled).toBe(true);
  });
});

describe('XMTP relay privacy', () => {
  it('matches topic/HMAC and enqueues only generic payload metadata', async () => {
    const store = new MemoryRelayStore([
      {
        topicId: 'topic-1',
        subscriptionId: 'sub-1',
        appId: 'converge',
        endpoint: 'https://push.example/subscription/1',
        p256dh,
        auth,
        conversationId: 'safe-conversation',
      },
    ]);

    const result = await relayXmtpEnvelope(store, {
      topic: '/xmtp/topic',
      hmacKey,
    });

    expect(result).toEqual({ matched: 1, queued: 1 });
    expect(store.queued[0].payload).toEqual({
      type: 'xmtp.new_message',
      title: 'Converge',
      body: 'New encrypted message',
      url: '/',
      conversationId: 'safe-conversation',
    });
    expect(JSON.stringify(store.queued[0].payload)).not.toMatch(/plaintext|sender|attachment|preview|message text/i);
  });

  it('rejects plaintext-like envelope fields', () => {
    expect(() => parseXmtpEnvelope({
      topic: '/xmtp/topic',
      hmacKey,
      body: 'hello',
    })).toThrow(/plaintext-like/);
  });

  it('builds the expected generic queue payload shape', () => {
    expect(buildXmtpPushPayload()).toEqual({
      type: 'xmtp.new_message',
      title: 'Converge',
      body: 'New encrypted message',
      url: '/',
    });
  });
});
