import { describe, expect, it } from 'vitest';
import { isPublicConvergeRoute } from '../../src/worker/auth';

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
});
