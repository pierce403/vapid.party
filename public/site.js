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

  function parseDate(input) {
    if (typeof input !== 'string') return null;
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatAbsoluteDate(date) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(date);
  }

  function formatRelativeDate(date) {
    const seconds = (date.getTime() - Date.now()) / 1000;
    const absoluteSeconds = Math.abs(seconds);
    if (absoluteSeconds < 10) return 'just now';

    let divisor = 1;
    let unit = 'second';
    if (absoluteSeconds >= 7 * 24 * 60 * 60) {
      divisor = 7 * 24 * 60 * 60;
      unit = 'week';
    } else if (absoluteSeconds >= 24 * 60 * 60) {
      divisor = 24 * 60 * 60;
      unit = 'day';
    } else if (absoluteSeconds >= 60 * 60) {
      divisor = 60 * 60;
      unit = 'hour';
    } else if (absoluteSeconds >= 60) {
      divisor = 60;
      unit = 'minute';
    }

    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
      Math.round(seconds / divisor),
      unit
    );
  }

  function setTime(element, input, emptyText) {
    const date = parseDate(input);
    if (!date) {
      element.removeAttribute('datetime');
      element.removeAttribute('title');
      element.textContent = emptyText;
      return;
    }
    element.setAttribute('datetime', date.toISOString());
    element.title = formatAbsoluteDate(date);
    element.textContent = formatRelativeDate(date);
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
    const worker = document.querySelector('[data-worker]');
    const listener = document.querySelector('[data-listener]');
    const listenerDetail = document.querySelector('[data-listener-detail]');
    const network = document.querySelector('[data-network]');
    const bridge = document.querySelector('[data-bridge]');
    const bridgeDetail = document.querySelector('[data-bridge-detail]');
    const push = document.querySelector('[data-push]');
    const deliveryDetail = document.querySelector('[data-delivery-detail]');
    const deliveryFailure = document.querySelector('[data-delivery-failure]');
    const checked = document.querySelector('[data-checked]');
    const build = document.querySelector('[data-build]');
    const diagnostic = document.querySelector('[data-diagnostic]');
    const diagnosticList = document.querySelector('[data-diagnostic-list]');
    if (
      !rail ||
      !refreshButton ||
      !overall ||
      !worker ||
      !listener ||
      !listenerDetail ||
      !network ||
      !bridge ||
      !bridgeDetail ||
      !push ||
      !deliveryDetail ||
      !deliveryFailure ||
      !checked ||
      !build ||
      !diagnostic ||
      !diagnosticList
    ) {
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
      healthy: 'Healthy',
      degraded: 'Degraded',
      unavailable: 'Unavailable',
    };

    function optionalString(value) {
      return value === undefined || typeof value === 'string';
    }

    function optionalDate(value) {
      return value === undefined || parseDate(value) !== null;
    }

    function nonNegativeInteger(value) {
      return Number.isInteger(value) && value >= 0;
    }

    function optionalNonNegativeInteger(value) {
      return value === undefined || nonNegativeInteger(value);
    }

    function clearBuild() {
      build.hidden = true;
      build.textContent = '';
      build.removeAttribute('title');
    }

    function renderBuild(healthWorker) {
      const label = healthWorker.versionTag || healthWorker.versionId;
      if (!label) {
        clearBuild();
        return;
      }

      const details = [];
      if (healthWorker.versionId) details.push(`Version ${healthWorker.versionId}`);
      if (healthWorker.deployedAt) {
        details.push(`Uploaded ${formatAbsoluteDate(parseDate(healthWorker.deployedAt))}`);
      }
      build.textContent = `Build ${label}`;
      build.title = details.join(' · ') || label;
      build.hidden = false;
    }

    function showDiagnostics(entries) {
      diagnosticList.replaceChildren(...entries.map((entry) => {
        const item = document.createElement('li');
        const message = document.createElement('span');
        const code = document.createElement('code');
        message.textContent = entry.message;
        code.textContent = `${entry.component}:${entry.code}`;
        item.append(message, code);
        return item;
      }));
      diagnostic.hidden = false;
    }

    function hideDiagnostic() {
      diagnostic.hidden = true;
      diagnosticList.replaceChildren();
    }

    function showUnavailable(message, detail) {
      rail.dataset.state = 'unavailable';
      rail.setAttribute('aria-busy', 'false');
      if (overall.textContent !== message) overall.textContent = message;
      worker.textContent = 'Unavailable';
      listener.textContent = 'Unknown';
      listenerDetail.textContent = 'No heartbeat report';
      setTime(network, undefined, 'Unavailable');
      bridge.textContent = 'Unknown';
      bridgeDetail.textContent = 'Route counts unavailable';
      setTime(push, undefined, 'Unavailable');
      deliveryDetail.textContent = 'Queue state unavailable';
      deliveryFailure.hidden = true;
      deliveryFailure.textContent = '';
      setTime(checked, new Date().toISOString(), 'Unavailable');
      clearBuild();
      showDiagnostics([{
        component: 'health',
        code: 'request_unavailable',
        message: detail,
      }]);
    }

    function validHealth(payload) {
      const data = payload && payload.success === true ? payload.data : null;
      const xmtp = data && data.xmtp;
      const healthWorker = data && data.worker;
      const healthDelivery = data && data.delivery;
      const healthQueue = healthDelivery && healthDelivery.queue;
      const deadLetterQueue = healthDelivery && healthDelivery.deadLetterQueue;
      if (
        !data ||
        !['healthy', 'degraded', 'unavailable'].includes(data.status) ||
        data.runtime !== 'cloudflare-worker' ||
        parseDate(data.timestamp) === null ||
        !healthWorker ||
        typeof healthWorker.online !== 'boolean' ||
        !optionalString(healthWorker.versionId) ||
        !optionalString(healthWorker.versionTag) ||
        !optionalDate(healthWorker.deployedAt) ||
        !xmtp ||
        typeof xmtp.deliveryReady !== 'boolean' ||
        !xmtp.listener ||
        typeof xmtp.listener.configured !== 'boolean' ||
        typeof xmtp.listener.online !== 'boolean' ||
        !['ready', 'not_ready', 'not_configured', 'unknown'].includes(xmtp.listener.status) ||
        !optionalString(xmtp.listener.issue) ||
        !optionalDate(xmtp.listener.lastCheckedAt) ||
        !optionalDate(xmtp.listener.streamConnectedAt) ||
        !optionalDate(xmtp.listener.lastEnvelopeAt) ||
        !optionalDate(xmtp.listener.lastDeliveryProbeAt) ||
        !xmtp.network ||
        !optionalDate(xmtp.network.lastEnvelopeAt) ||
        !xmtp.bridge ||
        !['synced', 'pending', 'failed', 'not_configured'].includes(xmtp.bridge.status) ||
        !nonNegativeInteger(xmtp.bridge.pendingRegistrationCount) ||
        !nonNegativeInteger(xmtp.bridge.failedRegistrationCount) ||
        !optionalDate(xmtp.bridge.lastSuccessfulSyncAt) ||
        !healthDelivery ||
        !['ready', 'degraded', 'unknown'].includes(healthDelivery.status) ||
        !optionalDate(healthDelivery.lastWebPushAcceptedAt) ||
        !optionalDate(healthDelivery.lastCallbackAcceptedAt) ||
        !optionalDate(healthDelivery.lastFailureAt) ||
        !optionalString(healthDelivery.lastFailureCategory) ||
        !healthQueue ||
        !['ready', 'degraded', 'unknown'].includes(healthQueue.status) ||
        !optionalNonNegativeInteger(healthQueue.backlogCount) ||
        !optionalNonNegativeInteger(healthQueue.backlogBytes) ||
        !optionalDate(healthQueue.oldestMessageAt) ||
        !deadLetterQueue ||
        !['ready', 'degraded', 'unknown'].includes(deadLetterQueue.status) ||
        !optionalNonNegativeInteger(deadLetterQueue.backlogCount) ||
        !optionalNonNegativeInteger(deadLetterQueue.backlogBytes) ||
        !optionalDate(deadLetterQueue.oldestMessageAt) ||
        !Array.isArray(healthDelivery.issues) ||
        !healthDelivery.issues.every((issue) => typeof issue === 'string' && issue.trim()) ||
        !Array.isArray(data.diagnostics) ||
        !data.diagnostics.every((entry) => (
          entry &&
          typeof entry.component === 'string' &&
          entry.component.trim() &&
          typeof entry.code === 'string' &&
          entry.code.trim() &&
          typeof entry.message === 'string' &&
          entry.message.trim()
        ))
      ) {
        return null;
      }
      return {
        status: data.status,
        timestamp: data.timestamp,
        worker: healthWorker,
        xmtp,
        delivery: healthDelivery,
        diagnostics: data.diagnostics,
      };
    }

    function routeCount(count, state) {
      return `${formatCount(count)} ${state} ${count === 1 ? 'route' : 'routes'}`;
    }

    function renderDiagnostic(health) {
      if (health.status === 'healthy') {
        hideDiagnostic();
        return;
      }

      if (health.diagnostics.length > 0) {
        showDiagnostics(health.diagnostics);
        return;
      }
      if (health.xmtp.listener.issue) {
        showDiagnostics([{
          component: 'xmtp_monitor',
          code: health.xmtp.listener.issue,
          message: 'The XMTP monitor reported an issue.',
        }]);
        return;
      }
      if (
        health.delivery.status === 'degraded' &&
        health.delivery.lastFailureCategory
      ) {
        showDiagnostics([{
          component: 'delivery',
          code: health.delivery.lastFailureCategory,
          message: 'Outbound delivery is degraded.',
        }]);
        return;
      }
      showDiagnostics([{
        component: 'health',
        code: 'diagnostic_missing',
        message: 'The health report is not operational, but no public diagnostic was supplied.',
      }]);
    }

    function renderHealth(health) {
      rail.dataset.state = health.status === 'healthy' ? 'ready' : health.status;
      rail.setAttribute('aria-busy', 'false');
      const overallMessage = health.status === 'healthy'
        ? 'Service operational'
        : health.status === 'degraded'
          ? 'Service degraded'
          : 'Service status unavailable';
      if (overall.textContent !== overallMessage) overall.textContent = overallMessage;

      worker.textContent = health.worker.online ? 'Online' : 'Offline';

      if (!health.xmtp.listener.configured) {
        listener.textContent = 'Not configured';
      } else {
        listener.textContent = health.xmtp.listener.online ? 'Online' : 'Offline';
      }
      listenerDetail.textContent = words[health.xmtp.listener.status] || 'Unknown';

      setTime(
        network,
        health.xmtp.network.lastEnvelopeAt,
        'No activity observed'
      );

      bridge.textContent = words[health.xmtp.bridge.status] || 'Unknown';
      bridgeDetail.textContent = [
        routeCount(health.xmtp.bridge.pendingRegistrationCount, 'pending'),
        routeCount(health.xmtp.bridge.failedRegistrationCount, 'failed'),
      ].join(' · ');

      setTime(
        push,
        health.delivery.lastWebPushAcceptedAt,
        'No activity observed'
      );
      const queueLabel = words[health.delivery.queue.status] || 'Unknown';
      const deadLetterLabel = words[health.delivery.deadLetterQueue.status] || 'Unknown';
      const queueBacklog = health.delivery.queue.backlogCount;
      const deadLetterBacklog = health.delivery.deadLetterQueue.backlogCount;
      deliveryDetail.textContent = [
        `Source Queue ${queueLabel.toLowerCase()}${
          queueBacklog === undefined ? '' : ` (${formatCount(queueBacklog)} queued)`
        }`,
        `Dead-letter Queue ${deadLetterLabel.toLowerCase()}${
          deadLetterBacklog === undefined ? '' : ` (${formatCount(deadLetterBacklog)} queued)`
        }`,
      ].join(' · ');
      if (health.delivery.lastFailureAt && health.delivery.lastFailureCategory) {
        const failureDate = parseDate(health.delivery.lastFailureAt);
        deliveryFailure.textContent = `Latest recipient failure: ${
          health.delivery.lastFailureCategory.replaceAll('_', ' ')
        }, ${formatRelativeDate(failureDate)} (not by itself a relay outage)`;
        deliveryFailure.title = formatAbsoluteDate(failureDate);
        deliveryFailure.hidden = false;
      } else {
        deliveryFailure.hidden = true;
        deliveryFailure.textContent = '';
        deliveryFailure.removeAttribute('title');
      }
      setTime(checked, health.timestamp, 'Unavailable');
      renderBuild(health.worker);
      renderDiagnostic(health);
    }

    async function loadHealth() {
      const requestId = ++latestRequest;
      if (activeController) activeController.abort();
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      refreshButton.setAttribute('aria-busy', 'true');
      refreshButton.disabled = true;
      rail.setAttribute('aria-busy', 'true');

      try {
        const response = await fetch('/api/health', {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error('Health response malformed');
        }
        const health = validHealth(payload);
        if (!health) throw new Error('Health response malformed');
        if (!response.ok && response.status !== 503) {
          throw new Error('Health endpoint unavailable');
        }
        renderHealth(health);
      } catch (error) {
        if (requestId !== latestRequest) return;
        if (error && error.name === 'AbortError') {
          showUnavailable(
            'Service status timed out',
            'The public health request timed out before a report arrived.'
          );
        } else if (error instanceof Error && error.message === 'Health response malformed') {
          showUnavailable(
            'Service status unavailable',
            'The public health endpoint returned an invalid report.'
          );
        } else {
          showUnavailable(
            'Service status unavailable',
            'The public health endpoint could not be reached.'
          );
        }
      } finally {
        window.clearTimeout(timeout);
        if (requestId === latestRequest) {
          refreshButton.removeAttribute('aria-busy');
          refreshButton.disabled = false;
          activeController = null;
          rail.setAttribute('aria-busy', 'false');
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
