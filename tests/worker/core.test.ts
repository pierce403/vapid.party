import { describe, expect, it } from 'vitest';
import {
  buildXmtpPushPayload,
  isAllowedPublicWebPushEndpoint,
  normalizeXmtpDelete,
  normalizeXmtpRegistration,
  normalizePublicXmtpDelete,
  normalizePublicXmtpRegistration,
  parseXmtpDelivery,
  registerXmtpSubscription,
  relayXmtpDelivery,
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
const inboxId = '11'.repeat(32);
const secondInboxId = '22'.repeat(32);
const installationId = '33'.repeat(32);
const secondInstallationId = '44'.repeat(32);
const groupTopic = `/xmtp/mls/1/g-${'ab'.repeat(16)}/proto`;
const welcomeTopic = `/xmtp/mls/1/w-${installationId}/proto`;

function nestedRegistration() {
  return {
    version: 1,
    app: { id: 'converge.cv', origin: 'https://converge.cv' },
    identity: {
      inboxId,
      installationId,
      address: '0x1111111111111111111111111111111111111111',
    },
    subscription: {
      endpoint: 'https://push.example/subscription/1',
      expirationTime: null,
      keys: { p256dh, auth },
    },
    xmtp: {
      env: 'production',
      topics: [
        {
          topic: groupTopic,
          hmacKeys: [
            { epoch: '7', key: hmacKey },
            { epoch: '8', key: hmacKey },
          ],
        },
        { topic: welcomeTopic, hmacKeys: [] },
      ],
      topicSource: 'conversations.hmacKeys',
    },
    notification: { inboxHandle: 'opaque_inbox_1' },
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    userAgent: 'Converge test',
    registeredAt: '2026-07-12T00:00:00.000Z',
  } as const;
}

function officialDelivery(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: 'delivery-1',
    message: {
      content_topic: groupTopic,
      message: 'AQIDBA==',
    },
    message_context: {
      message_type: 'v3-conversation',
      should_push: true,
    },
    installation: {
      id: installationId,
      delivery_mechanism: { kind: 'custom', token: 'opaque' },
      payload_format: 'v3',
    },
    subscription: {
      created_at: '2026-07-12T00:00:00.000Z',
      topic: groupTopic,
      is_silent: false,
    },
    payload_format: 'v3',
    ...overrides,
  };
}

class MemoryRegistrationStore implements XmtpRegistrationStore {
  physicalEndpoints = new Set<string>();
  registrations = new Map<string, {
    input: NormalizedXmtpRegistration;
    subscriptionId: string;
    identityId: string;
    active: boolean;
  }>();

