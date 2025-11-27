'use client';

import { useState } from 'react';

const clientCode = `// 1. Get VAPID public key from your app
const response = await fetch('https://vapid.party/api/vapid/public-key', {
  headers: { 'X-API-Key': 'YOUR_API_KEY' }
});
const { data: { publicKey } } = await response.json();

// 2. Subscribe user to push notifications
const registration = await navigator.serviceWorker.ready;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(publicKey)
});

// 3. Send subscription to vapid.party
await fetch('https://vapid.party/api/subscribe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
      auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth'))))
    },
    userId: 'user_123',        // Optional: for targeted notifications
    channelId: 'announcements' // Optional: for channel-based targeting
  })
});`;

const serverCode = `// Send notification to all subscribers
const response = await fetch('https://vapid.party/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    payload: {
      title: '🎉 New Feature!',
      body: 'Check out our latest update',
      icon: '/icon.png',
      url: 'https://yourapp.com/new-feature'
    },
    // Optional targeting:
    // userId: 'user_123',     // Send to specific user
    // channelId: 'updates',   // Send to channel subscribers
  })
});

const { data } = await response.json();
console.log(\`Sent: \${data.sent}, Failed: \${data.failed}\`);`;

const serviceWorkerCode = `// service-worker.js
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
    event.waitUntil(
      clients.openWindow(event.notification.data.url)
    );
  }
});`;

export default function HowItWorks() {
  const [activeTab, setActiveTab] = useState<'client' | 'server' | 'worker'>('client');

  const tabs = [
    { id: 'client' as const, label: 'Client Setup' },
    { id: 'server' as const, label: 'Send Notification' },
    { id: 'worker' as const, label: 'Service Worker' },
  ];

  const code = {
    client: clientCode,
    server: serverCode,
    worker: serviceWorkerCode,
  };

  type TokenType = 'comment' | 'string' | 'keyword' | 'number' | 'boolean' | 'plain';

  const tokenMatchers: { type: TokenType; regex: RegExp }[] = [
    { type: 'comment', regex: /(\/\/.*$)/gm },
    { type: 'string', regex: /(["'`])(?:\\.|(?!\1).)*\1/g },
    {
      type: 'keyword',
      regex:
        /\b(await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/g,
    },
    { type: 'boolean', regex: /\b(true|false|null|undefined)\b/g },
    { type: 'number', regex: /\b\d+(?:\.\d+)?\b/g },
  ];

  const tokenizeLine = (line: string) => {
    type Token = { text: string; type: TokenType };
    let tokens: Token[] = [{ text: line, type: 'plain' }];

    const applyRegex = (currentTokens: Token[], matcher: (typeof tokenMatchers)[number]) => {
      const nextTokens: Token[] = [];

      currentTokens.forEach((token) => {
        if (token.type !== 'plain') {
          nextTokens.push(token);
          return;
        }

        const { regex, type } = matcher;
        regex.lastIndex = 0;
        let lastIndex = 0;
        for (const match of token.text.matchAll(regex)) {
          const matchIndex = match.index ?? 0;
          if (matchIndex > lastIndex) {
            nextTokens.push({ text: token.text.slice(lastIndex, matchIndex), type: 'plain' });
          }
          nextTokens.push({ text: match[0], type });
          lastIndex = matchIndex + match[0].length;
        }

        if (lastIndex < token.text.length) {
          nextTokens.push({ text: token.text.slice(lastIndex), type: 'plain' });
        }
      });

      return nextTokens;
    };

    tokenMatchers.forEach((matcher) => {
      tokens = applyRegex(tokens, matcher);
    });

    return tokens;
  };

  const lines = code[activeTab].split('\n');

  return (
    <section id="how-it-works" className="py-24 px-6 bg-midnight-900/30">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold mb-4">
            Three steps to
            <span className="glow-text"> push bliss</span>
          </h2>
          <p className="text-xl text-midnight-400">
            Copy, paste, push. It&apos;s really that simple.
          </p>
        </div>

        {/* Steps */}
        <div className="grid md:grid-cols-3 gap-8 mb-16">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-vapor-500/20 border-2 border-vapor-500 flex items-center justify-center text-2xl font-bold text-vapor-400 mx-auto mb-4">
              1
            </div>
            <h3 className="font-semibold mb-2">Connect & Create</h3>
            <p className="text-sm text-midnight-400">
              Connect your wallet and create an app to get your API key and VAPID keys.
            </p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-vapor-500/20 border-2 border-vapor-500 flex items-center justify-center text-2xl font-bold text-vapor-400 mx-auto mb-4">
              2
            </div>
            <h3 className="font-semibold mb-2">Subscribe Users</h3>
            <p className="text-sm text-midnight-400">
              Use the Web Push API to subscribe users and register their subscriptions.
            </p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-vapor-500/20 border-2 border-vapor-500 flex items-center justify-center text-2xl font-bold text-vapor-400 mx-auto mb-4">
              3
            </div>
            <h3 className="font-semibold mb-2">Send Notifications</h3>
            <p className="text-sm text-midnight-400">
              Call our API to send notifications to all users or target specific ones.
            </p>
          </div>
        </div>

        {/* Code Tabs */}
        <div className="card">
          <div className="flex gap-2 mb-4 border-b border-midnight-800 pb-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-vapor-500/20 text-vapor-400'
                    : 'text-midnight-400 hover:text-white hover:bg-midnight-800/50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="code-block overflow-x-auto">
            <pre className="text-vapor-300 text-sm">
              {lines.map((line, i) => (
                <div key={i} className="whitespace-pre">
                  {tokenizeLine(line).map((token, key) => (
                    <span
                      key={key}
                      className={token.type !== 'plain' ? `token ${token.type}` : undefined}
                    >
                      {token.text}
                    </span>
                  ))}
                  {i < lines.length - 1 ? '\n' : ''}
                </div>
              ))}
            </pre>
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(code[activeTab])}
            className="mt-4 btn-ghost text-sm"
          >
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy Code
          </button>
        </div>
      </div>
    </section>
  );
}

