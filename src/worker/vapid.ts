import { bytesToBase64Url, bytesToHex, base64UrlToBytes } from './encoding';

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `vp_${bytesToHex(bytes)}`;
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;

  const publicRawBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer;
  const publicRaw = new Uint8Array(publicRawBuffer);
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;

  if (!privateJwk.d) {
    throw new Error('Generated VAPID private key is missing JWK d parameter');
  }

  return {
    publicKey: bytesToBase64Url(publicRaw),
    privateKey: privateJwk.d,
  };
}

export function getVapidPublicJwk(publicKey: string): JsonWebKey {
  const raw = base64UrlToBytes(publicKey);
  if (!raw || raw.length !== 65 || raw[0] !== 4) {
    throw new Error('Invalid VAPID public key');
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(raw.slice(1, 33)),
    y: bytesToBase64Url(raw.slice(33, 65)),
    ext: true,
  };
}
