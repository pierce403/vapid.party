import { z } from 'zod';
import { base64UrlToBytes, normalizeBase64Url } from './encoding';

const Base64OrBase64UrlString = z.string().min(1).max(1024).transform((value, ctx) => {
  const normalized = normalizeBase64Url(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid base64/base64url string',
    });
    return z.NEVER;
  }
  return normalized;
});

const P256dhKey = Base64OrBase64UrlString.superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'keys.p256dh must be a 65-byte uncompressed P-256 public key',
    });
  }
});

const AuthKey = Base64OrBase64UrlString.superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length !== 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'keys.auth must decode to exactly 16 bytes',
    });
  }
});

const XmtpHmacKeyMaterial = Base64OrBase64UrlString.superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length < 1 || bytes.length > 256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'XMTP HMAC keys must decode to between 1 and 256 bytes',
    });
  }
});

const PushExpirationTime = z.number()
  .finite()
  .int()
  .min(0)
  .max(8_640_000_000_000_000)
  .nullable()
  .optional()
  .superRefine((value, ctx) => {
    if (value !== null && value !== undefined && value <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expirationTime must be in the future or null',
      });
    }
  });

const AbsoluteUrl = z.string().url();
const WebPushEndpoint = z.string().url().max(4096);
const AbsoluteUrlOrPath = z.union([
  AbsoluteUrl,
  z.string().refine((value) => value.startsWith('/'), {
    message: 'Must be an absolute URL or a path starting with /',
  }),
]);

export const RegisterAppSchema = z.object({
  name: z.string().min(1).max(255),
  metadata: z.object({
    description: z.string().max(1000).optional(),
    website: z.string().url().optional(),
    iconUrl: z.string().url().optional(),
  }).strict().optional(),
}).strict();

const AppDomainSchema = z.string().trim().min(1).max(253);

export const PublicAppCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(500).optional(),
  domain: AppDomainSchema.optional(),
  leaderboardOptIn: z.boolean().optional().default(false),
}).strict();

export const PublicAppUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(500).optional(),
  domain: AppDomainSchema.nullable().optional(),
  leaderboardOptIn: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one app field to update',
});

export const UpdateAppSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  metadata: z.object({
    description: z.string().max(1000).optional(),
    website: z.string().url().optional(),
    iconUrl: z.string().url().optional(),
  }).strict().optional(),
  rateLimit: z.object({
    maxNotificationsPerMinute: z.number().int().min(1).max(100000),
    maxNotificationsPerDay: z.number().int().min(1).max(10000000),
    maxSubscriptions: z.number().int().min(1).max(10000000),
  }).strict().optional(),
}).strict();

export const PushSubscriptionSchema = z.object({
  endpoint: WebPushEndpoint,
  keys: z.object({
    p256dh: P256dhKey,
    auth: AuthKey,
  }).strict(),
  expirationTime: PushExpirationTime,
}).strict();

