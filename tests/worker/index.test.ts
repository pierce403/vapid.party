import { describe, expect, it } from 'vitest';
import { withStaticSecurityHeaders } from '../../src/worker/security-headers';

describe('static asset security headers', () => {
  it('locks landing assets to same-origin code and prevents embedding', async () => {
    const response = withStaticSecurityHeaders(new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    expect(await response.text()).toBe('<!doctype html>');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(response.headers.get('Permissions-Policy')).toContain('payment=()');
  });
});
