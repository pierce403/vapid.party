(() => {
  const rail = document.querySelector('.status-rail');
  const refreshButton = document.querySelector('[data-refresh]');
  const overall = document.querySelector('[data-overall]');
  const delivery = document.querySelector('[data-delivery]');
  const listener = document.querySelector('[data-listener]');
  const bridge = document.querySelector('[data-bridge]');
  const checked = document.querySelector('[data-checked]');
  let activeController = null;
  let latestRequest = 0;

  const words = {
    ready: 'Ready',
    not_ready: 'Not ready',
    not_configured: 'Not configured',
    unknown: 'Unknown',
    synced: 'Synced',
    pending: 'Pending',
    failed: 'Failed',
  };

  function showUnavailable(message) {
    rail.dataset.state = 'unavailable';
    overall.textContent = message;
    delivery.textContent = 'Unavailable';
    listener.textContent = 'Unknown';
    bridge.textContent = 'Unknown';
    checked.textContent = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date());
  }

  function validHealth(payload) {
    const data = payload && payload.success === true ? payload.data : null;
    const xmtp = data && data.xmtp;
    if (
      !data ||
      data.status !== 'healthy' ||
      data.runtime !== 'cloudflare-worker' ||
      typeof data.timestamp !== 'string' ||
      !xmtp ||
      typeof xmtp.deliveryReady !== 'boolean' ||
      !xmtp.listener ||
      typeof xmtp.listener.status !== 'string' ||
      !xmtp.bridge ||
      typeof xmtp.bridge.status !== 'string'
    ) {
      return null;
    }
    const timestamp = new Date(data.timestamp);
    if (Number.isNaN(timestamp.getTime())) return null;
    return { data, xmtp, timestamp };
  }

  async function loadHealth() {
    const requestId = ++latestRequest;
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 6500);
    refreshButton.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;

    try {
      const response = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Health endpoint unavailable');
      const health = validHealth(await response.json());
      if (!health) throw new Error('Health response malformed');

      const listenerState = words[health.xmtp.listener.status] || 'Unknown';
      const bridgeState = words[health.xmtp.bridge.status] || 'Unknown';
      const ready =
        health.xmtp.deliveryReady === true &&
        health.xmtp.listener.status === 'ready' &&
        health.xmtp.bridge.status === 'synced';

      rail.dataset.state = ready ? 'ready' : 'degraded';
      overall.textContent = ready ? 'Relay operational' : 'Relay delivery degraded';
      delivery.textContent = ready ? 'Ready' : 'Not ready';
      listener.textContent = listenerState;
      bridge.textContent = bridgeState;
      checked.textContent = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(health.timestamp);
    } catch (error) {
      if (requestId !== latestRequest) return;
      if (error && error.name === 'AbortError') {
        showUnavailable('Relay status timed out');
      } else {
        showUnavailable('Relay status unavailable');
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestId === latestRequest) {
        refreshButton.removeAttribute('aria-busy');
        refreshButton.disabled = false;
        activeController = null;
      }
    }
  }

  refreshButton.addEventListener('click', loadHealth);
  loadHealth();
  window.setInterval(loadHealth, 60000);
})();
