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
  deliveryKind: 'web_push' | 'https_callback';
  userId?: string;
  channelId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  disabledAt?: string;
}

export interface AppPublicProfile {
  description: string;
  domain?: string;
  domainVerifiedAt?: string;
  domainLastCheckedAt?: string;
  domainVerificationStatus: 'unverified' | 'verified' | 'mismatch';
  leaderboardOptIn: boolean;
  updatedAt: string;
}

export interface UsageCounts {
  queued: number;
  providerAccepted: number;
  failed: number;
  expired: number;
}

export interface AppUsageStats {
  app: {
    id: string;
    name: string;
    publicVapidKey: string;
    createdAt: string;
  };
  profile: AppPublicProfile;
  subscriptions: {
    active: number;
    xmtpRegistrations: number;
  };
  xmtp: {
    groupTopics: number;
    welcomeTopics: number;
    hmacEpochs: number;
  };
  usage: {
    todayUtc: UsageCounts;
    last7DaysUtc: UsageCounts;
  };
  retentionDays: 8;
}

export interface LeaderboardEntry {
  rank: number;
  appId: string;
  name: string;
  description: string;
  verifiedDomain?: string;
  domainVerifiedAt?: string;
  providerAcceptedLast7Days: number;
}

export interface XmtpTopicMatch {
  topicId: string;
  xmtpSubscriptionId: string;
  subscriptionId: string;
  appId: string;
  installationId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deliveryKind: 'web_push' | 'https_callback';
  conversationId?: string;
  inboxHandle?: string;
}

export type PushPayload = Record<string, unknown>;

export interface PushQueueJob {
  deliveryAttemptId: string;
  appId: string;
  subscriptionId: string;
  xmtpSubscriptionId?: string;
  deliveryKind?: 'web_push' | 'https_callback';
  payload: PushPayload;
  source: 'generic' | 'xmtp' | 'diagnostic';
}

export interface Env {
  DB: D1Database;
  PUSH_QUEUE: Queue<PushQueueJob>;
  PUSH_DEAD_LETTER_QUEUE?: Queue<PushQueueJob>;
  RELAY_COORDINATOR: DurableObjectNamespace;
  XMTP_LISTENER?: DurableObjectNamespace<XmtpListenerContainer>;
  ASSETS?: Fetcher;
  VERSION_METADATA?: WorkerVersionMetadata;
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
