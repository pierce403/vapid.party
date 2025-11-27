# vapid.party 🔔

A Web3-native Web Push notification relay. Connect your wallet, create apps, and send push notifications with your own VAPID keys.

## Features

- **Web3 Authentication**: Sign in with your wallet via thirdweb - no email or password required
- **Per-App VAPID Keys**: Each app gets unique VAPID keypairs for complete isolation
- **User & Channel Targeting**: Tag subscriptions with `userId` or `channelId` for targeted notifications
- **Built-in Rate Limiting**: Per-app rate limits protect against abuse
- **Structured Logging**: Winston-based logging for monitoring and debugging
- **Vercel-Ready**: Deploy instantly to Vercel with Postgres

## Quick Start

### 1. Prerequisites

- Node.js 18+
- A [thirdweb](https://thirdweb.com) account and client ID
- A [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) database

### 2. Environment Setup

```bash
cp env.example .env.local
```

Fill in your environment variables:

```env
# Thirdweb Configuration
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=your_thirdweb_client_id

# Vercel Postgres (auto-populated when you link a database)
POSTGRES_URL=...
POSTGRES_PRISMA_URL=...
POSTGRES_URL_NON_POOLING=...
POSTGRES_USER=...
POSTGRES_HOST=...
POSTGRES_PASSWORD=...
POSTGRES_DATABASE=...

# VAPID Configuration
VAPID_SUBJECT=mailto:your-email@example.com
```

### 3. Install & Run

```bash
npm install
npm run db:migrate  # Initialize database tables
npm run dev         # Start development server
```

Visit [http://localhost:3000](http://localhost:3000)

## API Reference

### Authentication

All endpoints require authentication:
- **Wallet Auth**: For managing your apps (via `Authorization: Bearer <token>` header)
- **API Key Auth**: For subscribing users and sending notifications (via `X-API-Key` header)

### Endpoints

#### POST /api/register-app
Create a new app (requires wallet auth).

```bash
curl -X POST https://vapid.party/api/register-app \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <wallet-token>" \
  -d '{"name": "My App"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "My App",
    "apiKey": "vp_...",
    "vapidPublicKey": "BN...",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### POST /api/subscribe
Register a push subscription (requires API key).

```bash
curl -X POST https://vapid.party/api/subscribe \
  -H "Content-Type: application/json" \
  -H "X-API-Key: vp_..." \
  -d '{
    "endpoint": "https://fcm.googleapis.com/...",
    "keys": {
      "p256dh": "base64...",
      "auth": "base64..."
    },
    "userId": "user_123",
    "channelId": "announcements"
  }'
```

#### POST /api/send
Send push notifications (requires API key).

```bash
curl -X POST https://vapid.party/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: vp_..." \
  -d '{
    "payload": {
      "title": "Hello!",
      "body": "This is a notification",
      "icon": "/icon.png",
      "url": "https://example.com"
    },
    "userId": "user_123"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "sent": 1,
    "failed": 0,
    "total": 1
  }
}
```

#### GET /api/vapid/public-key
Get VAPID public key for client-side subscription (requires API key).

```bash
curl https://vapid.party/api/vapid/public-key \
  -H "X-API-Key: vp_..."
```

## Client Integration

### 1. Service Worker

```javascript
// service-worker.js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.notification.data?.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});
```

### 2. Subscribe Users

```javascript
// Helper to convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribeToPush(apiKey, vapidPublicKey) {
  const registration = await navigator.serviceWorker.ready;
  
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
  });

  await fetch('https://vapid.party/api/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
        auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth'))))
      },
      userId: 'optional-user-id'
    })
  });
}
```

### 3. Send Notifications (Server-side)

```javascript
async function sendNotification(apiKey, userId, message) {
  const response = await fetch('https://vapid.party/api/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify({
      payload: {
        title: message.title,
        body: message.body,
        url: message.url
      },
      userId: userId // Optional: target specific user
    })
  });

  return response.json();
}
```

## Rate Limits

Default limits per app:
- **60** notifications per minute
- **10,000** notifications per day
- **10,000** subscriptions

## Project Structure

```
vapid.party/
├── app/
│   ├── api/
│   │   ├── register-app/   # Create new apps
│   │   ├── subscribe/      # Register push subscriptions
│   │   ├── send/          # Send notifications
│   │   ├── apps/          # Manage apps (CRUD)
│   │   └── vapid/         # Get VAPID public key
│   ├── dashboard/         # App management UI
│   └── page.tsx           # Landing page
├── components/            # React components
├── lib/
│   ├── db.ts             # Database operations
│   ├── types.ts          # TypeScript types & Zod schemas
│   ├── notifications.ts  # Push notification sending
│   ├── api-utils.ts      # API helpers & auth
│   └── logger.ts         # Winston logging
└── scripts/
    └── migrate.ts        # Database migration
```

## Deployment

### Vercel (Recommended)

1. Push to GitHub
2. Import project in Vercel
3. Add environment variables
4. Deploy!

The database will be automatically initialized on first request.

### Manual Migration

```bash
npm run db:migrate
```

## Future Plans

The architecture supports future additions:
- Token-based billing (usage_logs table ready)
- Staking for higher limits
- Analytics dashboard
- Webhook integrations

## License

Apache 2.0
