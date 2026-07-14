import type { XmtpListenerContainer } from './xmtp-listener-container';

export interface RateLimitConfig {
  maxNotificationsPerMinute: number;
  maxNotificationsPerDay: number;
  maxSubscriptions: number;
}

export interface AppRecord {
  id: string;
  name: string;
  ownerWallet: string;
  apiKey: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  metadata: Record<string, unknown>;
  rateLimit: RateLimitConfig;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord {
  id: string;
  appId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userId?: string;
  channelId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  disabledAt?: string;
}

export interface XmtpTopicMatch {
  topicId: string;
  subscriptionId: string;
  appId: string;
  installationId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  conversationId?: string;
  inboxHandle?: string;
}

export type PushPayload = Record<string, unknown>;

export interface PushQueueJob {
  deliveryAttemptId: string;
  appId: string;
  subscriptionId: string;
  payload: PushPayload;
  source: 'generic' | 'xmtp';
}

export interface Env {
  DB: D1Database;
  PUSH_QUEUE: Queue<PushQueueJob>;
  RELAY_COORDINATOR: DurableObjectNamespace;
  XMTP_LISTENER?: DurableObjectNamespace<XmtpListenerContainer>;
  ASSETS?: Fetcher;
  VAPID_SUBJECT?: string;
  CONVERGE_APP_ID?: string;
  CONVERGE_VAPID_PUBLIC_KEY?: string;
  CONVERGE_VAPID_PRIVATE_KEY?: string;
  CONVERGE_API_KEY?: string;
  INTERNAL_INGEST_TOKEN?: string;
  XMTP_LISTENER_SYNC_TOKEN?: string;
  VAPID_PARTY_PUBLIC_URL?: string;
}

export interface XmtpListenerHmacKey {
  thirtyDayPeriodsSinceEpoch: number;
  key: string;
}

export interface XmtpListenerTopic {
  topic: string;
  isSilent: boolean;
  hmacKeys: XmtpListenerHmacKey[];
}

export interface XmtpListenerRegistration {
  appId: string;
  installationId: string;
  deliveryToken: string;
  topics: XmtpListenerTopic[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxNotificationsPerMinute: 60,
  maxNotificationsPerDay: 10000,
  maxSubscriptions: 10000,
};
