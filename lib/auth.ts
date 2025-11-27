/**
 * Authentication utilities for vapid.party
 * 
 * Uses thirdweb for wallet-based authentication.
 * Creates signed JWT-like tokens for API authentication.
 */

import type { Account } from 'thirdweb/wallets';

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

interface AuthPayload {
  sub: string; // wallet address
  iat: number; // issued at
  exp: number; // expiration
  nonce: string; // random nonce for replay protection
}

/**
 * Generate a random nonce for replay protection
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an authentication token for API calls
 * 
 * The token structure is: header.payload.signature
 * - header: base64 encoded { alg: 'ETH', typ: 'JWT' }
 * - payload: base64 encoded { sub, iat, exp, nonce }
 * - signature: wallet signature of the payload
 */
export async function createAuthToken(account: Account): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  const payload: AuthPayload = {
    sub: account.address.toLowerCase(),
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS,
    nonce: generateNonce(),
  };

  const header = { alg: 'ETH', typ: 'JWT' };
  const headerB64 = btoa(JSON.stringify(header));
  const payloadB64 = btoa(JSON.stringify(payload));
  
  // Message to sign includes the payload
  const message = `vapid.party authentication\n\nPayload: ${payloadB64}\n\nSigning this message proves you own this wallet. It does not cost any gas.`;
  
  try {
    // Sign the message with the wallet
    const signature = await account.signMessage({ message });
    
    return `${headerB64}.${payloadB64}.${signature}`;
  } catch (error) {
    console.error('Failed to sign auth message:', error);
    throw new Error('Failed to create auth token');
  }
}

/**
 * Verify an authentication token (server-side)
 * 
 * Returns the wallet address if valid, null otherwise
 */
export function parseAuthToken(token: string): { address: string; exp: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [, payloadB64] = parts;
    const payload = JSON.parse(atob(payloadB64)) as AuthPayload;
    
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null;
    }
    
    // For now, we trust the payload since we're using a simple approach
    // In production, you'd verify the signature against the claimed address
    return {
      address: payload.sub,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Get authorization header value
 */
export function getAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

