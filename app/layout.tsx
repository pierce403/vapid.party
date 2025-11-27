import type { Metadata } from 'next';
import { Outfit, Fira_Code } from 'next/font/google';
import { ThirdwebProvider } from 'thirdweb/react';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

const firaCode = Fira_Code({
  subsets: ['latin'],
  variable: '--font-fira-code',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'vapid.party - Web Push Made Simple',
  description: 'A Web3-native Web Push notification relay. Connect your wallet, create apps, and send push notifications with your own VAPID keys.',
  keywords: ['web push', 'notifications', 'vapid', 'web3', 'crypto', 'push api'],
  authors: [{ name: 'vapid.party' }],
  openGraph: {
    title: 'vapid.party - Web Push Made Simple',
    description: 'A Web3-native Web Push notification relay',
    url: 'https://vapid.party',
    siteName: 'vapid.party',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'vapid.party',
    description: 'A Web3-native Web Push notification relay',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${outfit.variable} ${firaCode.variable}`}>
      <body className="noise font-sans">
        <div className="gradient-blob blob-1" />
        <div className="gradient-blob blob-2" />
        <div className="grid-overlay" />
        <ThirdwebProvider>
          {children}
        </ThirdwebProvider>
      </body>
    </html>
  );
}