export const SubscribeSchema = PushSubscriptionSchema.extend({
  userId: z.string().max(255).optional(),
  channelId: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

// Anonymous enrollment cannot choose trusted routing labels. The app can map
// the returned subscription id to its own authenticated user and then target
// that id from its server.
export const PublicSubscribeSchema = PushSubscriptionSchema;

export const PublicSubscriptionDeleteSchema = z.object({
  endpoint: WebPushEndpoint,
}).strict();

export const SendNotificationSchema = z.object({
  payload: z.object({
    title: z.string().min(1).max(255),
    body: z.string().max(1000).optional(),
    icon: AbsoluteUrlOrPath.optional(),
    badge: AbsoluteUrlOrPath.optional(),
    image: AbsoluteUrlOrPath.optional(),
    url: AbsoluteUrlOrPath.optional(),
    data: z.record(z.unknown()).optional(),
    actions: z.array(z.object({
      action: z.string().min(1).max(64),
      title: z.string().min(1).max(128),
      icon: AbsoluteUrlOrPath.optional(),
    }).strict()).max(4).optional(),
    tag: z.string().max(128).optional(),
    requireInteraction: z.boolean().optional(),
    silent: z.boolean().optional(),
  }).strict(),
  userId: z.string().max(255).optional(),
  channelId: z.string().max(255).optional(),
  subscriptionIds: z.array(z.string().max(128)).max(100).optional(),
}).strict();

export const XmtpPreferencesSchema = z.object({
  minimalPayloadOnly: z.literal(true),
  plaintextPreview: z.literal(false),
}).strict();

const XmtpEpochSchema = z.union([
  z.string()
    .regex(/^(?:0|[1-9]\d{0,9})$/, 'epoch must be a canonical uint32 string')
    .refine((value) => Number(value) <= 0xffff_ffff, 'epoch must not exceed uint32'),
  z.number().int().min(0).max(0xffff_ffff),
]).transform((value) => String(value));

export const XmtpHmacKeySchema = z.object({
  epoch: XmtpEpochSchema,
  key: XmtpHmacKeyMaterial,
}).strict();

export const XmtpTopicSchema = z.object({
  topic: z.string().min(1).max(512),
  hmacKey: XmtpHmacKeyMaterial.optional(),
  hmacKeys: z.array(XmtpHmacKeySchema).max(16).optional(),
  algorithm: z.enum(['hmac-sha256', 'sha256']).default('hmac-sha256'),
  conversationId: z.string().min(1).max(255).optional(),
}).strict();

const XmtpHmacKeysSchema = z.union([
  z.array(XmtpTopicSchema),
  z.record(z.union([
    XmtpHmacKeyMaterial,
    z.object({
      hmacKey: XmtpHmacKeyMaterial,
      algorithm: z.enum(['hmac-sha256', 'sha256']).default('hmac-sha256').optional(),
      conversationId: z.string().min(1).max(255).optional(),
    }).strict(),
  ])),
]);

const XmtpLegacySubscriptionRequestSchema = z.object({
  subscription: PushSubscriptionSchema.optional(),
  endpoint: z.string().url().optional(),
  keys: z.object({
    p256dh: P256dhKey,
    auth: AuthKey,
  }).strict().optional(),
  expirationTime: PushExpirationTime,
  inboxId: z.string().min(1).max(255),
  installationId: z.string().min(1).max(255),
  address: z.string().min(1).max(255).optional(),
  inboxHandle: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  topics: z.array(XmtpTopicSchema).min(1).max(2000).optional(),
  hmacKeys: XmtpHmacKeysSchema.optional(),
  preferences: XmtpPreferencesSchema,
}).strict().superRefine((value, ctx) => {
  if (!value.subscription && (!value.endpoint || !value.keys)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subscription'],
      message: 'Provide either subscription or endpoint plus keys',
    });
  }

  if (!value.topics && !value.hmacKeys) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['topics'],
      message: 'Provide at least one XMTP topic/HMAC registration',
    });
  }
});

const OpaqueInboxHandleSchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'inboxHandle must be an opaque base64url-style identifier');

const XmtpHex32Schema = z.string()
  .regex(/^[0-9a-f]{64}$/, 'value must be a canonical lowercase 32-byte hexadecimal identifier');

const CanonicalXmtpTopicSchema = z.string()
  .max(512)
  .regex(
    /^\/xmtp\/mls\/1\/(?:g-[0-9a-f]{32}|w-[0-9a-f]{64})\/proto$/,
    'topic must be a canonical lowercase XMTP group or welcome topic'
  );

const XmtpNestedTopicSchema = z.object({
  topic: CanonicalXmtpTopicSchema,
  hmacKeys: z.array(XmtpHmacKeySchema).max(16),
}).strict().superRefine((value, ctx) => {
  const isWelcome = value.topic.startsWith('/xmtp/mls/1/w-');
  if (isWelcome && value.hmacKeys.length !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hmacKeys'],
      message: 'welcome topics must not include HMAC keys',
    });
  }
  if (!isWelcome && value.hmacKeys.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hmacKeys'],
      message: 'group topics require at least one HMAC key',
    });
  }
});

const PublicXmtpWebPushDeliverySchema = z.object({
  kind: z.literal('web_push'),
  subscription: PushSubscriptionSchema,
}).strict();

const PublicXmtpCallbackDeliverySchema = z.object({
  kind: z.literal('https_callback'),
  url: z.string().url().max(2048),
}).strict();

export const PublicXmtpDeliverySchema = z.discriminatedUnion('kind', [
  PublicXmtpWebPushDeliverySchema,
  PublicXmtpCallbackDeliverySchema,
]);

export const PublicXmtpRegistrationSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    inboxId: XmtpHex32Schema,
    installationId: XmtpHex32Schema,
  }).strict(),
  delivery: PublicXmtpDeliverySchema,
  xmtp: z.object({
    env: z.literal('production'),
    topics: z.array(XmtpNestedTopicSchema).min(1).max(400),
    topicSource: z.literal('conversations.hmacKeys'),
  }).strict(),
  notification: z.object({
    inboxHandle: OpaqueInboxHandleSchema,
  }).strict(),
  preferences: XmtpPreferencesSchema,
  registeredAt: z.string().datetime({ offset: true }),
}).strict().superRefine(validateXmtpRegistrationCost);

export const PublicXmtpEnrollmentTicketRequestSchema = z.object({
  registration: PublicXmtpRegistrationSchema,
}).strict();

const Ed25519PublicKeySchema = z.string().max(128).superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'proof.publicKey must be a 32-byte base64url Ed25519 public key',
    });
  }
});

const Ed25519SignatureSchema = z.string().max(256).superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length !== 64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'proof.signature must be a 64-byte base64url Ed25519 signature',
    });
  }
});

export const PublicXmtpRegistrationRequestSchema = z.object({
  registration: PublicXmtpRegistrationSchema,
  proof: z.object({
    publicKey: Ed25519PublicKeySchema,
    signature: Ed25519SignatureSchema,
  }).strict(),
}).strict();

export const PublicXmtpDeleteRequestSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    inboxId: XmtpHex32Schema,
    installationId: XmtpHex32Schema,
  }).strict(),
  delivery: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('web_push'),
      endpoint: WebPushEndpoint,
    }).strict(),
    z.object({
      kind: z.literal('https_callback'),
      url: z.string().url().max(2048),
    }).strict(),
  ]),
  deletedAt: z.string().datetime({ offset: true }),
}).strict();

export const CallbackRoutesDeleteRequestSchema = z.object({
  inboxHandle: OpaqueInboxHandleSchema,
}).strict();

const XmtpNestedSubscriptionRequestObjectSchema = z.object({
  version: z.literal(1),
  app: z.object({
    id: z.literal('converge.cv'),
    origin: z.string().url().optional(),
  }).strict(),
  identity: z.object({
    inboxId: XmtpHex32Schema,
    installationId: XmtpHex32Schema,
    address: z.string().min(1).max(255).optional(),
  }).strict(),
  subscription: PushSubscriptionSchema,
  xmtp: z.object({
    env: z.literal('production'),
    topics: z.array(XmtpNestedTopicSchema).min(1).max(400),
    topicSource: z.literal('conversations.hmacKeys'),
  }).strict(),
  notification: z.object({
    inboxHandle: OpaqueInboxHandleSchema,
  }).strict(),
  preferences: XmtpPreferencesSchema,
  userAgent: z.string().max(1024).optional(),
  registeredAt: z.string().datetime({ offset: true }),
}).strict();

function validateXmtpRegistrationCost(
  value: { xmtp: { topics: Array<{ hmacKeys: unknown[] }> } },
  ctx: z.RefinementCtx
): void {
  const persistedRowCount = value.xmtp.topics.reduce(
    (count, topic) => count + 1 + topic.hmacKeys.length,
    0
  );
  if (persistedRowCount > 800) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['xmtp', 'topics'],
      message: 'topic and HMAC-key row count must not exceed 800',
    });
  }
}

export const XmtpPublicSubscriptionRequestSchema =
  XmtpNestedSubscriptionRequestObjectSchema.superRefine(validateXmtpRegistrationCost);

export const GenericXmtpSubscriptionRequestSchema =
  XmtpNestedSubscriptionRequestObjectSchema
    .omit({ app: true })
    .superRefine(validateXmtpRegistrationCost);

export const XmtpSubscriptionRequestSchema = z.union([
  XmtpPublicSubscriptionRequestSchema,
  XmtpLegacySubscriptionRequestSchema,
]);

const XmtpFlatDeleteSubscriptionRequestSchema = z.object({
  endpoint: WebPushEndpoint,
  inboxId: z.string().min(1).max(255),
  installationId: z.string().min(1).max(255),
}).strict();

export const XmtpPublicDeleteSubscriptionRequestSchema = z.object({
  version: z.literal(1),
  app: z.object({
    id: z.literal('converge.cv'),
    origin: z.string().url().optional(),
  }).strict(),
  endpoint: WebPushEndpoint,
  identity: z.object({
    inboxId: XmtpHex32Schema,
    installationId: XmtpHex32Schema,
    address: z.string().min(1).max(255).optional(),
  }).strict(),
  deletedAt: z.string().datetime({ offset: true }),
}).strict();

