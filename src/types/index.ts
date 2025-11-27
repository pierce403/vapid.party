export interface App {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
}

export interface Subscription {
  id: string;
  appId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

export interface VapidKeys {
  id: number;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export interface SendNotificationRequest {
  subscriptionId?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  payload: NotificationPayload;
}

export interface NotificationPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
  actions?: NotificationAction[];
}

export interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
