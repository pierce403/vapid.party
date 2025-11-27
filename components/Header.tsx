'use client';

import { useState } from 'react';
import { ConnectButton, useActiveAccount } from 'thirdweb/react';
import { createThirdwebClient } from 'thirdweb';
import { createWallet, inAppWallet } from 'thirdweb/wallets';

const client = createThirdwebClient({
  clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID || 'demo',
});

const wallets = [
  inAppWallet(),
  createWallet('io.metamask'),
  createWallet('com.coinbase.wallet'),
  createWallet('me.rainbow'),
  createWallet('io.rabby'),
];

export default function Header() {
  const account = useActiveAccount();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-midnight-800/50 bg-midnight-950/80 backdrop-blur-xl">
      <nav className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="/" className="flex items-center gap-3 group">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-vapor-400 to-vapor-600 flex items-center justify-center shadow-lg shadow-vapor-500/20 group-hover:shadow-vapor-500/40 transition-shadow">
            <svg className="w-6 h-6 text-midnight-950" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </div>
          <span className="text-xl font-bold glow-text">vapid.party</span>
        </a>

        <div className="flex items-center gap-6">
          {account && (
            <a href="/dashboard" className="btn-ghost">
              Dashboard
            </a>
          )}
          <a 
            href="https://github.com/vapid-party" 
            target="_blank" 
            rel="noopener noreferrer"
            className="btn-ghost"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
          </a>
          <ConnectButton
            client={client}
            wallets={wallets}
            theme="dark"
            connectButton={{
              label: 'Connect Wallet',
              style: {
                background: 'linear-gradient(to right, #14b898, #2cd4b0)',
                color: '#0f1422',
                fontWeight: '600',
                borderRadius: '12px',
                padding: '12px 24px',
              },
            }}
            detailsButton={{
              style: {
                background: 'rgba(39, 60, 99, 0.5)',
                border: '1px solid rgba(69, 108, 174, 0.3)',
                borderRadius: '12px',
                padding: '8px 16px',
              },
            }}
          />
        </div>
      </nav>
    </header>
  );
}

