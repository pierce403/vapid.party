'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useActiveAccount } from 'thirdweb/react';
import Header from '@/components/Header';

// Simple auth token generator for demo purposes
function createMockToken(address: string): string {
  const payload = {
    sub: address.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
  return `header.${btoa(JSON.stringify(payload))}.signature`;
}

interface App {
  id: string;
  name: string;
  apiKey: string;
  vapidPublicKey: string;
  metadata?: {
    description?: string;
    website?: string;
  };
  rateLimit?: {
    maxNotificationsPerMinute: number;
    maxNotificationsPerDay: number;
    maxSubscriptions: number;
  };
  createdAt: string;
}

export default function Dashboard() {
  const account = useActiveAccount();
  const router = useRouter();
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<App | null>(null);
  const [deletingApp, setDeletingApp] = useState<string | null>(null);
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (!account) {
      router.push('/');
      return;
    }
    
    const loadApps = async () => {
      try {
        const token = createMockToken(account.address);

        const response = await fetch('/api/apps', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setApps(data.data || []);
        }
      } catch (error) {
        console.error('Failed to fetch apps:', error);
      } finally {
        setLoading(false);
      }
    };
    
    loadApps();
  }, [account, router]);

  const createApp = async () => {
    if (!account || !newAppName.trim()) return;
    
    setCreating(true);
    try {
      const token = createMockToken(account.address);

      const response = await fetch('/api/register-app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newAppName.trim() }),
      });

      if (response.ok) {
        const data = await response.json();
        setApps([data.data, ...apps]);
        setNewAppName('');
        setShowCreateModal(false);
      }
    } catch (error) {
      console.error('Failed to create app:', error);
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = (text: string, keyId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(keyId);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const deleteAppHandler = async (appId: string) => {
    if (!account) return;
    
    setDeletingApp(appId);
    try {
      const token = createMockToken(account.address);

      const response = await fetch(`/api/apps/${appId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        setApps(apps.filter(app => app.id !== appId));
        setShowDeleteConfirm(null);
        if (selectedApp?.id === appId) {
          setSelectedApp(null);
        }
      }
    } catch (error) {
      console.error('Failed to delete app:', error);
    } finally {
      setDeletingApp(null);
    }
  };

  const regenerateApiKeyHandler = async (appId: string) => {
    if (!account) return;
    
    setRegeneratingKey(appId);
    try {
      const token = createMockToken(account.address);

      const response = await fetch(`/api/apps/${appId}/regenerate-key`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setApps(apps.map(app => 
          app.id === appId ? { ...app, apiKey: data.data.apiKey } : app
        ));
        if (selectedApp?.id === appId) {
          setSelectedApp({ ...selectedApp, apiKey: data.data.apiKey });
        }
      }
    } catch (error) {
      console.error('Failed to regenerate API key:', error);
    } finally {
      setRegeneratingKey(null);
    }
  };

  if (!account) {
    return null;
  }

  return (
    <main className="min-h-screen">
      <Header />
      
      <div className="max-w-6xl mx-auto px-6 pt-28 pb-16">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Your Apps</h1>
            <p className="text-midnight-400">
              Manage your push notification apps and API keys
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary"
          >
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create New App
          </button>
        </div>

        {/* Apps Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin w-8 h-8 border-2 border-vapor-500 border-t-transparent rounded-full" />
          </div>
        ) : apps.length === 0 ? (
          <div className="card text-center py-16">
            <div className="w-20 h-20 rounded-full bg-midnight-800 flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 text-midnight-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2">No apps yet</h2>
            <p className="text-midnight-400 mb-6">
              Create your first app to start sending push notifications
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn-primary"
            >
              Create Your First App
            </button>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            {apps.map((app) => (
              <div key={app.id} className="card hover:border-vapor-500/30 transition-colors relative group">
                {/* Delete confirm overlay */}
                {showDeleteConfirm === app.id && (
                  <div className="absolute inset-0 bg-midnight-950/95 backdrop-blur-sm rounded-2xl z-10 flex flex-col items-center justify-center p-6">
                    <svg className="w-12 h-12 text-red-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <p className="text-center mb-4">Delete <strong>{app.name}</strong>? This cannot be undone.</p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowDeleteConfirm(null)}
                        className="btn-secondary"
                        disabled={deletingApp === app.id}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => deleteAppHandler(app.id)}
                        className="px-6 py-3 rounded-xl font-semibold bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                        disabled={deletingApp === app.id}
                      >
                        {deletingApp === app.id ? (
                          <div className="animate-spin w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full" />
                        ) : (
                          'Delete'
                        )}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold">{app.name}</h3>
                    <p className="text-sm text-midnight-500">
                      Created {new Date(app.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedApp(app)}
                      className="btn-ghost text-sm"
                    >
                      View Details
                    </button>
                    <button
                      onClick={() => setShowDeleteConfirm(app.id)}
                      className="p-2 hover:bg-red-500/20 text-midnight-400 hover:text-red-400 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete app"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* API Key */}
                <div className="mb-4">
                  <label className="text-sm text-midnight-400 mb-1 block">API Key</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-midnight-950 rounded-lg px-3 py-2 text-sm font-mono text-vapor-300 truncate">
                      {app.apiKey}
                    </code>
                    <button
                      onClick={() => regenerateApiKeyHandler(app.id)}
                      className="p-2 hover:bg-midnight-800 rounded-lg transition-colors"
                      title="Regenerate API key"
                      disabled={regeneratingKey === app.id}
                    >
                      {regeneratingKey === app.id ? (
                        <div className="animate-spin w-5 h-5 border-2 border-vapor-400 border-t-transparent rounded-full" />
                      ) : (
                        <svg className="w-5 h-5 text-midnight-400 hover:text-vapor-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => copyToClipboard(app.apiKey, `api-${app.id}`)}
                      className="p-2 hover:bg-midnight-800 rounded-lg transition-colors"
                      title="Copy API key"
                    >
                      {copiedKey === `api-${app.id}` ? (
                        <svg className="w-5 h-5 text-vapor-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-midnight-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* VAPID Public Key */}
                <div>
                  <label className="text-sm text-midnight-400 mb-1 block">VAPID Public Key</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-midnight-950 rounded-lg px-3 py-2 text-sm font-mono text-vapor-300 truncate">
                      {app.vapidPublicKey}
                    </code>
                    <button
                      onClick={() => copyToClipboard(app.vapidPublicKey, `vapid-${app.id}`)}
                      className="p-2 hover:bg-midnight-800 rounded-lg transition-colors"
                      title="Copy VAPID key"
                    >
                      {copiedKey === `vapid-${app.id}` ? (
                        <svg className="w-5 h-5 text-vapor-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-midnight-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* Rate Limits */}
                <div className="mt-4 pt-4 border-t border-midnight-800 grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-lg font-semibold text-vapor-400">
                      {app.rateLimit?.maxNotificationsPerMinute ?? 60}
                    </div>
                    <div className="text-xs text-midnight-500">per minute</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-vapor-400">
                      {((app.rateLimit?.maxNotificationsPerDay ?? 10000) / 1000).toFixed(0)}K
                    </div>
                    <div className="text-xs text-midnight-500">per day</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-vapor-400">
                      {((app.rateLimit?.maxSubscriptions ?? 10000) / 1000).toFixed(0)}K
                    </div>
                    <div className="text-xs text-midnight-500">subscribers</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create App Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md">
            <h2 className="text-xl font-semibold mb-4">Create New App</h2>
            <div className="mb-6">
              <label className="text-sm text-midnight-400 mb-2 block">App Name</label>
              <input
                type="text"
                value={newAppName}
                onChange={(e) => setNewAppName(e.target.value)}
                placeholder="My Awesome App"
                className="input"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn-secondary"
                disabled={creating}
              >
                Cancel
              </button>
              <button
                onClick={createApp}
                className="btn-primary"
                disabled={creating || !newAppName.trim()}
              >
                {creating ? (
                  <div className="animate-spin w-5 h-5 border-2 border-midnight-950 border-t-transparent rounded-full" />
                ) : (
                  'Create App'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* App Details Modal */}
      {selectedApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold">{selectedApp.name}</h2>
                <p className="text-sm text-midnight-500">App ID: {selectedApp.id}</p>
              </div>
              <button
                onClick={() => setSelectedApp(null)}
                className="p-2 hover:bg-midnight-800 rounded-lg transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Quick Start Code */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">Quick Start</h3>
              <div className="code-block">
                <pre className="text-sm text-vapor-300 whitespace-pre-wrap">{`// Subscribe a user
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: '${selectedApp.vapidPublicKey}'
});

await fetch('https://vapid.party/api/subscribe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': '${selectedApp.apiKey}'
  },
  body: JSON.stringify({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: /* base64 encoded */,
      auth: /* base64 encoded */
    }
  })
});

