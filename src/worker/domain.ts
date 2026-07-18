const DNS_JSON_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
export const APP_DOMAIN_VERIFICATION_FRESHNESS_MS = 7 * 24 * 60 * 60_000;

export class DnsLookupError extends Error {
  constructor(message = 'DNS verification is temporarily unavailable') {
    super(message);
    this.name = 'DnsLookupError';
  }
}

export function normalizeAppDomain(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, '');
  if (
    !trimmed
    || trimmed.length > 253
    || /[\s\/:@*?#%\[\]]/.test(trimmed)
    || !trimmed.includes('.')
  ) return null;

  let hostname: string;
  try {
    const parsed = new URL(`https://${trimmed}/`);
    hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return null;

  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => (
    label.length < 1
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) return null;
  return hostname;
}

export function normalizeVerifiedCallbackUrl(input: string, verifiedDomain: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:'
    || (url.port && url.port !== '443')
    || url.username
    || url.password
    || url.hash
    || url.hostname.toLowerCase() !== verifiedDomain.toLowerCase()
  ) return null;
  return url.toString();
}

export function appDomainRecord(
  domain: string,
  appId: string,
  publicVapidKey: string
): { type: 'TXT'; name: string; value: string } {
  return {
    type: 'TXT',
    name: `_vapid-party.${domain}`,
    value: `v=vapid-party1;app=${appId};vapid=${publicVapidKey}`,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DNS_RESPONSE_BYTES) {
    throw new DnsLookupError();
  }
  if (!response.body) throw new DnsLookupError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DNS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DnsLookupError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof DnsLookupError) throw error;
    throw new DnsLookupError();
  } finally {
    reader.releaseLock();
  }
}

function decodeTxtData(input: string): string | null {
  const pieces: string[] = [];
  const matches = input.matchAll(/"((?:\\.|[^"\\])*)"/g);
  for (const match of matches) {
    try {
      pieces.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      return null;
    }
  }
  if (pieces.length > 0) return pieces.join('');
  return input.length <= 1024 ? input : null;
}

export async function verifyAppDomainRecord(
  domain: string,
  appId: string,
  publicVapidKey: string
): Promise<'verified' | 'mismatch'> {
  const record = appDomainRecord(domain, appId, publicVapidKey);
  const url = new URL(DNS_JSON_ENDPOINT);
  url.searchParams.set('name', record.name);
  url.searchParams.set('type', 'TXT');

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new DnsLookupError();
  }
  if (!response.ok) throw new DnsLookupError();

  const payload = await readBoundedJson(response);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DnsLookupError();
  }
  const data = payload as { Status?: unknown; Answer?: unknown };
  if (typeof data.Status !== 'number') throw new DnsLookupError();
  if (data.Status !== 0 || !Array.isArray(data.Answer)) return 'mismatch';

  for (const answer of data.Answer) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
    const candidate = answer as { name?: unknown; type?: unknown; data?: unknown };
    const answerName = typeof candidate.name === 'string'
      ? candidate.name.toLowerCase().replace(/\.$/, '')
      : '';
    if (
      answerName !== record.name
      || candidate.type !== 16
      || typeof candidate.data !== 'string'
    ) continue;
    if (decodeTxtData(candidate.data) === record.value) return 'verified';
  }
  return 'mismatch';
}
