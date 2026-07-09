import { z } from 'zod';
import { base64UrlToBytes, normalizeBase64Url } from './encoding';

const Base64OrBase64UrlString = z.string().min(1).transform((value, ctx) => {
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
  if (!bytes || bytes.length !== 65) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'keys.p256dh must decode to 65 bytes',
    });
  }
});

const AuthKey = Base64OrBase64UrlString.superRefine((value, ctx) => {
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'keys.auth must decode to at least 16 bytes',
    });
  }
});

const AbsoluteUrl = z.string().url();
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
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: P256dhKey,
    auth: AuthKey,
  }).strict(),
  expirationTime: z.number().nullable().optional(),
}).strict();

export const SubscribeSchema = PushSubscriptionSchema.extend({
  userId: z.string().max(255).optional(),
  channelId: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
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
      action: z.string(),
      title: z.string(),
      icon: z.string().optional(),
    }).strict()).optional(),
    tag: z.string().optional(),
    requireInteraction: z.boolean().optional(),
    silent: z.boolean().optional(),
  }).strict(),
  userId: z.string().optional(),
  channelId: z.string().optional(),
  subscriptionIds: z.array(z.string()).optional(),
}).strict();

export const XmtpPreferencesSchema = z.object({
  minimalPayloadOnly: z.literal(true),
  plaintextPreview: z.literal(false),
}).strict();

export const XmtpTopicSchema = z.object({
  topic: z.string().min(1).max(512),
  hmacKey: Base64OrBase64UrlString,
  algorithm: z.enum(['hmac-sha256', 'sha256']).default('hmac-sha256'),
  conversationId: z.string().min(1).max(255).optional(),
}).strict();

const XmtpHmacKeysSchema = z.union([
  z.array(XmtpTopicSchema),
  z.record(z.union([
    Base64OrBase64UrlString,
    z.object({
      hmacKey: Base64OrBase64UrlString,
      algorithm: z.enum(['hmac-sha256', 'sha256']).default('hmac-sha256').optional(),
      conversationId: z.string().min(1).max(255).optional(),
    }).strict(),
  ])),
]);

export const XmtpSubscriptionRequestSchema = z.object({
  subscription: PushSubscriptionSchema.optional(),
  endpoint: z.string().url().optional(),
  keys: z.object({
    p256dh: P256dhKey,
    auth: AuthKey,
  }).strict().optional(),
  expirationTime: z.number().nullable().optional(),
  inboxId: z.string().min(1).max(255),
  installationId: z.string().min(1).max(255),
  address: z.string().min(1).max(255).optional(),
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

export const XmtpDeleteSubscriptionRequestSchema = z.object({
  endpoint: z.string().url(),
  inboxId: z.string().min(1).max(255),
  installationId: z.string().min(1).max(255),
}).strict();

export const XmtpEnvelopeSchema = z.object({
  topic: z.string().min(1).max(512),
  hmacKey: Base64OrBase64UrlString,
  cursor: z.string().max(1000).optional(),
  conversationId: z.string().min(1).max(255).optional(),
}).strict();

export type RegisterAppInput = z.infer<typeof RegisterAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type SubscribeInput = z.infer<typeof SubscribeSchema>;
export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;
export type XmtpSubscriptionRequestInput = z.infer<typeof XmtpSubscriptionRequestSchema>;
export type XmtpDeleteSubscriptionRequestInput = z.infer<typeof XmtpDeleteSubscriptionRequestSchema>;
export type XmtpEnvelopeInput = z.infer<typeof XmtpEnvelopeSchema>;
