import { z } from 'zod';

// ============================================================================
// Database Types
// ============================================================================

export interface App {
  id: string;
  name: string;
  ownerWallet: string;
  apiKey: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  metadata: AppMetadata;
  rateLimit: RateLimitConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppMetadata {
  description?: string;
  website?: string;
  iconUrl?: string;
}

export interface RateLimitConfig {
  maxNotificationsPerMinute: number;
  maxNotificationsPerDay: number;
  maxSubscriptions: number;
}

export interface Subscription {
  id: string;
  appId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;
}

export interface RateLimitLog {
  id: string;
  appId: string;
  action: 'notification' | 'subscription' | 'broadcast';
  count: number;
  windowStart: Date;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

// Register App
export const RegisterAppSchema = z.object({
  name: z.string().min(1).max(255),
  metadata: z.object({
    description: z.string().max(1000).optional(),
    website: z.string().url().optional(),
    iconUrl: z.string().url().optional(),
  }).optional(),
});

export type RegisterAppRequest = z.infer<typeof RegisterAppSchema>;

export interface RegisterAppResponse {
  id: string;
  name: string;
  apiKey: string;
  vapidPublicKey: string;
  createdAt: string;
}

// Subscribe
export const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userId: z.string().max(255).optional(),
  channelId: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
  expirationTime: z.number().nullable().optional(),
});

export type SubscribeRequest = z.infer<typeof SubscribeSchema>;

export interface SubscribeResponse {
  id: string;
  endpoint: string;
  createdAt: string;
}

// Send Notification
export const SendNotificationSchema = z.object({
  payload: z.object({
    title: z.string().min(1).max(255),
    body: z.string().max(1000).optional(),
    icon: z.string().url().optional(),
    badge: z.string().url().optional(),
    image: z.string().url().optional(),
    url: z.string().url().optional(),
    data: z.record(z.unknown()).optional(),
    actions: z.array(z.object({
      action: z.string(),
      title: z.string(),
      icon: z.string().optional(),
    })).optional(),
    tag: z.string().optional(),
    requireInteraction: z.boolean().optional(),
    silent: z.boolean().optional(),
  }),
  // Targeting options (optional - if none, sends to all)
  userId: z.string().optional(),
  channelId: z.string().optional(),
  subscriptionIds: z.array(z.string()).optional(),
});

export type SendNotificationRequest = z.infer<typeof SendNotificationSchema>;

export interface SendNotificationResponse {
  sent: number;
  failed: number;
  total: number;
  failures?: Array<{
    subscriptionId: string;
    error: string;
  }>;
}

// Generic API Response
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// Auth Types
export interface AuthPayload {
  address: string;
  chainId: number;
  exp: number;
  iat: number;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_API_KEY: 'INVALID_API_KEY',
  APP_NOT_FOUND: 'APP_NOT_FOUND',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  PUSH_FAILED: 'PUSH_FAILED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

