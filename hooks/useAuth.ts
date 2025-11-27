'use client';

import { useState, useCallback, useEffect } from 'react';
import { useActiveAccount } from 'thirdweb/react';
import { createAuthToken, getAuthHeader } from '@/lib/auth';

interface AuthState {
  token: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for wallet-based authentication
 * 
 * Manages auth token creation and refresh for API calls
 */
export function useAuth() {
  const account = useActiveAccount();
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    loading: false,
    error: null,
  });

  // Clear auth state when account changes
  useEffect(() => {
    setAuthState({ token: null, loading: false, error: null });
  }, [account?.address]);

  /**
   * Get a fresh auth token (requests wallet signature)
   */
  const getToken = useCallback(async (): Promise<string | null> => {
    if (!account) {
      setAuthState({ token: null, loading: false, error: 'No wallet connected' });
      return null;
    }

    setAuthState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const token = await createAuthToken(account);
      setAuthState({ token, loading: false, error: null });
      return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to authenticate';
      setAuthState({ token: null, loading: false, error: message });
      return null;
    }
  }, [account]);

  /**
   * Make an authenticated API request
   */
  const authFetch = useCallback(async (
    url: string,
    options: RequestInit = {}
  ): Promise<Response> => {
    // Use existing token or get a new one
    let token = authState.token;
    
    if (!token) {
      token = await getToken();
      if (!token) {
        throw new Error('Failed to get auth token');
      }
    }

    const headers = new Headers(options.headers);
    headers.set('Authorization', getAuthHeader(token));
    
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(url, {
      ...options,
      headers,
    });
  }, [authState.token, getToken]);

  /**
   * Create a simple mock token for development/demo
   * (Used when wallet signing is not available)
   */
  const getMockToken = useCallback((): string | null => {
    if (!account) return null;
    
    const payload = {
      sub: account.address.toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
    
    return `mock.${btoa(JSON.stringify(payload))}.demo`;
  }, [account]);

  return {
    account,
    token: authState.token,
    loading: authState.loading,
    error: authState.error,
    getToken,
    getMockToken,
    authFetch,
    isAuthenticated: !!account,
  };
}

