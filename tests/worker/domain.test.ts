import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appDomainRecord,
  DnsLookupError,
  normalizeAppDomain,
  verifyAppDomainRecord,
} from '../../src/worker/domain';

describe('public app DNS verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('canonicalizes hostnames without accepting URLs, ports, wildcards, or IP literals', () => {
    expect(normalizeAppDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeAppDomain('BÜCHER.example')).toBe('xn--bcher-kva.example');

    for (const value of [
      'https://example.com',
      'example.com/path',
      'example.com:443',
      '*.example.com',
      '127.0.0.1',
      '[::1]',
      'localhost',
      'example..com',
      '-bad.example',
    ]) expect(normalizeAppDomain(value), value).toBeNull();
  });

  it('queries only Cloudflare DoH and accepts a split quoted TXT value', async () => {
    const domain = 'app.example';
    const appId = 'app_123';
    const publicVapidKey = `B${'A'.repeat(86)}`;
    const record = appDomainRecord(domain, appId, publicVapidKey);
    const splitAt = Math.floor(record.value.length / 2);
    const first = record.value.slice(0, splitAt);
    const second = record.value.slice(splitAt);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      Status: 0,
      Answer: [{
        name: `${record.name}.`,
        type: 16,
        data: `${JSON.stringify(first)} ${JSON.stringify(second)}`,
      }],
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyAppDomainRecord(domain, appId, publicVapidKey))
      .resolves.toBe('verified');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(input.origin).toBe('https://cloudflare-dns.com');
    expect(input.pathname).toBe('/dns-query');
    expect(input.searchParams.get('name')).toBe(record.name);
    expect(input.searchParams.get('type')).toBe('TXT');
    expect(new Headers(init.headers).get('Accept')).toBe('application/dns-json');
  });

  it('reports missing records as a mismatch and bounds resolver failures', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ Status: 3 })));
    await expect(verifyAppDomainRecord('missing.example', 'app', 'public'))
      .resolves.toBe('mismatch');

    fetchMock.mockResolvedValueOnce(new Response('{}', {
      headers: { 'Content-Length': String(64 * 1024 + 1) },
    }));
    await expect(verifyAppDomainRecord('oversized.example', 'app', 'public'))
      .rejects.toBeInstanceOf(DnsLookupError);

    fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(verifyAppDomainRecord('offline.example', 'app', 'public'))
      .rejects.toBeInstanceOf(DnsLookupError);
  });
});
