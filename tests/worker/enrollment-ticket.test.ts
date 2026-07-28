import { describe, expect, it } from 'vitest';
import { bytesToBase64Url } from '../../src/worker/encoding';
import { xmtpInstallationProofMatches } from '../../src/worker/enrollment-ticket';
import type { PublicXmtpRegistrationInput } from '../../src/worker/schemas';

const publicKeyHex =
  'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const signatureHex =
  '91f1a7d9e948ebc787dbfa342aada262ed3b661dfbed6dfcf3f02681322e682f' +
  '3e25947be9a911c90f830e90eaf03ffa251cb8eb6fb9e0a2e8426c89d7c3160c';

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  );
}

function registration(): PublicXmtpRegistrationInput {
  return {
    version: 1,
    identity: {
      inboxId: '11'.repeat(32),
      installationId: publicKeyHex,
    },
    delivery: {
      kind: 'https_callback',
      url: 'https://notify.example.com/api/xmtp',
    },
    xmtp: {
      env: 'production',
      topics: [{
        topic: `/xmtp/mls/1/g-${'33'.repeat(16)}/proto`,
        hmacKeys: [{ epoch: '7', key: 'AQID' }],
      }],
      topicSource: 'conversations.hmacKeys',
    },
    notification: { inboxHandle: 'opaque_public_xmtp' },
    preferences: { minimalPayloadOnly: true, plaintextPreview: false },
    registeredAt: '2026-07-27T12:00:00.000Z',
  };
}

describe('XMTP installation proof verification', () => {
  it('accepts a fixed signature cross-verified by official libxmtp', async () => {
    await expect(xmtpInstallationProofMatches(
      'vpxet1.test-ticket.signature',
      registration(),
      {
        publicKey: bytesToBase64Url(hexToBytes(publicKeyHex)),
        signature: bytesToBase64Url(hexToBytes(signatureHex)),
      }
    )).resolves.toBe(true);
  });

  it('fails closed for malformed public keys', async () => {
    await expect(xmtpInstallationProofMatches(
      'vpxet1.test-ticket.signature',
      registration(),
      {
        publicKey: bytesToBase64Url(new Uint8Array(32).fill(255)),
        signature: bytesToBase64Url(hexToBytes(signatureHex)),
      }
    )).resolves.toBe(false);
  });
});