// Send a notification
await fetch('https://vapid.party/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': '${selectedApp.apiKey}'
  },
  body: JSON.stringify({
    payload: {
      title: 'Hello!',
      body: 'This is a test notification'
    }
  })
});`}</pre>
              </div>
            </div>

            <div className="flex gap-3 mb-4">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedApp.apiKey);
                  setCopiedKey('modal-api');
                  setTimeout(() => setCopiedKey(null), 2000);
                }}
                className="btn-secondary flex-1"
              >
                {copiedKey === 'modal-api' ? 'Copied!' : 'Copy API Key'}
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedApp.vapidPublicKey);
                  setCopiedKey('modal-vapid');
                  setTimeout(() => setCopiedKey(null), 2000);
                }}
                className="btn-secondary flex-1"
              >
                {copiedKey === 'modal-vapid' ? 'Copied!' : 'Copy VAPID Key'}
              </button>
            </div>

            {/* Danger Zone */}
            <div className="pt-4 border-t border-midnight-800">
              <h4 className="text-sm font-medium text-midnight-400 mb-3">Danger Zone</h4>
              <div className="flex gap-3">
                <button
                  onClick={() => regenerateApiKeyHandler(selectedApp.id)}
                  className="btn-secondary flex-1 text-sm"
                  disabled={regeneratingKey === selectedApp.id}
                >
                  {regeneratingKey === selectedApp.id ? (
                    <div className="animate-spin w-4 h-4 border-2 border-vapor-400 border-t-transparent rounded-full mr-2" />
                  ) : (
                    <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                  Regenerate API Key
                </button>
                <button
                  onClick={() => {
                    setShowDeleteConfirm(selectedApp.id);
                    setSelectedApp(null);
                  }}
                  className="px-4 py-2 rounded-xl font-medium text-sm bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                >
                  <svg className="w-4 h-4 mr-2 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete App
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

