'use client';

import { useActiveAccount } from 'thirdweb/react';
import { useRouter } from 'next/navigation';

export default function Hero() {
  const account = useActiveAccount();
  const router = useRouter();

  const handleGetStarted = () => {
    if (account) {
      router.push('/dashboard');
    } else {
      // The connect button in header will handle this
      document.querySelector<HTMLButtonElement>('[data-connect-wallet]')?.click();
    }
  };

  return (
    <section className="min-h-screen flex flex-col items-center justify-center px-6 pt-20">
      <div className="max-w-4xl mx-auto text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-midnight-800/50 border border-midnight-700 mb-8 animate-[float_6s_ease-in-out_infinite]">
          <span className="w-2 h-2 rounded-full bg-vapor-400 animate-pulse" />
          <span className="text-sm text-midnight-300">Web3-Native Push Notifications</span>
        </div>

        {/* Headline */}
        <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
          Push Notifications
          <br />
          <span className="glow-text">Without the Party Poopers</span>
        </h1>

        {/* Subheadline */}
        <p className="text-xl text-midnight-400 mb-12 max-w-2xl mx-auto leading-relaxed">
          Create apps, generate VAPID keys, and send push notifications — all with your wallet.
          No email signups. No credit cards. Just crypto-native simplicity.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
          <button onClick={handleGetStarted} className="btn-primary text-lg px-8 py-4">
            {account ? 'Go to Dashboard' : 'Get Started Free'}
            <svg className="w-5 h-5 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
          <a href="#how-it-works" className="btn-secondary text-lg px-8 py-4">
            See How It Works
          </a>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-8 max-w-lg mx-auto">
          <div className="text-center">
            <div className="text-3xl font-bold text-vapor-400">Free</div>
            <div className="text-sm text-midnight-500">To Start</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-vapor-400">10K</div>
            <div className="text-sm text-midnight-500">Daily Pushes</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-vapor-400">∞</div>
            <div className="text-sm text-midnight-500">Subscribers</div>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <svg className="w-6 h-6 text-midnight-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </div>
    </section>
  );
}

