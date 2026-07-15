import { describe, expect, it, vi } from 'vitest';
import { XmtpListenerContainer } from '../../src/worker/xmtp-listener-container';

vi.mock('@cloudflare/containers', () => ({
  Container: class MockContainer {},
}));

describe('XMTP listener container lifecycle', () => {
  it('renews activity instead of stopping when the inactivity window expires', async () => {
    const renewActivityTimeout = vi.fn();
    const stop = vi.fn();
    const listener = Object.create(
      XmtpListenerContainer.prototype,
    ) as XmtpListenerContainer;

    Object.defineProperties(listener, {
      renewActivityTimeout: { value: renewActivityTimeout },
      stop: { value: stop },
    });

    await listener.onActivityExpired();

    expect(renewActivityTimeout).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
});