export const GenericXmtpDeleteSubscriptionRequestSchema = XmtpPublicDeleteSubscriptionRequestSchema
  .omit({ app: true });

export const XmtpDeleteSubscriptionRequestSchema = z.union([
  XmtpPublicDeleteSubscriptionRequestSchema,
  XmtpFlatDeleteSubscriptionRequestSchema,
]);

const OfficialXmtpDeliveryRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(512),
  message: z.object({
    content_topic: z.string().min(1).max(512),
    // Official HTTP delivery sends opaque encrypted envelope bytes as base64.
    // They are validated for shape only and are never stored or forwarded.
    message: z.string().min(1).max(20_000_000),
  }).strict(),
  message_context: z.object({
    message_type: z.string().min(1).max(64),
    should_push: z.boolean().optional(),
  }).strict(),
  installation: z.object({
    id: z.string().min(1).max(255),
    delivery_mechanism: z.object({
      kind: z.string().min(1).max(64),
      token: z.string().min(1).max(4096),
    }).strict(),
    payload_format: z.enum(['unspecified', 'v3', 'v4']),
  }).strict(),
  subscription: z.object({
    created_at: z.string().datetime({ offset: true }),
    topic: z.string().min(1).max(512),
    is_silent: z.boolean(),
  }).strict(),
  payload_format: z.enum(['unspecified', 'v3', 'v4']).optional(),
  topicBytesB64: z.string().max(2048).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.message.content_topic !== value.subscription.topic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message', 'content_topic'],
      message: 'message.content_topic must match subscription.topic',
    });
  }
});

const MinimalXmtpDeliveryRequestSchema = z.object({
  version: z.literal(1),
  idempotencyKey: z.string().min(1).max(512),
  installationId: z.string().min(1).max(255),
  deliveryToken: z.string().min(1).max(255),
  topic: z.string().min(1).max(512),
  messageType: z.string().min(1).max(64),
  shouldPush: z.boolean().optional(),
  isSilent: z.boolean(),
}).strict();

export const XmtpDeliveryRequestSchema = z.union([
  MinimalXmtpDeliveryRequestSchema,
  OfficialXmtpDeliveryRequestSchema,
]);

const ListenerCursorSchema = z.union([
  z.string().regex(/^\d+$/, 'cursor must be a non-negative integer string'),
  z.number().int().nonnegative().safe(),
]).transform((value) => String(value));

export const XmtpListenerStatusSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  ready: z.boolean(),
  cursor: ListenerCursorSchema,
  observedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  streamConnectedAt: z.string().datetime({ offset: true }).optional(),
  lastEnvelopeAt: z.string().datetime({ offset: true }).optional(),
  lastControlSyncAt: z.string().datetime({ offset: true }).optional(),
  deliveryReady: z.boolean().optional(),
  lastDeliveryProbeAt: z.string().datetime({ offset: true }).optional(),
  registrationCount: z.number().int().nonnegative().safe().optional(),
  topicCount: z.number().int().nonnegative().safe().optional(),
}).strict();

export type RegisterAppInput = z.infer<typeof RegisterAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type PublicAppCreateInput = z.infer<typeof PublicAppCreateSchema>;
export type PublicAppUpdateInput = z.infer<typeof PublicAppUpdateSchema>;
export type SubscribeInput = z.infer<typeof SubscribeSchema>;
export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;
export type XmtpSubscriptionRequestInput = z.infer<typeof XmtpSubscriptionRequestSchema>;
export type XmtpDeleteSubscriptionRequestInput = z.infer<typeof XmtpDeleteSubscriptionRequestSchema>;
export type XmtpDeliveryRequestInput = z.infer<typeof XmtpDeliveryRequestSchema>;
export type GenericXmtpSubscriptionRequestInput = z.infer<typeof GenericXmtpSubscriptionRequestSchema>;
export type GenericXmtpDeleteSubscriptionRequestInput = z.infer<typeof GenericXmtpDeleteSubscriptionRequestSchema>;
export type PublicXmtpRegistrationInput = z.infer<typeof PublicXmtpRegistrationSchema>;
export type PublicXmtpRegistrationRequestInput = z.infer<typeof PublicXmtpRegistrationRequestSchema>;
export type PublicXmtpDeleteRequestInput = z.infer<typeof PublicXmtpDeleteRequestSchema>;
export type XmtpListenerStatusInput = z.infer<typeof XmtpListenerStatusSchema>;
