(() => {
  const REQUEST_TIMEOUT_MS = 6500;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function withTimeout() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return { controller, stop: () => window.clearTimeout(timeout) };
  }

  async function requestJson(path, options = {}) {
    const { controller, stop } = withTimeout();
    try {
      const response = await fetch(path, {
        cache: 'no-store',
        credentials: 'omit',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError('The server returned an unreadable response.', response.status);
      }
      if (!response.ok || !payload || payload.success !== true) {
        const message = payload && typeof payload.error === 'string'
          ? payload.error
          : 'The request could not be completed.';
        throw new ApiError(message, response.status);
      }
      return payload.data;
    } finally {
      stop();
    }
  }

  function formatDate(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function formatCount(input) {
    return new Intl.NumberFormat().format(input);
  }

  async function copyValue(value, input, status) {
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = 'Copied.';
    } catch {
      input.focus();
      input.select();
      status.textContent = 'Select the value and copy it manually.';
    }
  }

  function initHealth() {
    const rail = document.querySelector('.status-rail');
    const refreshButton = document.querySelector('[data-refresh]');
    const overall = document.querySelector('[data-overall]');
    const delivery = document.querySelector('[data-delivery]');
    const listener = document.querySelector('[data-listener]');
    const bridge = document.querySelector('[data-bridge]');
    const checked = document.querySelector('[data-checked]');
    if (!rail || !refreshButton || !overall || !delivery || !listener || !bridge || !checked) {
      return;
    }

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
      return { xmtp, timestamp };
    }

    async function loadHealth() {
      const requestId = ++latestRequest;
      if (activeController) activeController.abort();
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
        showUnavailable(error && error.name === 'AbortError'
          ? 'Relay status timed out'
          : 'Relay status unavailable');
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
  }

  function validCreatedApp(data) {
    return data &&
      data.app &&
      typeof data.app.id === 'string' &&
      typeof data.app.publicVapidKey === 'string' &&
      typeof data.appSecret === 'string';
  }

  function initCreateApp() {
    const form = document.querySelector('[data-create-form]');
    if (!form) return;
    const nameInput = form.querySelector('[name="name"]');
    const submit = document.querySelector('[data-create-submit]');
    const status = document.querySelector('[data-create-status]');
    const result = document.querySelector('[data-create-result]');
    const appIdInput = document.querySelector('[data-created-app-id]');
    const vapidKeyInput = document.querySelector('[data-created-vapid-key]');
    const secretInput = document.querySelector('[data-created-app-secret]');
    const toggle = document.querySelector('[data-toggle-secret]');
    const copy = document.querySelector('[data-copy-secret]');
    const copyStatus = document.querySelector('[data-copy-status]');
    const dashboard = document.querySelector('[data-open-dashboard]');
    let created = null;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      status.textContent = '';
      status.dataset.state = '';
      if (!name) {
        status.textContent = 'Enter an app name.';
        status.dataset.state = 'error';
        nameInput.focus();
        return;
      }

      result.hidden = true;
      secretInput.value = '';
      created = null;
      submit.disabled = true;
      submit.textContent = 'Creating app…';
      form.setAttribute('aria-busy', 'true');

      try {
        const data = await requestJson('/api/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!validCreatedApp(data)) {
          throw new Error('The app was created but its credential response was malformed.');
        }
        created = data;
        appIdInput.value = data.app.id;
        vapidKeyInput.value = data.app.publicVapidKey;
        secretInput.value = data.appSecret;
        secretInput.type = 'password';
        toggle.textContent = 'Show';
        copyStatus.textContent = '';
        result.hidden = false;
        result.focus();
        form.reset();
      } catch (error) {
        status.dataset.state = 'error';
        if (error && error.name === 'AbortError') {
          status.textContent = 'The request timed out. We could not confirm whether the app was created.';
        } else if (error instanceof ApiError) {
          status.textContent = error.message;
        } else {
          status.textContent = error instanceof Error
            ? error.message
            : 'The app could not be created.';
        }
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create app';
        form.removeAttribute('aria-busy');
      }
    });

    toggle.addEventListener('click', () => {
      const revealing = secretInput.type === 'password';
      secretInput.type = revealing ? 'text' : 'password';
      toggle.textContent = revealing ? 'Hide' : 'Show';
    });

    copy.addEventListener('click', () => {
      if (!created) return;
      copyValue(created.appSecret, secretInput, copyStatus);
    });

    dashboard.addEventListener('click', () => {
      if (!created) return;
      const fragment = new URLSearchParams({
        app: created.app.id,
        secret: created.appSecret,
      });
      window.location.assign(`/dashboard#${fragment.toString()}`);
    });
  }

  function validLeaderboard(data) {
    return data &&
      typeof data.generatedAt === 'string' &&
      data.window &&
      Number.isInteger(data.window.days) &&
      Array.isArray(data.apps);
  }

  function safeDomainLink(domain) {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain)) return null;
    try {
      const url = new URL(`https://${domain}/`);
      return url.hostname === domain ? url.href : null;
    } catch {
      return null;
    }
  }

  function leaderboardRow(entry) {
    if (
      !entry ||
      !Number.isInteger(entry.rank) ||
      typeof entry.name !== 'string' ||
      typeof entry.verifiedDomain !== 'string' ||
      typeof entry.domainVerifiedAt !== 'string' ||
      !Number.isFinite(entry.providerAcceptedLast7Days)
    ) return null;

    const row = document.createElement('tr');
    const rank = document.createElement('th');
    rank.scope = 'row';
    rank.textContent = String(entry.rank);

    const app = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = entry.name;
    app.append(name);
    if (typeof entry.description === 'string' && entry.description) {
      const description = document.createElement('p');
      description.textContent = entry.description;
      app.append(description);
    }

    const domain = document.createElement('td');
    const href = safeDomainLink(entry.verifiedDomain);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.verifiedDomain;
      domain.append(link);
    } else {
      domain.textContent = entry.verifiedDomain;
    }
    const badge = document.createElement('span');
    badge.className = 'verified-badge';
    const verifiedAt = formatDate(entry.domainVerifiedAt);
    badge.textContent = verifiedAt
      ? `DNS last verified ${verifiedAt}`
      : 'DNS last verified';
    domain.append(badge);

    const accepted = document.createElement('td');
    accepted.className = 'number-cell';
    accepted.textContent = formatCount(Math.max(0, entry.providerAcceptedLast7Days));
    row.append(rank, app, domain, accepted);
    return row;
  }

  async function initLeaderboard() {
    const frame = document.querySelector('[data-leaderboard-frame]');
    if (!frame) return;
    const status = document.querySelector('[data-leaderboard-status]');
    const table = document.querySelector('[data-leaderboard-table]');
    const body = document.querySelector('[data-leaderboard-body]');
    const empty = document.querySelector('[data-leaderboard-empty]');
    const updated = document.querySelector('[data-leaderboard-updated]');

    try {
      const data = await requestJson('/api/leaderboard');
      if (!validLeaderboard(data)) throw new Error('Leaderboard response malformed');
      body.replaceChildren();
      for (const entry of data.apps) {
        const row = leaderboardRow(entry);
        if (!row) throw new Error('Leaderboard entry malformed');
        body.append(row);
      }
      status.hidden = true;
      const hasApps = data.apps.length > 0;
      table.hidden = !hasApps;
      empty.hidden = hasApps;
      const date = formatDate(data.generatedAt);
      updated.textContent = date
        ? `Updated ${date}. Ranking window: today plus six prior UTC dates.`
        : 'Ranking window: today plus six prior UTC dates.';
    } catch (error) {
      table.hidden = true;
      empty.hidden = true;
      status.hidden = false;
      status.dataset.state = 'error';
      status.textContent = error && error.name === 'AbortError'
        ? 'The leaderboard timed out. Try again later.'
        : 'The public leaderboard is unavailable right now.';
    } finally {
      frame.removeAttribute('aria-busy');
    }
  }

  initHealth();
  initCreateApp();
  initLeaderboard();
})();