  async upsertRegistration(input: NormalizedXmtpRegistration) {
    this.physicalEndpoints.add(input.endpoint);
    const key = `${input.endpoint}|${input.inboxId}|${input.installationId}`;
    const current = this.registrations.get(key);
    const subscriptionId = current?.subscriptionId ?? `sub-${this.physicalEndpoints.size}`;
    const identityId = current?.identityId ?? `identity-${this.registrations.size + 1}`;

    this.registrations.set(key, { input, subscriptionId, identityId, active: true });

    return {
      subscriptionId,
      identityId,
      topicsRegistered: input.topics.length,
      hmacKeysRegistered: input.topics.reduce((count, topic) => count + topic.hmacKeys.length, 0),
      created: !current,
      diagnostics: {
        receipt: 'A'.repeat(43),
        statusPath: '/api/xmtp/status' as const,
        testPath: '/api/xmtp/status/test' as const,
      },
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
  claims = new Set<string>();

  constructor(private readonly matches: XmtpTopicMatch[]) {}

  async findDeliveryMatches(installationId: string, topic: string) {
    return this.matches.filter(
      (match) => match.installationId === installationId && topic === groupTopic
    );
  }

  async enqueueXmtpPush(match: XmtpTopicMatch, payload: PushPayload, idempotencyKey: string) {
    const claim = `${match.installationId}|${match.topicId}|${match.subscriptionId}|${idempotencyKey}`;
    if (this.claims.has(claim)) return false;
    this.claims.add(claim);
    this.queued.push({ match, payload });
    return true;
  }
}

describe('Converge XMTP registration', () => {
  it('accepts only known HTTPS browser Web Push provider endpoint shapes', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/opaque-token',
      'https://fcm.googleapis.com/wp/opaque-token',
      'https://updates.push.services.mozilla.com/wpush/v2/opaque-token',
      'https://web.push.apple.com/opaque-token',
      'https://cloud.notify.windows.com/?token=opaque-token',
      'https://wns2-by3p.notify.windows.com/w/?token=opaque-token',
    ]) expect(isAllowedPublicWebPushEndpoint(endpoint)).toBe(true);

    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/token',
      'https://fcm.googleapis.com:444/fcm/send/token',
      'https://user:password@fcm.googleapis.com/fcm/send/token',
      'https://fcm.googleapis.com.evil.example/fcm/send/token',
      'https://updates.push.services.mozilla.com/other/token',
      'https://push.apple.com/token',
      'https://cloud.notify.windows.com/no-token',
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://localhost/push',
      'https://example.com/push',
    ]) expect(isAllowedPublicWebPushEndpoint(endpoint)).toBe(false);
  });

  it('accepts the nested Converge payload, multiple epochs, and a welcome topic without HMAC', () => {
    const normalized = normalizeXmtpRegistration(nestedRegistration());

    expect(normalized).toMatchObject({
      endpoint: 'https://push.example/subscription/1',
      inboxId,
      installationId,
      inboxHandle: 'opaque_inbox_1',
    });
    expect(normalized.topics).toEqual([
      {
        topic: groupTopic,
        algorithm: 'hmac-sha256',
        hmacKeys: [
          { epoch: '7', key: hmacKey },
          { epoch: '8', key: hmacKey },
        ],
        conversationId: undefined,
      },
      {
        topic: welcomeTopic,
        algorithm: 'hmac-sha256',
        hmacKeys: [],
        conversationId: undefined,
      },
    ]);
  });

  it('retains the legacy flattened registration contract', () => {
    const normalized = normalizeXmtpRegistration({
      endpoint: 'https://push.example/subscription/1',
      keys: { p256dh, auth },
      inboxId: 'inbox-1',
      installationId: 'install-1',
      hmacKeys: { '/xmtp/topic': hmacKey },
      preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    });

    expect(normalized.topics).toEqual([{
      topic: '/xmtp/topic',
      algorithm: 'hmac-sha256',
      hmacKeys: [{ epoch: 'legacy', key: hmacKey }],
      conversationId: undefined,
    }]);
  });

  it('keeps the unauthenticated public compatibility contract strict', () => {
    const nested = nestedRegistration();
    expect(normalizePublicXmtpRegistration(nested)).toMatchObject({
      inboxId,
      installationId,
    });
    expect(() => normalizePublicXmtpRegistration({
      endpoint: nested.subscription.endpoint,
      keys: nested.subscription.keys,
      inboxId,
      installationId,
      hmacKeys: { [groupTopic]: hmacKey },
      preferences: nested.preferences,
    })).toThrow();
    expect(() => normalizePublicXmtpDelete({
      endpoint: nested.subscription.endpoint,
      inboxId,
      installationId,
    })).toThrow();
  });

  it('bounds public registration key size and aggregate D1 row cost', () => {
    const nested = nestedRegistration();
    expect(() => normalizePublicXmtpRegistration({
      ...nested,
      xmtp: {
        ...nested.xmtp,
        topics: [{
          topic: groupTopic,
          hmacKeys: [{ epoch: '7', key: 'A'.repeat(1025) }],
        }],
      },
    })).toThrow();

    const topics = Array.from({ length: 300 }, (_, index) => ({
      topic: `/xmtp/mls/1/g-${index.toString(16).padStart(32, '0')}/proto`,
      hmacKeys: [
        { epoch: '7', key: hmacKey },
        { epoch: '8', key: hmacKey },
      ],
    }));
    expect(() => normalizePublicXmtpRegistration({
      ...nested,
      xmtp: { ...nested.xmtp, topics },
    })).toThrow(/row count must not exceed 800/);

    expect(() => normalizePublicXmtpRegistration({
      ...nested,
      subscription: {
        ...nested.subscription,
        endpoint: `https://fcm.googleapis.com/fcm/send/${'a'.repeat(4097)}`,
      },
    })).toThrow();

    expect(() => normalizePublicXmtpRegistration({
      ...nested,
      subscription: {
        ...nested.subscription,
        keys: { ...nested.subscription.keys, auth: 'A'.repeat(23) },
      },
    })).toThrow(/exactly 16 bytes/);
  });

  it('accepts only uint32 HMAC epochs on the public contract', () => {
    const nested = nestedRegistration();
    const withEpoch = (epoch: string | number) => ({
      ...nested,
      xmtp: {
        ...nested.xmtp,
        topics: [{
          topic: groupTopic,
          hmacKeys: [{ epoch, key: hmacKey }],
        }],
      },
    });
    expect(normalizePublicXmtpRegistration(withEpoch('4294967295')).topics[0].hmacKeys[0].epoch)
      .toBe('4294967295');
    expect(() => normalizePublicXmtpRegistration(withEpoch('4294967296'))).toThrow(/uint32/);
    expect(() => normalizePublicXmtpRegistration(withEpoch(4294967296))).toThrow();
    expect(() => normalizePublicXmtpRegistration(withEpoch('0007'))).toThrow(/canonical uint32/);
  });

  it('rejects non-opaque handles and plaintext preview preferences', () => {
    expect(() => normalizeXmtpRegistration({
      ...nestedRegistration(),
      notification: { inboxHandle: 'Orange Orca' },
    })).toThrow();

    expect(() => normalizeXmtpRegistration({
      ...nestedRegistration(),
      preferences: { minimalPayloadOnly: true, plaintextPreview: true },
    })).toThrow();
  });

  it('enforces canonical group/welcome topic HMAC rules for nested clients', () => {
    const base = nestedRegistration();
    expect(() => normalizeXmtpRegistration({
      ...base,
      xmtp: { ...base.xmtp, topics: [{ topic: groupTopic, hmacKeys: [] }] },
    })).toThrow(/require at least one HMAC/);

    expect(() => normalizeXmtpRegistration({
      ...base,
      xmtp: {
        ...base.xmtp,
        topics: [{
          topic: welcomeTopic,
          hmacKeys: [{ epoch: '7', key: hmacKey }],
        }],
      },
    })).toThrow(/must not include HMAC/);

    expect(() => normalizeXmtpRegistration({
      ...base,
      xmtp: {
        ...base.xmtp,
        topics: [{ topic: 'abcd', hmacKeys: [{ epoch: '7', key: hmacKey }] }],
      },
    })).toThrow(/canonical lowercase XMTP/);

    expect(() => normalizeXmtpRegistration({
      ...base,
      xmtp: {
        ...base.xmtp,
        topics: [{ topic: '/xmtp/mls/1/g-abcd/proto', hmacKeys: [{ epoch: '7', key: hmacKey }] }],
      },
    })).toThrow(/canonical lowercase XMTP/);

    expect(() => normalizeXmtpRegistration({
      ...base,
      xmtp: {
        ...base.xmtp,
        topics: [{
          topic: `/xmtp/mls/1/g-${'ab'.repeat(32)}/proto`,
          hmacKeys: [{ epoch: '7', key: hmacKey }],
        }],
      },
    })).toThrow(/canonical lowercase XMTP/);
  });

  it('is idempotent for endpoint plus inboxId plus installationId', async () => {
    const store = new MemoryRegistrationStore();
    const body = nestedRegistration();
    const first = await registerXmtpSubscription(store, body);
    const second = await registerXmtpSubscription(store, body);

    expect(first).toMatchObject({ created: true, topicsRegistered: 2, hmacKeysRegistered: 2 });
    expect(second.created).toBe(false);
    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(second.identityId).toBe(first.identityId);
  });

  it('disables only one logical registration sharing a physical endpoint', async () => {
    const store = new MemoryRegistrationStore();
    const first = nestedRegistration();
    const second = {
      ...nestedRegistration(),
      identity: { ...nestedRegistration().identity, inboxId: secondInboxId, installationId: secondInstallationId },
      notification: { inboxHandle: 'opaque_inbox_2' },
    };
    await registerXmtpSubscription(store, first);
    await registerXmtpSubscription(store, second);

    await unregisterXmtpSubscription(store, {
      endpoint: first.subscription.endpoint,
      inboxId: first.identity.inboxId,
      installationId: first.identity.installationId,
    });

    expect(store.physicalEndpoints.has(first.subscription.endpoint)).toBe(true);
    expect(store.registrations.get(`${first.subscription.endpoint}|${inboxId}|${installationId}`)?.active).toBe(false);
    expect(store.registrations.get(`${first.subscription.endpoint}|${secondInboxId}|${secondInstallationId}`)?.active).toBe(true);
  });

  it('normalizes the exact nested Converge delete payload', () => {
    expect(normalizeXmtpDelete({
      version: 1,
      app: { id: 'converge.cv', origin: 'https://converge.cv' },
      endpoint: 'https://push.example/subscription/1',
      identity: {
        inboxId,
        installationId,
        address: '0x1111111111111111111111111111111111111111',
      },
      deletedAt: '2026-07-12T00:00:00.000Z',
    })).toEqual({
      endpoint: 'https://push.example/subscription/1',
      inboxId,
      installationId,
    });
  });
});

