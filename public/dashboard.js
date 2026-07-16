(() => {
  const STORAGE_KEY = 'vapid-party.dashboard-capability.v1';
  const REQUEST_TIMEOUT_MS = 8000;

  function validCapability(input) {
    return Boolean(
      input &&
      typeof input.appId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.appId) &&
      typeof input.appSecret === 'string' &&
      /^vp_(?:[0-9a-f]{48}|[0-9a-f]{64})$/.test(input.appSecret)
    );
  }

  function readHandoff() {
    if (!window.location.hash) return null;
    try {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const capability = {
        appId: params.get('app') || '',
        appSecret: params.get('secret') || '',
      };
      return validCapability(capability) ? capability : null;
    } catch {
      return null;
    }
  }

  function readStoredCapability() {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null');
      return validCapability(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function storeCapability(capability) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(capability));
    } catch {
      // The in-memory capability still supports this page when storage is unavailable.
    }
  }

  function clearStoredCapability() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // There is no recoverable state if session storage is unavailable.
    }
  }

  const handoff = readHandoff();
  if (window.location.hash || window.location.search) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  if (handoff) storeCapability(handoff);
  let capability = handoff || readStoredCapability();

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  function formatDate(input) {
    if (typeof input !== 'string') return null;
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function countText(input) {
    return Number.isFinite(input) && input >= 0
      ? new Intl.NumberFormat().format(input)
      : '—';
  }

  function apiMessage(error, fallback) {
    if (error && error.name === 'AbortError') return 'The request timed out. Try again.';
    if (error instanceof ApiError) return error.message;
    return fallback;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const access = document.querySelector('[data-access]');
    const accessForm = document.querySelector('[data-access-form]');
    const accessStatus = document.querySelector('[data-access-status]');
    const loading = document.querySelector('[data-dashboard-loading]');
    const loadingMessage = document.querySelector('[data-loading-message]');
    const retryButton = document.querySelector('[data-retry-dashboard]');
    const dashboard = document.querySelector('[data-dashboard]');
    const deleted = document.querySelector('[data-deleted]');
    const forget = document.querySelector('[data-forget]');
    const alert = document.querySelector('[data-dashboard-alert]');
    let latestStats = null;
    let latestDomain = null;
    let loadSequence = 0;

    function persistCapability(next) {
      capability = next;
      storeCapability(next);
    }

    function forgetCapability() {
      capability = null;
      clearStoredCapability();
    }

    function showAccess(message = '') {
      access.hidden = false;
      loading.hidden = true;
      dashboard.hidden = true;
      deleted.hidden = true;
      forget.hidden = true;
      accessStatus.textContent = message;
      accessStatus.dataset.state = message ? 'error' : '';
      const idInput = accessForm.elements.appId;
      const secretInput = accessForm.elements.appSecret;
      idInput.value = capability ? capability.appId : '';
      secretInput.value = '';
      (idInput.value ? secretInput : idInput).focus();
    }

    function showLoading() {
      access.hidden = true;
      dashboard.hidden = true;
      deleted.hidden = true;
      loading.hidden = false;
      loadingMessage.textContent = 'Loading app usage…';
      retryButton.hidden = true;
      forget.hidden = !capability;
    }

    function showLoadingError(message) {
      loading.hidden = false;
      loadingMessage.textContent = message;
      retryButton.hidden = false;
      forget.hidden = false;
    }

    async function request(path, options = {}) {
      if (!capability) throw new ApiError('App capability is missing.', 401, 'UNAUTHORIZED');
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          credentials: 'omit',
          ...options,
          headers: {
            Accept: 'application/json',
            'X-API-Key': capability.appSecret,
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
          throw new ApiError(
            payload && typeof payload.error === 'string'
              ? payload.error
              : 'The request could not be completed.',
            response.status,
            payload && typeof payload.code === 'string' ? payload.code : undefined
          );
        }
        return payload.data;
      } finally {
        window.clearTimeout(timeout);
      }
    }

    function validStats(stats) {
      return Boolean(
        stats &&
        typeof stats.generatedAt === 'string' &&
        stats.app &&
        typeof stats.app.id === 'string' &&
        typeof stats.app.name === 'string' &&
        typeof stats.app.publicVapidKey === 'string' &&
        stats.profile &&
        stats.subscriptions &&
        stats.xmtp &&
        stats.usage &&
        stats.usage.todayUtc &&
        stats.usage.last7DaysUtc
      );
    }

    function validDomain(domain) {
      return Boolean(
        domain &&
        (domain.domain === undefined || domain.domain === null || typeof domain.domain === 'string') &&
        typeof domain.status === 'string'
      );
    }

    function setCount(selector, value) {
      document.querySelector(selector).textContent = countText(value);
    }

    function renderDomain(domain, profile) {
      const domainInput = document.querySelector('[data-domain-form] [name="domain"]');
      const remove = document.querySelector('[data-remove-domain]');
      const recordPanel = document.querySelector('[data-dns-record]');
      const state = document.querySelector('[data-dns-state]');
      const badge = document.querySelector('[data-domain-badge]');
      const nameInput = document.querySelector('[data-dns-name]');
      const valueInput = document.querySelector('[data-dns-value]');
      const listing = document.querySelector('[data-listing-checkbox]');
      const listingStatus = document.querySelector('[data-listing-status]');
      const hasDomain = typeof domain.domain === 'string' && domain.domain.length > 0;
      const verified = domain.status === 'verified';
      const verifiedAtMs = typeof domain.verifiedAt === 'string'
        ? Date.parse(domain.verifiedAt)
        : Number.NaN;
      const recentlyVerified = verified && Number.isFinite(verifiedAtMs) &&
        Date.now() - verifiedAtMs <= 7 * 24 * 60 * 60 * 1000;

      domainInput.value = hasDomain ? domain.domain : '';
      remove.hidden = !hasDomain;
      recordPanel.hidden = !hasDomain || !domain.record;
      nameInput.value = domain.record && typeof domain.record.name === 'string'
        ? domain.record.name
        : '';
      valueInput.value = domain.record && typeof domain.record.value === 'string'
        ? domain.record.value
        : '';

      const checkedAt = formatDate(domain.checkedAt);
      const verifiedAt = formatDate(domain.verifiedAt);
      if (verified) {
        state.textContent = verifiedAt
          ? `DNS last verified ${verifiedAt}. Recheck at least every seven days for leaderboard eligibility.`
          : 'DNS matched previously, but its last-verified time is unavailable.';
        state.dataset.state = 'verified';
        badge.textContent = `DNS last verified · ${domain.domain}`;
        badge.dataset.state = 'verified';
      } else if (domain.status === 'mismatch') {
        state.textContent = checkedAt
          ? `The TXT record did not match when checked ${checkedAt}.`
          : 'The TXT record does not match yet.';
        state.dataset.state = 'mismatch';
        badge.textContent = 'Domain not last-verified';
        badge.dataset.state = 'unverified';
      } else {
        state.textContent = 'Publish the exact TXT record below, then check DNS.';
        state.dataset.state = 'unverified';
        badge.textContent = 'Domain not last-verified';
        badge.dataset.state = 'unverified';
      }

      listing.checked = profile.leaderboardOptIn === true;
      listing.disabled = !recentlyVerified && !listing.checked;
      if (!recentlyVerified && !listing.checked) {
        listingStatus.textContent = verified
          ? 'Recheck DNS; the last verification must be within seven days before opting in.'
          : 'Check the DNS binding before opting in.';
        listingStatus.dataset.state = '';
      } else if (!recentlyVerified && listing.checked) {
        listingStatus.textContent = 'Recheck the DNS binding or opt out; this app is not currently eligible.';
        listingStatus.dataset.state = 'error';
      } else {
        listingStatus.textContent = profile.leaderboardOptIn
          ? 'This app is listed while its last DNS verification remains within seven days.'
          : 'This app is eligible but not listed.';
        listingStatus.dataset.state = '';
      }
    }

    function render(stats, domain) {
      latestStats = stats;
      latestDomain = domain;
      document.querySelector('[data-app-name]').textContent = stats.app.name;
      document.querySelector('[data-app-id]').textContent = stats.app.id;
      document.querySelector('[data-public-app-id]').value = stats.app.id;
      document.querySelector('[data-public-vapid-key]').value = stats.app.publicVapidKey;
      document.querySelector('[data-profile-form] [name="name"]').value = stats.app.name;
      document.querySelector('[data-profile-form] [name="description"]').value =
        typeof stats.profile.description === 'string' ? stats.profile.description : '';

      const generatedAt = formatDate(stats.generatedAt);
      document.querySelector('[data-generated-at]').textContent = generatedAt
        ? `Usage generated ${generatedAt}`
        : 'Usage generation time unavailable';

      setCount('[data-stat-subscriptions]', stats.subscriptions.active);
      setCount('[data-stat-accepted-today]', stats.usage.todayUtc.providerAccepted);
      setCount('[data-stat-accepted-week]', stats.usage.last7DaysUtc.providerAccepted);
      setCount('[data-stat-queued]', stats.usage.last7DaysUtc.queued);
      setCount('[data-stat-failed]', stats.usage.last7DaysUtc.failed);
      setCount('[data-stat-expired]', stats.usage.last7DaysUtc.expired);

      const retention = Number.isInteger(stats.retentionDays) && stats.retentionDays > 0
        ? `${stats.retentionDays} UTC dates`
        : 'a short operational window';
      document.querySelector('[data-retention-note]').textContent =
        `Usage aggregates are retained for ${retention}. Provider acceptance does not prove browser display.`;

      document.querySelector('[data-delete-form] [name="confirmation"]').value = '';
      document.querySelector('[data-delete-button]').disabled = true;
      renderDomain(domain, stats.profile);
      access.hidden = true;
      loading.hidden = true;
      deleted.hidden = true;
      dashboard.hidden = false;
      forget.hidden = false;
    }

    async function loadDashboard(showSpinner = true) {
      if (!capability) {
        showAccess();
        return false;
      }
      const sequence = ++loadSequence;
      if (showSpinner) showLoading();
      try {
        const base = `/api/apps/${encodeURIComponent(capability.appId)}`;
        const [stats, domain] = await Promise.all([
          request(`${base}/stats`),
          request(`${base}/domain`),
        ]);
        if (sequence !== loadSequence) return false;
        if (!validStats(stats) || !validDomain(domain) || stats.app.id !== capability.appId) {
          throw new Error('Dashboard response malformed');
        }
        render(stats, domain);
        return true;
      } catch (error) {
        if (sequence !== loadSequence) return false;
        if (error instanceof ApiError && error.status === 401) {
          forgetCapability();
          showAccess('App ID or app secret is invalid.');
        } else if (showSpinner) {
          showLoadingError(apiMessage(error, 'The dashboard could not be loaded. Try again.'));
        } else {
          alert.textContent = apiMessage(error, 'The dashboard could not be refreshed.');
          alert.dataset.state = 'error';
        }
        return false;
      }
    }

    async function patchProfile(fields) {
      return request(`/api/apps/${encodeURIComponent(capability.appId)}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
    }

    function busy(button, active, label) {
      if (active) {
        button.dataset.idleLabel = button.textContent;
        button.textContent = label;
      } else if (button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
      }
      button.disabled = active;
    }

    async function copyInput(input, status) {
      try {
        await navigator.clipboard.writeText(input.value);
        status.textContent = 'Copied.';
      } catch {
        input.focus();
        input.select();
        status.textContent = 'Select the value and copy it manually.';
      }
    }

    accessForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const candidate = {
        appId: accessForm.elements.appId.value.trim(),
        appSecret: accessForm.elements.appSecret.value.trim(),
      };
      if (!validCapability(candidate)) {
        accessStatus.textContent = 'Enter a valid app ID and app secret.';
        accessStatus.dataset.state = 'error';
        return;
      }
      persistCapability(candidate);
      accessForm.elements.appSecret.value = '';
      await loadDashboard();
    });

    retryButton.addEventListener('click', () => loadDashboard());
    forget.addEventListener('click', () => {
      forgetCapability();
      window.location.replace(window.location.pathname);
    });

    document.querySelector('[data-profile-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const status = document.querySelector('[data-profile-status]');
      const name = form.elements.name.value.trim();
      if (!name) {
        status.textContent = 'Enter an app name.';
        status.dataset.state = 'error';
        form.elements.name.focus();
        return;
      }
      busy(button, true, 'Saving…');
      status.textContent = '';
      try {
        await patchProfile({
          name,
          description: form.elements.description.value.trim(),
        });
        await loadDashboard(false);
        status.textContent = 'Profile saved.';
        status.dataset.state = '';
      } catch (error) {
        status.textContent = apiMessage(error, 'The profile could not be saved.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-domain-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const status = document.querySelector('[data-domain-status]');
      const domain = form.elements.domain.value.trim();
      if (!domain) {
        status.textContent = 'Enter a domain hostname.';
        status.dataset.state = 'error';
        form.elements.domain.focus();
        return;
      }
      busy(button, true, 'Saving…');
      status.textContent = '';
      try {
        const domainChanged = !latestDomain || latestDomain.domain !== domain;
        await patchProfile(domainChanged
          ? { domain, leaderboardOptIn: false }
          : { domain });
        await loadDashboard(false);
        status.textContent = 'Domain saved. Publish the TXT record, then check DNS to set its last-verified time.';
        status.dataset.state = '';
      } catch (error) {
        status.textContent = apiMessage(error, 'The domain could not be saved.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-remove-domain]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.querySelector('[data-domain-status]');
      if (!window.confirm('Remove this DNS binding and public leaderboard listing?')) return;
      busy(button, true, 'Removing…');
      try {
        await patchProfile({ domain: null, leaderboardOptIn: false });
        await loadDashboard(false);
        status.textContent = 'Domain and public listing removed.';
        status.dataset.state = '';
      } catch (error) {
        status.textContent = apiMessage(error, 'The domain could not be removed.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-verify-domain]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.querySelector('[data-domain-status]');
      busy(button, true, 'Checking DNS…');
      status.textContent = '';
      try {
        const domain = await request(
          `/api/apps/${encodeURIComponent(capability.appId)}/domain/verify`,
          { method: 'POST' }
        );
        if (!validDomain(domain)) throw new Error('Domain response malformed');
        await loadDashboard(false);
        status.textContent = domain.status === 'verified'
          ? 'DNS binding found; the last-verified timestamp was updated.'
          : 'The exact TXT record was not found yet. DNS changes can take time.';
        status.dataset.state = domain.status === 'verified' ? '' : 'error';
      } catch (error) {
        status.textContent = apiMessage(error, 'DNS could not be checked right now.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-listing-form]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const checkbox = document.querySelector('[data-listing-checkbox]');
      const status = document.querySelector('[data-listing-status]');
      busy(button, true, 'Saving…');
      try {
        await patchProfile({ leaderboardOptIn: checkbox.checked });
        await loadDashboard(false);
        status.textContent = checkbox.checked
          ? 'This app is now listed while its last successful DNS check is no more than seven days old.'
          : 'This app is no longer listed publicly.';
        status.dataset.state = '';
      } catch (error) {
        status.textContent = apiMessage(error, 'The listing choice could not be saved.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-rotate-secret]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.querySelector('[data-rotate-status]');
      if (!window.confirm('Rotate the app secret? The current secret will stop working immediately.')) {
        return;
      }
      busy(button, true, 'Rotating…');
      status.textContent = '';
      try {
        const data = await request(
          `/api/apps/${encodeURIComponent(capability.appId)}/secret/rotate`,
          { method: 'POST' }
        );
        if (!data || data.appId !== capability.appId || typeof data.appSecret !== 'string') {
          throw new Error('The replacement credential response was malformed.');
        }
        const next = { appId: capability.appId, appSecret: data.appSecret };
        if (!validCapability(next)) throw new Error('The replacement credential was malformed.');
        persistCapability(next);
        const secret = document.querySelector('[data-new-app-secret]');
        secret.value = data.appSecret;
        secret.type = 'password';
        document.querySelector('[data-toggle-new-secret]').textContent = 'Show';
        document.querySelector('[data-rotated-secret]').hidden = false;
        status.textContent = 'Secret rotated. Save the replacement now; it cannot be recovered.';
        status.dataset.state = '';
      } catch (error) {
        status.textContent = apiMessage(error, 'The secret could not be rotated.');
        status.dataset.state = 'error';
      } finally {
        busy(button, false, '');
      }
    });

    document.querySelector('[data-toggle-new-secret]').addEventListener('click', (event) => {
      const input = document.querySelector('[data-new-app-secret]');
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      event.currentTarget.textContent = revealing ? 'Hide' : 'Show';
    });

    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => {
        const targets = {
          'app-id': [document.querySelector('[data-public-app-id]'), document.querySelector('[data-public-copy-status]')],
          'vapid-key': [document.querySelector('[data-public-vapid-key]'), document.querySelector('[data-public-copy-status]')],
          'dns-name': [document.querySelector('[data-dns-name]'), document.querySelector('[data-dns-copy-status]')],
          'dns-value': [document.querySelector('[data-dns-value]'), document.querySelector('[data-dns-copy-status]')],
          'new-secret': [document.querySelector('[data-new-app-secret]'), document.querySelector('[data-rotate-status]')],
        };
        const target = targets[button.dataset.copy];
        if (target && target[0].value) copyInput(target[0], target[1]);
      });
    });

    const deleteForm = document.querySelector('[data-delete-form]');
    const deleteInput = deleteForm.elements.confirmation;
    const deleteButton = document.querySelector('[data-delete-button]');
    deleteInput.addEventListener('input', () => {
      deleteButton.disabled = !capability || deleteInput.value !== capability.appId;
    });
    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.querySelector('[data-delete-status]');
      if (!capability || deleteInput.value !== capability.appId) return;
      if (!window.confirm('Permanently delete this app and its subscriptions?')) return;
      busy(deleteButton, true, 'Deleting…');
      try {
        const data = await request(`/api/apps/${encodeURIComponent(capability.appId)}`, {
          method: 'DELETE',
        });
        if (!data || data.deleted !== true) throw new Error('The app was not deleted.');
        forgetCapability();
        access.hidden = true;
        loading.hidden = true;
        dashboard.hidden = true;
        forget.hidden = true;
        deleted.hidden = false;
        deleted.focus();
      } catch (error) {
        status.textContent = apiMessage(error, 'The app could not be deleted.');
        status.dataset.state = 'error';
        busy(deleteButton, false, '');
      }
    });

    if (capability) loadDashboard();
    else showAccess();
  });
})();
