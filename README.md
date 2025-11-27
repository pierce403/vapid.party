# vapid.party

Community VAPID Push Provider - A Node/TypeScript API for Web Push notifications using the VAPID spec.

## Features

- 🔑 Automatic VAPID keypair generation and storage
- 📱 App registration with API key management
- 💾 Web Push subscription storage
- 📤 Send notifications to individual subscribers or broadcast to all
- 🚀 Deployable on Vercel (serverless) or as a standalone Express server
- 🛡️ Rate limiting to prevent abuse
- 📊 Request logging with Winston

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Run Tests

```bash
npm test
```

### Production

```bash
npm run build
npm start
```

## API Endpoints

### Health Check

```
GET /api/health
```

Returns server health status.

### VAPID Public Key

```
GET /api/vapid/public-key
```

Returns the VAPID public key needed for Web Push subscription.

**Response:**
```json
{
  "success": true,
  "data": {
    "publicKey": "BPnJDfW..."
  }
}
```

### Register App

```
POST /api/apps
Content-Type: application/json

{
  "name": "My Application"
}
```

Creates a new app and returns an API key for authentication.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "My Application",
    "apiKey": "vp_...",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### Get Current App

```
GET /api/apps/me
X-API-Key: vp_your_api_key
```

Returns information about the authenticated app.

### Save Subscription

```
POST /api/subscriptions
X-API-Key: vp_your_api_key
Content-Type: application/json

{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BNcRdreALRFXTkOOUH...",
    "auth": "tBHItJI5svbpez7Kk..."
  }
}
```

Saves a Web Push subscription for the authenticated app.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "subscription-uuid",
    "endpoint": "https://...",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### List Subscriptions

```
GET /api/subscriptions
X-API-Key: vp_your_api_key
```

Lists all subscriptions for the authenticated app.

### Send Notification

```
POST /api/notifications/send
X-API-Key: vp_your_api_key
Content-Type: application/json

{
  "subscriptionId": "subscription-uuid",
  "payload": {
    "title": "Hello!",
    "body": "This is a notification",
    "icon": "/icon.png",
    "data": {
      "url": "https://example.com"
    }
  }
}
```

Or send directly without a stored subscription:

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BNcRdreALRFXTkOOUH...",
    "auth": "tBHItJI5svbpez7Kk..."
  },
  "payload": {
    "title": "Hello!",
    "body": "This is a notification"
  }
}
```

### Broadcast Notification

```
POST /api/notifications/broadcast
X-API-Key: vp_your_api_key
Content-Type: application/json

{
  "payload": {
    "title": "Announcement",
    "body": "Message to all subscribers"
  }
}
```

Sends a notification to all subscriptions belonging to the authenticated app.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | SQLite database path | `./data/vapid.db` |
| `DATA_DIR` | Data directory path | `./data` |
| `VAPID_SUBJECT` | VAPID subject (mailto: or URL) | `mailto:admin@vapid.party` |
| `LOG_LEVEL` | Logging level | `info` |

## Rate Limits

- **General API**: 100 requests per 15 minutes per IP
- **App Registration**: 10 registrations per hour per IP
- **Notifications**: 60 requests per minute per API key

## Deployment

### Vercel

The project includes Vercel configuration for serverless deployment:

```bash
vercel
```

### Docker (optional)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

## License

Apache-2.0