describe('official XMTP HTTP delivery', () => {
  const match: XmtpTopicMatch = {
    topicId: 'topic-1',
    xmtpSubscriptionId: 'logical-1',
    subscriptionId: 'sub-1',
    appId: 'converge',
    installationId,
    endpoint: 'https://push.example/subscription/1',
    p256dh,
    auth,
    deliveryKind: 'web_push',
    conversationId: 'safe-conversation',
    inboxHandle: 'opaque_inbox_1',
  };

  it('matches installation/topic and queues only generic opaque metadata', async () => {
    const store = new MemoryRelayStore([match]);
    const result = await relayXmtpDelivery(store, officialDelivery());

    expect(result).toEqual({ matched: 1, queued: 1, deduplicated: 0 });
    expect(store.queued[0].payload).toEqual({
      type: 'xmtp.new_message',
      inboxHandle: 'opaque_inbox_1',
    });
    expect(JSON.stringify(store.queued[0].payload)).not.toContain('AQIDBA');
  });

  it('deduplicates retries by installation, topic, subscription, and idempotency key', async () => {
    const store = new MemoryRelayStore([match]);
    expect(await relayXmtpDelivery(store, officialDelivery())).toMatchObject({ queued: 1 });
    expect(await relayXmtpDelivery(store, officialDelivery())).toEqual({
      matched: 1,
      queued: 0,
      deduplicated: 1,
    });
    expect(store.queued).toHaveLength(1);
  });

  it('honors should_push=false without looking up or queueing a subscription', async () => {
    const store = new MemoryRelayStore([match]);
    const delivery = officialDelivery({
      message_context: { message_type: 'v3-conversation', should_push: false },
    });

    expect(await relayXmtpDelivery(store, delivery)).toEqual({
      matched: 0,
      queued: 0,
      deduplicated: 0,
      skipped: 'should_push_false',
    });
    expect(store.queued).toHaveLength(0);
  });

  it('rejects conflicting topics and plaintext-like extension fields', () => {
    expect(() => parseXmtpDelivery(officialDelivery({
      message: { content_topic: '/wrong/topic', message: 'AQIDBA==' },
    }))).toThrow(/must match/);

    expect(() => parseXmtpDelivery({ ...officialDelivery(), body: 'plaintext' })).toThrow();
  });

  it('builds the generic queue payload without an inbox handle when legacy data lacks one', () => {
    expect(buildXmtpPushPayload()).toEqual({ type: 'xmtp.new_message' });
  });
});
