export default function Footer() {
  return (
    <footer className="py-12 px-6 border-t border-midnight-800/50">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-vapor-400 to-vapor-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-midnight-950" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <span className="font-semibold">vapid.party</span>
          </div>

          <div className="flex items-center gap-6 text-sm text-midnight-400">
            <a href="/docs" className="hover:text-vapor-400 transition-colors">
              Documentation
            </a>
            <a href="/privacy" className="hover:text-vapor-400 transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-vapor-400 transition-colors">
              Terms
            </a>
            <a 
              href="https://github.com/vapid-party" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:text-vapor-400 transition-colors"
            >
              GitHub
            </a>
          </div>

          <p className="text-sm text-midnight-500">
            © 2024 vapid.party. Built with 🔔 and ☕
          </p>
        </div>
      </div>
    </footer>
  );
}

