import { describe, expect, it } from 'vitest';
import {
  hasInternalIngestAuth,
  isGenericApiKeyAllowed,
  isPublicConvergeRoute,
} from '../../src/worker/auth';

describe('Converge route auth contract', () => {
  it('does not require a client API key for public XMTP routes', () => {
    expect(isPublicConvergeRoute('GET', '/api/xmtp/vapid-public-key')).toBe(true);
    expect(isPublicConvergeRoute('POST', '/api/xmtp/subscriptions')).toBe(true);
    expect(isPublicConvergeRoute('DELETE', '/api/xmtp/subscriptions')).toBe(true);
  });

  it('keeps generic push routes outside the public Converge contract', () => {
    expect(isPublicConvergeRoute('POST', '/api/subscribe')).toBe(false);
    expect(isPublicConvergeRoute('POST', '/api/send')).toBe(false);
    expect(isPublicConvergeRoute('GET', '/api/vapid/public-key')).toBe(false);
  });

  it('fails generic Converge API-key access closed without a secret binding', () => {
    expect(isGenericApiKeyAllowed('converge', 'source-visible-key', {})).toBe(false);
    expect(isGenericApiKeyAllowed('converge', 'rotated-secret', {
      CONVERGE_API_KEY: 'rotated-secret',
    })).toBe(true);
    expect(isGenericApiKeyAllowed('converge', 'wrong', {
      CONVERGE_API_KEY: 'rotated-secret',
    })).toBe(false);
  });

  it('does not change generic API-key behavior for independently managed apps', () => {
    expect(isGenericApiKeyAllowed('another-app', 'app-owned-key', {})).toBe(true);
  });

  it('accepts official Bearer delivery auth and the legacy internal-token header', () => {
    const env = { INTERNAL_INGEST_TOKEN: 'delivery-secret' };
    expect(hasInternalIngestAuth(new Request('https://vapid.party', {
      headers: { Authorization: 'Bearer delivery-secret' },
    }), env)).toBe(true);
    expect(hasInternalIngestAuth(new Request('https://vapid.party', {
      headers: { 'X-Internal-Token': 'delivery-secret' },
    }), env)).toBe(true);
    expect(hasInternalIngestAuth(new Request('https://vapid.party', {
      headers: { Authorization: 'Bearer wrong' },
    }), env)).toBe(false);
    expect(hasInternalIngestAuth(new Request('https://vapid.party'), {})).toBe(false);
  });
});
